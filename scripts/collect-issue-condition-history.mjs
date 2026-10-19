import { execFile } from "node:child_process";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { isIsoUtc, isRepository } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
const eventTypes = ["LabeledEvent", "UnlabeledEvent", "ClosedEvent", "ReopenedEvent",
  "AssignedEvent", "UnassignedEvent", "TransferredEvent"];
const timeline = after => `timelineItems(first:100,after:${JSON.stringify(after)},itemTypes:[
  LABELED_EVENT,UNLABELED_EVENT,CLOSED_EVENT,REOPENED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,TRANSFERRED_EVENT]) {
  totalCount pageInfo {hasNextPage endCursor}
  nodes {__typename ... on Node {id}
  ${eventTypes.map(type => `... on ${type} {createdAt}`).join("\n")}}
}`;
const issueFields = `id number createdAt updatedAt state repository {databaseId}
  labels {totalCount} assignees {totalCount}`;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function normalizeIssueCondition(identity, node, events, observedAt, repositoryId) {
  if (!node?.id || node.repository?.databaseId !== repositoryId) return {
    id: identity.id, number: identity.number, createdAt: identity.createdAt,
    available: false, reason: "Issue identity no longer resolves as an accessible issue in the enrolled repository", observedAt };
  if (node.id !== identity.id || node.number !== identity.number || node.createdAt !== identity.createdAt
    || node.repository?.databaseId !== repositoryId || !["OPEN", "CLOSED"].includes(node.state)
    || !iso(node.updatedAt) || !iso(observedAt)
    || ![node.labels?.totalCount, node.assignees?.totalCount].every(value => Number.isSafeInteger(value) && value >= 0)
    || events.length !== node.timelineItems.totalCount
    || new Set(events.map(event => event.id)).size !== events.length) throw new Error("Issue condition identity or completeness mismatch");
  let previous = Date.parse(node.createdAt);
  const normalized = events.map(event => {
    if (!eventTypes.includes(event.__typename) || typeof event.id !== "string" || !event.id
      || !iso(event.createdAt) || Date.parse(event.createdAt) < previous || Date.parse(event.createdAt) > Date.parse(observedAt)) {
      throw new Error("Malformed or unordered issue condition event");
    }
    previous = Date.parse(event.createdAt);
    return { id: event.id, type: event.__typename, at: event.createdAt };
  });
  return { id: node.id, number: node.number, createdAt: node.createdAt, available: true, observedAt,
    terminal: { state: node.state, labels: node.labels.totalCount, assignees: node.assignees.totalCount,
      updatedAt: node.updatedAt }, events: normalized };
}

export function readIssueConditionHistory(directory) {
  const index = readCensusJson(path.join(directory, "history.json.gz"));
  if (index.schemaVersion !== 1 || index.kind !== "issue-condition-history" || !Array.isArray(index.partitions)
    || index.complete !== true || !Number.isSafeInteger(index.issues) || index.issues < 1
    || !isRepository(index.repository) || !isIsoUtc(index.until)
    || !/^[a-f0-9]{40}$/.test(index.sourceRevision) || !/^[a-f0-9]{64}$/.test(index.identityIndexSha256)
    || !Number.isSafeInteger(index.repositoryId) || index.repositoryId < 1) {
    throw new Error("Incomplete or invalid issue condition archive");
  }
  const issues = index.partitions.flatMap(part => {
    if (!/^issues-\d{5}\.json\.gz$/.test(part.file)) throw new Error("Unsafe issue partition");
    const rows = readCensusJson(path.join(directory, part.file));
    if (!Array.isArray(rows) || rows.length !== part.count || censusDigest(rows) !== part.sha256) {
      throw new Error("Issue condition partition integrity mismatch");
    }
    return rows;
  });
  if (issues.length !== index.issues || new Set(issues.map(row => row.id)).size !== issues.length) {
    throw new Error("Issue condition archive totals mismatch");
  }
  return { index, issues };
}

