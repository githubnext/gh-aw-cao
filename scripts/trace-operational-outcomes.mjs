import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { OutOfScopeProducer, parseWorkflowReference, validateRunReference } from "../.github/skills/add-operational-value/scripts/github-lineage.mjs";

export { parseWorkflowReference, validateRunReference };

const execute = promisify(execFile);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPattern = /^[a-zA-Z0-9_-]+$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const identity = entity => `${entity.repository.toLowerCase()}#${entity.number}`;
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));

const referenceFields = "id number url repository { nameWithOwner }";
const timelineFields = (pullRequest = false) => `timelineItems(first:100,itemTypes:[CLOSED_EVENT,REOPENED_EVENT,CROSS_REFERENCED_EVENT${pullRequest ? ",MERGED_EVENT" : ""}]) {
  nodes { __typename
    ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { ${referenceFields} } } }
    ... on ReopenedEvent { createdAt }
    ${pullRequest ? "... on MergedEvent { createdAt }" : ""}
    ... on CrossReferencedEvent { createdAt source { __typename
      ... on PullRequest { ${referenceFields} } ... on Issue { ${referenceFields} } } }
  } pageInfo { hasNextPage }
}`;

export function graphQuery(repository, numbers) {
  if (!repositoryPattern.test(repository) || !numbers.length || numbers.length > 10 || !numbers.every(positive)) {
    throw new Error("Invalid bounded graph request");
  }
  const [owner, name] = repository.split("/");
  const fields = numbers.map(number => `n${number}: issueOrPullRequest(number:${number}) {
    __typename
    ... on Issue { ${referenceFields} body state stateReason createdAt updatedAt closedAt ${timelineFields()} }
    ... on PullRequest { ${referenceFields} body state createdAt updatedAt closedAt mergedAt headRefOid
      mergeCommit { oid }
      closingIssuesReferences(first:20) { nodes { ${referenceFields} } pageInfo { hasNextPage } }
      commits(last:1) { nodes { commit { oid statusCheckRollup { state } } } }
      ${timelineFields(true)}
    }
  }`).join("\n");
  return `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { ${fields} }
    rateLimit { cost remaining } }`;
}

function normalizeReference(value) {
  if (!value?.id || !positive(value.number) || !repositoryPattern.test(value.repository?.nameWithOwner ?? "")
    || !["https://github.com/" + value.repository.nameWithOwner + "/issues/" + value.number,
      "https://github.com/" + value.repository.nameWithOwner + "/pull/" + value.number].includes(value.url)) {
    throw new Error("Invalid GitHub graph entity identity");
  }
  return { id: value.id, number: value.number, repository: value.repository.nameWithOwner, url: value.url };
}

