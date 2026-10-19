#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { isIsoUtc, isRepository } from "./common.mjs";
import { OutOfScopeProducer, parseWorkflowReference } from "./github-lineage.mjs";

const execute = promisify(execFile);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = file => JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 32 * 1024 * 1024 }));
const write = (file, value) => {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, gzipSync(`${JSON.stringify(value)}\n`));
  renameSync(temporary, file);
};

function inventoryQuery(repository, connections) {
  const [owner, name] = repository.split("/");
  const fields = Object.entries(connections).filter(([, value]) => !value.complete).map(([kind, value]) =>
    `${kind}(first:100,after:${JSON.stringify(value.after)},orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes { id number url body state createdAt updatedAt closedAt author { __typename }
        ${kind === "issues" ? "stateReason" : "mergedAt"} }
      pageInfo { hasNextPage endCursor }
    }`).join("\n");
  return `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
    databaseId ${fields}
  } }`;
}

function restShape(value, kind) {
  return { number: value.number, node_id: value.id, html_url: value.url, body: value.body,
    created_at: value.createdAt, updated_at: value.updatedAt, closed_at: value.closedAt,
    state: value.state === "OPEN" ? "open" : ["CLOSED", "MERGED"].includes(value.state) ? "closed" : value.state,
    state_reason: value.stateReason ?? null, user: { type: value.author?.__typename },
    ...(kind === "pullRequests" ? { pull_request: { merged_at: value.mergedAt } } : {}) };
}

export function readOutputHistory(directory) {
  const index = read(path.join(directory, "history.json.gz"));
  if (index.schemaVersion !== 1 || index.kind !== "workflow-output-history"
    || !isRepository(index.repository) || !isIsoUtc(index.until)
    || !Array.isArray(index.partitions) || !Array.isArray(index.workflows)
    || !Number.isSafeInteger(index.totalEntities) || index.totalEntities < 0) {
    throw new Error("Invalid output-history archive");
  }
  const ids = new Set(), numbers = new Set();
  const entities = index.partitions.flatMap(part => {
    if (typeof part.file !== "string" || !/^entities-\d{5,}\.json\.gz$/.test(part.file)) {
      throw new Error("Unsafe history partition");
    }
    const rows = read(path.join(directory, part.file));
    if (!Array.isArray(rows) || rows.length !== part.count || digest(rows) !== part.sha256) {
      throw new Error("History partition integrity mismatch");
    }
    for (const row of rows) {
      if (row.repository !== index.repository || typeof row.id !== "string"
        || !Number.isSafeInteger(row.number) || row.number < 1
        || ids.has(row.id) || numbers.has(row.number)
        || !Number.isFinite(Date.parse(row.createdAt)) || Date.parse(row.createdAt) >= Date.parse(index.until)) {
        throw new Error("Invalid, repeated or out-of-scope history identity");
      }
      ids.add(row.id);
      numbers.add(row.number);
    }
    return rows;
  });
  if (entities.length !== index.totalEntities
    || entities.filter(row => row.workflowReference).length !== index.knownRunReferences) {
    throw new Error("Output-history archive totals mismatch");
  }
  return { index, entities };
}

export function normalizeOutputIdentity(item, repository, aliases, until, observedAt) {
  if (!Number.isSafeInteger(item.number) || item.number <= 0 || typeof item.node_id !== "string"
    || !Number.isFinite(Date.parse(item.created_at)) || !Number.isFinite(Date.parse(item.updated_at))
    || (item.body !== null && typeof item.body !== "string") || !["open", "closed"].includes(item.state)) {
    throw new Error("Malformed GitHub issue/PR inventory entry");
  }
  const url = `https://github.com/${repository}/${item.pull_request ? "pull" : "issues"}/${item.number}`;
  if (![repository, ...aliases].some(name =>
    item.html_url === `https://github.com/${name}/${item.pull_request ? "pull" : "issues"}/${item.number}`)) {
    throw new Error("Inventory entry escaped the verified repository identity");
  }
  if (Date.parse(item.created_at) >= Date.parse(until)) return null;
  const body = item.body ?? "";
  let workflowReference = null, referenceError = null, scopeError = null;
  for (const name of [repository, ...aliases]) {
    try {
      workflowReference = parseWorkflowReference(body, name);
      break;
    } catch (error) {
      if (error instanceof OutOfScopeProducer) { scopeError = error.message; continue; }
      referenceError = error.message;
      break;
    }
  }
  referenceError ??= !workflowReference ? scopeError : null;
  const declared = [...new Set([...body.matchAll(/<!--\s*gh-aw-workflow-id:\s*([A-Za-z0-9_-]+)\s*-->/g)]
    .map(match => match[1]))];
  const references = new Set();
  for (const name of [repository, ...aliases]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of body.matchAll(new RegExp(`https://github\\.com/${escaped}/(?:issues|pull)/([1-9]\\d*)\\b`, "g"))) {
      references.add(Number(match[1]));
    }
    for (const match of body.matchAll(new RegExp(`\\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\s+(?:${escaped})?#([1-9]\\d*)\\b`, "gi"))) {
      references.add(Number(match[1]));
    }
  }
  return { id: item.node_id, number: item.number, repository, url,
    kind: item.pull_request ? "PullRequest" : "Issue", state: item.state.toUpperCase(),
    stateReason: item.state_reason ?? null, createdAt: item.created_at, updatedAt: item.updated_at,
    closedAt: item.closed_at, mergedAt: item.pull_request?.merged_at ?? null,
    observedAt, bodySha256: createHash("sha256").update(body).digest("hex"),
    authorRole: item.user?.type === "Bot" ? "bot" : item.user?.type === "User" ? "user" : "unknown",
    workflowReference, referenceError,
    unverifiedWorkflowId: !workflowReference && declared.length === 1 ? declared[0] : null,
    relatedCandidates: [...references].sort((left, right) => left - right),
    relatedCandidatesLimitation: "Body references are discovery candidates, not accepted GitHub graph edges." };
}