export async function collectIssueConditionHistory(historyDirectory, outputDirectory, getJson, options = {}) {
  const history = readOutputHistory(historyDirectory);
  if (history.index.complete !== true) throw new Error("A complete identity inventory is required");
  const issues = history.entities.filter(row => row.kind === "Issue");
  const { requestBudget = 1500, concurrency = 4 } = options;
  if (!Number.isSafeInteger(requestBudget) || requestBudget < 1 || requestBudget > 10000
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid issue acquisition budget");
  mkdirSync(outputDirectory, { recursive: true });
  const indexFile = path.join(outputDirectory, "history.json.gz");
  const scope = { schemaVersion: 1, kind: "issue-condition-history", repository: history.index.repository,
    repositoryId: history.index.repositoryId, sourceRevision: history.index.sourceRevision,
    until: history.index.until, identityIndexSha256: censusDigest(history.index), issues: issues.length };
  const index = existsSync(indexFile) ? readCensusJson(indexFile) : { ...scope, complete: false, partitions: [] };
  if (Object.entries(scope).some(([key, value]) => index[key] !== value)) throw new Error("Issue archive resume scope changed");
  const persist = () => {
    const temporary = `${indexFile}.tmp.gz`;
    writeCensusJson(temporary, index);
    renameSync(temporary, indexFile);
  };
  persist();
  let requests = 0, next = 0;
  const batches = Array.from({ length: Math.ceil(issues.length / 50) }, (_, batch) => issues.slice(batch * 50, (batch + 1) * 50));
  const request = async query => {
    if (requests >= requestBudget) throw new Error("Issue history request budget exhausted; retained batches can be resumed");
    requests += 1;
    const response = await getJson(query);
    if (response.errors?.length || !response.data) throw new Error(`Issue history GraphQL failed: ${JSON.stringify(response.errors)}`);
    return response.data;
  };
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const batchNumber = next++;
      if (batchNumber >= batches.length) return;
      const batch = batches[batchNumber], file = `issues-${String(batchNumber + 1).padStart(5, "0")}.json.gz`;
      const retained = index.partitions.find(part => part.file === file);
      if (retained) {
        const rows = readCensusJson(path.join(outputDirectory, file));
        if (censusDigest(rows) !== retained.sha256 || rows.length !== batch.length
          || rows.some((row, position) => row.id !== batch[position].id)) throw new Error("Retained issue batch changed");
        continue;
      }
      const response = await request(`query {nodes(ids:${JSON.stringify(batch.map(row => row.id))}) {
        ... on Issue {${issueFields} ${timeline(null)}}}}`);
      if (!Array.isArray(response.nodes) || response.nodes.length !== batch.length) throw new Error("Issue batch response size mismatch");
      const rows = [];
      for (const [position, node] of response.nodes.entries()) {
        const events = [...node?.timelineItems?.nodes ?? []];
        let connection = node?.timelineItems;
        const cursors = new Set();
        while (connection?.pageInfo.hasNextPage) {
          const cursor = connection.pageInfo.endCursor;
          if (!cursor || cursors.has(cursor)) throw new Error("Issue history cursor did not advance");
          cursors.add(cursor);
          const page = (await request(`query {node(id:${JSON.stringify(node.id)}) {
            ... on Issue {id ${timeline(cursor)}}}}`)).node;
          if (page?.id !== node.id || page.timelineItems.totalCount !== node.timelineItems.totalCount) {
            throw new Error("Issue history changed during pagination; resume the uncommitted batch");
          }
          connection = page.timelineItems;
          events.push(...connection.nodes);
        }
        rows.push(normalizeIssueCondition(batch[position], node, events, new Date().toISOString(), scope.repositoryId));
      }
      writeCensusJson(path.join(outputDirectory, file), rows);
      index.partitions.push({ file, count: rows.length, sha256: censusDigest(rows) });
      index.partitions.sort((left, right) => left.file.localeCompare(right.file));
      persist();
      if (index.partitions.length % 25 === 0) console.log(JSON.stringify({ batches: index.partitions.length,
        totalBatches: batches.length, requests }));
    }
  }));
  if (!index.complete) {
    index.complete = index.partitions.length === batches.length;
    index.completedAt = new Date().toISOString();
  }
  persist();
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [history, output, ...extra] = process.argv.slice(2);
  if (!history || !output || extra.length) throw new Error("usage: collect-issue-condition-history.mjs IDENTITY_HISTORY OUTPUT");
  const index = await collectIssueConditionHistory(history, output, async query =>
    JSON.parse((await execute("gh", ["api", "graphql", "-f", `query=${query}`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 120000 })).stdout));
  console.log(JSON.stringify({ complete: index.complete, issues: index.issues, partitions: index.partitions.length }));
}