export function normalizeGraphEntity(value, observedAt) {
  const reference = normalizeReference(value);
  if (!["Issue", "PullRequest"].includes(value.__typename) || !instant(observedAt)
    || !instant(value.createdAt) || !instant(value.updatedAt)
    || [value.closedAt, value.mergedAt].some(time => time != null && !instant(time))
    || (value.mergedAt && Date.parse(value.mergedAt) < Date.parse(value.createdAt))
    || !["OPEN", "CLOSED", ...(value.__typename === "PullRequest" ? ["MERGED"] : [])].includes(value.state)
    || !Array.isArray(value.timelineItems?.nodes) || typeof value.timelineItems.pageInfo?.hasNextPage !== "boolean") {
    throw new Error("Incomplete GitHub graph assessment");
  }
  const edges = [];
  const events = value.timelineItems.nodes.map(event => {
    if (!instant(event.createdAt)) throw new Error("Missing graph event timestamp");
    if (event.__typename === "ClosedEvent" && event.closer?.__typename === "PullRequest") {
      const target = normalizeReference(event.closer);
      edges.push({ relation: "closed-by", at: event.createdAt, target });
      return { type: "closed", at: event.createdAt, closerId: target.id };
    }
    if (event.__typename === "CrossReferencedEvent") {
      edges.push({ relation: "referenced-by", at: event.createdAt, target: normalizeReference(event.source) });
      return { type: "referenced", at: event.createdAt };
    }
    const types = { ClosedEvent: "closed", ReopenedEvent: "reopened", MergedEvent: "merged" };
    if (!types[event.__typename]) throw new Error("Unexpected graph event");
    return { type: types[event.__typename], at: event.createdAt };
  });
  let headChecks = null;
  let closingLinksComplete = true;
  if (value.__typename === "PullRequest") {
    if (!Array.isArray(value.closingIssuesReferences?.nodes)
      || typeof value.closingIssuesReferences.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("Missing closing-issue connection");
    }
    for (const issue of value.closingIssuesReferences.nodes) {
      edges.push({ relation: "declares-closing", target: normalizeReference(issue) });
    }
    closingLinksComplete = !value.closingIssuesReferences.pageInfo.hasNextPage;
    const commit = value.commits?.nodes?.[0]?.commit;
    headChecks = { commit: commit?.oid ?? null, state: commit?.statusCheckRollup?.state ?? null,
      matchesCurrentHead: Boolean(commit?.oid && commit.oid === value.headRefOid),
      scope: "current-head-rollup-not-required-regression-proof" };
  }
  return { ...reference, kind: value.__typename, state: value.state, stateReason: value.stateReason ?? null,
    createdAt: value.createdAt, updatedAt: value.updatedAt, closedAt: value.closedAt ?? null,
    mergedAt: value.mergedAt ?? null, mergeCommit: value.mergeCommit?.oid ?? null,
    timeToMergeSeconds: value.mergedAt ? (Date.parse(value.mergedAt) - Date.parse(value.createdAt)) / 1000 : null,
    observedAt, bodyDigest: censusDigest(value.body), historyComplete: !value.timelineItems.pageInfo.hasNextPage,
    closingLinksComplete, headChecks, events, edges,
    reversalAssessment: "Reopening events are retained; commit reverts and deployment effects are not collected." };
}

export function summarizeTrace(trace) {
  const nodes = new Map(trace.entities.filter(node => !node.error).map(node => [node.id, node]));
  const workflows = trace.workflows.map(workflow => {
    const roots = trace.entities.filter(node => node.root && node.workflowReference?.workflowId === workflow.id);
    const verified = roots.filter(node => node.runValidation?.status === "verified-run-reference" && !node.error);
    const acceptedLinks = new Set();
    for (const node of verified.filter(node => node.kind === "PullRequest" && node.state === "MERGED" && node.mergedAt)) {
      for (const edge of node.edges.filter(edge => edge.relation === "declares-closing")) {
        const issue = nodes.get(edge.target.id);
        const lastStateEvent = issue?.events.filter(event => ["closed", "reopened"].includes(event.type))
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1);
        if (issue?.kind === "Issue" && issue.state === "CLOSED" && issue.stateReason === "COMPLETED"
          && issue.historyComplete && lastStateEvent?.type === "closed" && lastStateEvent.closerId === node.id
          && Date.parse(lastStateEvent.at) >= Date.parse(node.mergedAt)) acceptedLinks.add(issue.id);
      }
    }
    return { ...workflow, referencedRoots: roots.length, verifiedRunReferences: verified.length,
      observedStates: verified.length ? {
        openIssues: verified.filter(node => node.kind === "Issue" && node.state === "OPEN").length,
        closedIssues: verified.filter(node => node.kind === "Issue" && node.state === "CLOSED").length,
        openPullRequests: verified.filter(node => node.kind === "PullRequest" && node.state === "OPEN").length,
        mergedPullRequests: verified.filter(node => node.kind === "PullRequest" && node.state === "MERGED").length,
        closedUnmergedPullRequests: verified.filter(node => node.kind === "PullRequest" && node.state === "CLOSED").length,
        rootsWithReopening: verified.filter(node => node.events.some(event => event.type === "reopened")).length,
        mergedAndExplicitlyClosedCompletedIssues: acceptedLinks.size,
      } : null,
      outcomeValue: null,
      limitation: verified.length
        ? "Observed linked-output diagnostics, not complete workflow output coverage, required-check acceptance or causal benefit."
        : "No verified run-linked output in this bounded acquisition; not zero work or zero value." };
  });
  return { workflows, totals: {
    workflows: workflows.length,
    workflowsWithVerifiedReferences: workflows.filter(row => row.verifiedRunReferences > 0).length,
    roots: trace.entities.filter(node => node.root).length,
    verifiedRunReferences: workflows.reduce((total, row) => total + row.verifiedRunReferences, 0),
    relatedEntities: trace.entities.filter(node => !node.root).length,
    mergedPullRequests: workflows.reduce((total, row) => total + (row.observedStates?.mergedPullRequests ?? 0), 0),
    closedUnmergedPullRequests: workflows.reduce((total, row) => total + (row.observedStates?.closedUnmergedPullRequests ?? 0), 0),
    mergedAndExplicitlyClosedCompletedIssueLinks: workflows.reduce((total, row) =>
      total + (row.observedStates?.mergedAndExplicitlyClosedCompletedIssues ?? 0), 0),
    entityErrors: trace.entities.filter(node => node.error).length,
  } };
}