export async function collectOutputHistory(options, getJson, clock = () => new Date().toISOString()) {
  const { repository, until, outputDirectory, aliases = [], requestBudget = 2000, resume = false } = options;
  if (!isRepository(repository) || !isIsoUtc(until) || !aliases.every(isRepository)
    || !Number.isSafeInteger(requestBudget) || requestBudget < 4 || requestBudget > 10000) {
    throw new Error("Invalid repository, cutoff, aliases or bounded request budget");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const indexFile = path.join(outputDirectory, "history.json.gz");
  const prior = existsSync(indexFile) ? read(indexFile) : null;
  if (prior && !resume) throw new Error("History exists; choose a new directory or explicitly --resume");
  if (prior && prior.transport !== "graphql-cursors") throw new Error("Legacy page-number acquisition cannot resume with cursors; choose a new directory");
  if (prior && (prior.repository !== repository || prior.until !== until
    || JSON.stringify(prior.aliases) !== JSON.stringify(aliases))) throw new Error("Resume scope mismatch");
  let requestsUsed = 0;
  const request = async (endpoint, query) => {
    if (++requestsUsed > requestBudget) throw new Error("Output-history request budget exhausted; rerun with --resume");
    return getJson(endpoint, query);
  };
  const metadata = await request(`repos/${repository}`);
  if (metadata.full_name?.toLowerCase() !== repository.toLowerCase() || !Number.isSafeInteger(metadata.id)) {
    throw new Error("Canonical repository identity mismatch");
  }
  if (prior && prior.repositoryId !== metadata.id) throw new Error("Repository identity changed");
  for (const alias of aliases) {
    if ((await request(`repos/${alias}`)).id !== metadata.id) throw new Error("Alias resolves to a different repository");
  }
  let index = prior;
  if (!index) {
    const commits = await request(`repos/${repository}/commits?sha=${encodeURIComponent(metadata.default_branch)}&until=${until}&per_page=1`);
    const revision = commits[0]?.sha;
    if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("No immutable source revision at the analysis cutoff");
    const tree = await request(`repos/${repository}/git/trees/${revision}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("Source tree inventory is incomplete");
    const files = new Set(tree.tree.filter(entry => entry.type === "blob").map(entry => entry.path));
    const sources = tree.tree.filter(entry => entry.type === "blob" && /^\.github\/workflows\/[^/]+\.md$/.test(entry.path));
    const workflows = sources.filter(entry => files.has(entry.path.replace(/\.md$/, ".lock.yml")))
      .map(entry => ({ id: path.basename(entry.path, ".md"), path: entry.path, gitBlob: entry.sha }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!workflows.length) throw new Error("No installed GitHub Agentic Workflow Markdown sources found");
    index = { schemaVersion: 1, kind: "workflow-output-history", repository, repositoryId: metadata.id,
      aliases, until, sourceRevision: revision, workflows,
      unpairedMarkdown: sources.filter(entry => !files.has(entry.path.replace(/\.md$/, ".lock.yml"))).map(entry => entry.path),
      startedAt: clock(), completedAt: null,
      transport: "graphql-cursors", complete: false, pageSize: 100, nextPage: 1,
      connections: { issues: { after: null, complete: false }, pullRequests: { after: null, complete: false } },
      partitions: [], totalEntities: 0, knownRunReferences: 0,
      interpretation: "Surviving issues/PRs and recognized tracking markers; not a complete historical creation ledger or outcome value.",
      limitations: [
        "Deleted, transferred and edited-away outputs, comments and Discussions are not covered by this issues/PR inventory.",
        "State is observed at acquisition, not reconstructed at creation or at the analysis cutoff.",
        "Cursor traversal is not an atomic historical snapshot; deleted/transferred objects cannot be reconstructed.",
        "Creation order can be approximate for imported objects; both connections are traversed to exhaustion, including objects beyond the cutoff.",
        "Source introduction is not inferred from the first output or the repository creation date.",
        "Run references and merges remain lineage/diagnostics until a goal-specific outcome is independently measured.",
      ] };
    write(indexFile, index);
  }
  const seenIds = new Set(), seenNumbers = new Set();
  for (const part of index.partitions) {
    if (part.file !== path.basename(part.file)) throw new Error("Unsafe history partition");
    const values = read(path.join(outputDirectory, part.file));
    if (!Array.isArray(values) || digest(values) !== part.sha256 || values.length !== part.count) throw new Error("History partition integrity mismatch");
    for (const value of values) {
      if (seenIds.has(value.id) || seenNumbers.has(value.number)) throw new Error("Repeated history identity");
      seenIds.add(value.id);
      seenNumbers.add(value.number);
    }
  }
  if (index.complete) return index;
  while (true) {
    const page = index.nextPage;
    const query = inventoryQuery(repository, index.connections);
    const document = await request("graphql", query);
    if (document.errors?.length || document.data?.repository?.databaseId !== index.repositoryId) {
      throw new Error(`Invalid issue/PR graph inventory: ${document.errors?.map(error => error.message).join("; ") ?? "repository identity mismatch"}`);
    }
    const connections = structuredClone(index.connections);
    const items = [];
    for (const [kind, previous] of Object.entries(index.connections).filter(([, value]) => !value.complete)) {
      const connection = document.data.repository[kind];
      if (!Array.isArray(connection?.nodes) || connection.nodes.length > index.pageSize
        || typeof connection.pageInfo?.hasNextPage !== "boolean"
        || (connection.pageInfo.hasNextPage && (!connection.nodes.length
          || typeof connection.pageInfo.endCursor !== "string" || !connection.pageInfo.endCursor
          || connection.pageInfo.endCursor === previous.after))) {
        throw new Error("Malformed or non-advancing issue/PR cursor connection");
      }
      items.push(...connection.nodes.map(value => restShape(value, kind)));
      connections[kind] = { after: connection.pageInfo.endCursor, complete: !connection.pageInfo.hasNextPage };
    }
    if (new Set(items.map(item => item.node_id)).size !== items.length
      || new Set(items.map(item => item.number)).size !== items.length
      || items.some(item => seenIds.has(item.node_id) || seenNumbers.has(item.number))) {
      throw new Error("Issue/PR pagination identities repeated; use a new acquisition snapshot");
    }
    const observedAt = clock();
    const rows = items.map(item => normalizeOutputIdentity(item, repository, aliases, until, observedAt)).filter(Boolean);
    for (const item of items) { seenIds.add(item.node_id); seenNumbers.add(item.number); }
    const file = `entities-${String(page).padStart(5, "0")}.json.gz`;
    write(path.join(outputDirectory, file), rows);
    const complete = Object.values(connections).every(value => value.complete);
    index = { ...index, nextPage: page + 1, connections, complete, completedAt: complete ? observedAt : null,
      partitions: [...index.partitions, { file, query, observedAt, count: rows.length, sha256: digest(rows) }],
      totalEntities: index.totalEntities + rows.length,
      excludedAfterCutoff: (index.excludedAfterCutoff ?? 0) + items.length - rows.length,
      knownRunReferences: index.knownRunReferences + rows.filter(row => row.workflowReference).length };
    write(indexFile, index);
    if (page % 25 === 0 || complete) console.error(JSON.stringify({ page, entities: index.totalEntities,
      runLinkedOutputs: index.knownRunReferences, complete, requestsUsed }));
    if (complete) return index;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  while (args[0]?.startsWith("--")) {
    const key = args.shift();
    if (key === "--until") options.until = args.shift();
    else if (key === "--alias") (options.aliases ??= []).push(args.shift());
    else if (key === "--request-budget") options.requestBudget = Number(args.shift());
    else if (key === "--resume") options.resume = true;
    else throw new Error(`Unknown output-history option: ${key}`);
  }
  if (args.length !== 2) throw new Error("usage: collect-output-history.mjs --until UTC [--alias OWNER/REPO] [--resume] [--request-budget N] OWNER/REPO OUTPUT_DIRECTORY");
  [options.repository, options.outputDirectory] = args;
  const result = await collectOutputHistory(options, async (endpoint, query) => {
    const { stdout } = await execute("gh", query ? ["api", "graphql", "-f", `query=${query}`] : ["api", endpoint], { encoding: "utf8", timeout: 60000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PAGER: "cat" } });
    return JSON.parse(stdout);
  });
  console.log(JSON.stringify({ repository: result.repository, sourceRevision: result.sourceRevision,
    workflows: result.workflows.length, entities: result.totalEntities, runLinkedOutputs: result.knownRunReferences,
    complete: result.complete, output: path.join(options.outputDirectory, "history.json.gz") }));
}