async function mapBounded(values, task) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (next < values.length) await task(values[next++]);
  }));
}

export async function collectOutcomeTrace(manifest, options, getJson, clock = () => new Date().toISOString()) {
  const { repository } = manifest;
  const { since, until, limit = 200, requestBudget = 500, previous = null, inventory = null } = options;
  if (!repositoryPattern.test(repository) || !instant(since) || !instant(until)
    || Date.parse(since) >= Date.parse(until) || !positive(limit) || limit > 1000
    || !positive(requestBudget) || requestBudget > 5000) throw new Error("Invalid trace scope or acquisition bound");
  const workflows = (manifest.workflows ?? manifest.contracts?.map(row => ({
    id: path.basename(row.path).replace(/\.(?:md|ya?ml)$/, ""), path: row.path,
  }))) ?? [];
  if (!workflows.length || workflows.some(row => !workflowPattern.test(row.id)
    || !/^\.github\/workflows\/[^/]+\.(md|ya?ml)$/.test(row.path))
    || new Set(workflows.map(row => row.id)).size !== workflows.length) throw new Error("Invalid workflow identities");
  const byWorkflow = new Map(workflows.map(row => [row.id, row]));
  if (inventory && (previous || inventory.index?.complete !== true || !Array.isArray(inventory.entities)
    || inventory.index.repository?.toLowerCase() !== repository.toLowerCase()
    || inventory.index.until !== until || inventory.index.sourceRevision !== manifest.revision)) {
    throw new Error("Retained inventory scope mismatch");
  }
  const inventorySeeds = inventory ? inventory.entities.filter(node => byWorkflow.has(node.workflowReference?.workflowId)
    && Date.parse(node.createdAt) >= Date.parse(since) && Date.parse(node.createdAt) < Date.parse(until)) : null;
  if (previous && (previous.repository !== repository || previous.sourceRevision !== (manifest.revision ?? null)
    || previous.createdWindow.since !== since || previous.createdWindow.until !== until
    || censusDigest(previous.workflows) !== censusDigest(workflows))) throw new Error("Previous trace scope mismatch");
  const trace = { schemaVersion: 1, repository, sourceRevision: manifest.revision ?? null, workflows,
    protocol: "gh-aw-linked-output-followup-v1", startedAt: clock(), completedAt: null,
    createdWindow: { since, until, endExclusive: true }, limit, requestBudget,
    previousDigest: previous ? censusDigest(previous) : null,
    interpretation: "Current GitHub graph observations and verified run references; not historical cutoff scores or causal effects.",
    discovery: { mode: previous ? "preserved-identities" : inventory ? "retained-inventory-identities" : "bounded-github-search",
      ...(inventory ? { inventorySha256: censusDigest(inventory.index),
        scope: "Named workflow markers in the retained issue/PR population; unresolved markers, comments and deleted outputs are outside this cohort." } : {}),
      requests: [], totalCount: null,
      scannedCount: 0, boundaryExcluded: 0, limitExcluded: 0,
      complete: false, rejected: [], errors: [] }, requestsUsed: 0, entities: [] };
  const request = async (endpoint, query = null) => {
    if (trace.requestsUsed >= requestBudget) throw new Error("Acquisition request budget exhausted");
    trace.requestsUsed += 1;
    return getJson(endpoint, query);
  };
  const seeds = new Map();
  if (inventorySeeds) {
    if (inventorySeeds.length > limit) throw new Error("Retained workflow root cohort exceeds the explicit trace limit");
    for (const node of inventorySeeds) {
      if (!positive(node.number) || typeof node.id !== "string" || !node.id
        || node.repository?.toLowerCase() !== repository.toLowerCase()
        || !/^[a-f0-9]{64}$/.test(node.bodySha256 ?? "")
        || !/^[1-9]\d*$/.test(node.workflowReference.runId ?? "")
        || ![null, undefined].includes(node.workflowReference.attempt) && !positive(node.workflowReference.attempt)
        || seeds.has(identity(node))) throw new Error("Invalid retained inventory root identity");
      seeds.set(identity(node), node);
    }
    trace.discovery.totalCount = seeds.size;
    trace.discovery.scannedCount = seeds.size;
    trace.discovery.complete = true;
  } else if (previous) {
    for (const node of previous.entities.filter(node => node.root)) seeds.set(identity(node), node);
    if (seeds.size > limit) throw new Error("Refresh limit is smaller than the preserved root cohort");
    trace.discovery.totalCount = seeds.size;
    trace.discovery.complete = previous.discovery.complete;
  } else {
    const query = `repo:${repository} in:body "gh-aw" created:${since}..${until}`;
    for (let page = 1; seeds.size < limit && page <= 10; page += 1) {
      const endpoint = `search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=100&page=${page}`;
      trace.discovery.requests.push(endpoint);
      let result;
      try {
        result = await request(endpoint);
        if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total_count)
          || typeof result.incomplete_results !== "boolean") throw new Error("Invalid search inventory");
      } catch (error) {
        trace.discovery.errors.push(error.message);
        break;
      }
      trace.discovery.totalCount = result.total_count;
      for (const item of result.items) {
        if (!positive(item.number) || !instant(item.created_at)
          || Date.parse(item.created_at) < Date.parse(since) || Date.parse(item.created_at) > Date.parse(until)) {
          throw new Error("Search entity falls outside the frozen created cohort");
        }
        trace.discovery.scannedCount += 1;
        if (Date.parse(item.created_at) === Date.parse(until)) {
          trace.discovery.boundaryExcluded += 1;
          continue;
        }
        const key = `${repository.toLowerCase()}#${item.number}`;
        if (seeds.size < limit) seeds.set(key, { repository, number: item.number });
        else if (!seeds.has(key)) trace.discovery.limitExcluded += 1;
      }
      if (!result.incomplete_results && !trace.discovery.limitExcluded && result.total_count <= trace.discovery.scannedCount) {
        trace.discovery.complete = true;
        break;
      }
      if (result.items.length === 0) break;
    }
  }
  const readNodes = async (targets, root) => {
    const rows = [];
    for (let offset = 0; offset < targets.length; offset += 10) {
      const batch = targets.slice(offset, offset + 10);
      try {
        const document = await request("graphql", graphQuery(repository, batch.map(row => row.number)));
        if (document.errors?.length) throw new Error(`GitHub graph errors: ${document.errors.map(row => row.message).join("; ")}`);
        const observedAt = clock();
        for (const target of batch) {
          const raw = document.data?.repository?.[`n${target.number}`];
          try {
            if (!raw) throw new Error("GitHub entity unavailable");
            const node = { ...normalizeGraphEntity(raw, observedAt), root };
            if (node.repository.toLowerCase() !== repository.toLowerCase() || node.number !== target.number
              || (target.id && target.id !== node.id)) throw new Error("Graph identity changed");
            if (root) {
              const unchangedInventoryBody = inventory && target.bodySha256
                === createHash("sha256").update(raw.body).digest("hex");
              let ref = unchangedInventoryBody ? target.workflowReference : parseWorkflowReference(raw.body, repository);
              if ((previous || inventory) && target.workflowReference) {
                const prior = target.workflowReference;
                if (ref && ((ref.workflowId !== null && ref.workflowId !== prior.workflowId)
                  || ref.runId !== prior.runId || ref.attempt !== prior.attempt)) {
                  throw new Error("Current marker conflicts with preserved provenance");
                }
                if (ref && ref.workflowId === null && prior.identityResolvedFromRunPath) {
                  ref = { ...ref, workflowId: prior.workflowId, identityResolvedFromRunPath: true };
                }
                if (!ref) {
                  ref = prior;
                  node.provenanceFromPreviousSnapshot = true;
                }
                if (unchangedInventoryBody) node.provenanceFromPreviousSnapshot = true;
              }
              if (!ref || (ref.workflowId !== null && !byWorkflow.has(ref.workflowId))) {
                trace.discovery.rejected.push({ number: target.number, reason: "No exact known workflow/run marker" });
                continue;
              }
              node.workflowReference = ref;
            }
            rows.push(node);
          } catch (error) {
            if (error instanceof OutOfScopeProducer) {
              trace.discovery.rejected.push({ number: target.number, reason: error.message });
              continue;
            }
            rows.push({ repository, number: target.number, root, observedAt, error: error.message,
              ...(target.workflowReference ? { workflowReference: target.workflowReference } : {}) });
          }
        }
      } catch (error) {
        rows.push(...batch.map(target => ({ repository, number: target.number, root, error: error.message,
          observedAt: clock(), ...(target.workflowReference ? { workflowReference: target.workflowReference } : {}) })));
      }
    }
    return rows;
  };
  const roots = await readNodes([...seeds.values()], true);
  const runTasks = new Map();
  for (const node of roots.filter(row => row.workflowReference && !row.error)) {
    const ref = node.workflowReference;
    const key = `${ref.runId}:${ref.attempt ?? "unknown"}`;
    if (!runTasks.has(key)) runTasks.set(key, []);
    runTasks.get(key).push(node);
  }
  await mapBounded([...runTasks.values()], async nodes => {
    const ref = nodes[0].workflowReference;
    const endpoint = `repos/${repository}/actions/runs/${ref.runId}${ref.attempt === null ? "" : `/attempts/${ref.attempt}`}`;
    try {
      const run = await request(endpoint);
      for (const node of nodes) {
        if (node.workflowReference.workflowId === null) {
          const workflow = workflows.find(row => row.path.replace(/\.md$/, ".lock.yml") === String(run.path).split("@")[0]);
          if (!workflow) throw new Error("Run execution path is outside the declared workflows");
          node.workflowReference = { ...node.workflowReference, workflowId: workflow.id, identityResolvedFromRunPath: true };
        }
        node.runValidation = validateRunReference(node.workflowReference, run, byWorkflow.get(node.workflowReference.workflowId).path, repository);
      }
    } catch (error) {
      for (const node of nodes) node.runValidation = { status: "unverified", reason: error.message };
    }
  });
  const related = new Map();
  for (const node of roots.filter(row => row.runValidation?.status === "verified-run-reference"
    || (inventory && row.workflowReference && !row.error))) {
    for (const edge of node.edges.filter(row => ["closed-by", "declares-closing",
      ...(inventory ? ["referenced-by"] : [])].includes(row.relation))) {
      if (edge.target.repository.toLowerCase() === repository.toLowerCase() && !seeds.has(identity(edge.target))) {
        related.set(identity(edge.target), edge.target);
      }
    }
  }
  trace.entities = [...roots, ...await readNodes([...related.values()], false)]
    .sort((left, right) => left.number - right.number);
  trace.completedAt = clock();
  trace.summary = summarizeTrace(trace);
  return trace;
}

export function writeTraceArchive(file, trace) {
  if (existsSync(file)) throw new Error("Refusing to overwrite an observation; choose a new snapshot path");
  const prefix = path.basename(file).replace(/\.json(?:\.gz)?$/, "");
  const partitions = [];
  for (let offset = 0; offset < trace.entities.length; offset += 100) {
    const name = `${prefix}-entities-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
    const target = path.join(path.dirname(file), name);
    if (existsSync(target)) throw new Error("Trace partition already exists");
    const entities = trace.entities.slice(offset, offset + 100);
    writeCensusJson(target, entities);
    partitions.push({ file: name, sha256: censusDigest(entities), count: entities.length });
  }
  const { entities: _entities, ...index } = trace;
  writeCensusJson(file, { ...index, partitions });
}

export function readTraceArchive(file) {
  const index = readCensusJson(file);
  if (index.schemaVersion !== 1 || !Array.isArray(index.partitions)) throw new Error("Invalid trace archive");
  const entities = index.partitions.flatMap(part => {
    if (typeof part.file !== "string" || path.basename(part.file) !== part.file || !part.file.endsWith(".json.gz")) {
      throw new Error("Unsafe trace partition reference");
    }
    const rows = readCensusJson(path.join(path.dirname(file), part.file));
    if (!Array.isArray(rows) || censusDigest(rows) !== part.sha256 || rows.length !== part.count) {
      throw new Error("Trace partition digest or count mismatch");
    }
    return rows;
  });
  const { partitions: _partitions, ...trace } = index;
  trace.entities = entities;
  if (censusDigest(summarizeTrace(trace)) !== censusDigest(trace.summary)) throw new Error("Trace summary mismatch");
  return trace;
}

async function githubJson(endpoint, query) {
  const args = query ? ["api", "graphql", "-f", `query=${query}`] : ["api", endpoint];
  try {
    const { stdout } = await execute("gh", args, {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GH_PAGER: "cat" },
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`GitHub ${endpoint === "graphql" ? "graph" : "REST"} request failed: ${
      String(error.stderr || error.code || error.message).slice(0, 1000)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--replay" && args.length === 2) {
    console.log(JSON.stringify(readTraceArchive(args[1]).summary, null, 2));
    return;
  }
  const [manifestFile, output, ...flags] = args;
  if (!manifestFile || !output || flags.length % 2 !== 0) throw new Error(
    "Usage: node scripts/trace-operational-outcomes.mjs MANIFEST OUTPUT --since UTC --until UTC [--limit 200] [--request-budget 500] [--previous ARCHIVE]; or --replay ARCHIVE",
  );
  const options = {};
  const names = { "--since": "since", "--until": "until", "--limit": "limit", "--request-budget": "requestBudget", "--previous": "previous" };
  for (let i = 0; i < flags.length; i += 2) {
    const key = names[flags[i]];
    if (!key || Object.hasOwn(options, key)) throw new Error("Unknown or repeated trace option");
    options[key] = ["limit", "requestBudget"].includes(key) ? Number(flags[i + 1])
      : key === "previous" ? readTraceArchive(flags[i + 1]) : flags[i + 1];
  }
  if (existsSync(output)) throw new Error("Output observation already exists");
  const trace = await collectOutcomeTrace(readCensusJson(manifestFile), options, githubJson);
  trace.collectorSha256 = censusDigest(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  writeTraceArchive(output, trace);
  console.log(JSON.stringify({ output, discovery: trace.discovery, totals: trace.summary.totals }, null, 2));
  if (trace.discovery.errors.length || trace.summary.totals.entityErrors
    || trace.entities.some(row => row.runValidation?.status === "unverified")) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
