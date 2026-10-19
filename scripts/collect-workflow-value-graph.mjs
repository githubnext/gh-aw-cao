import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { collectOutcomeTrace, writeTraceArchive } from "./trace-operational-outcomes.mjs";
import { writeCensusJson } from "./operational-value-census-io.mjs";

const execute = promisify(execFile);
export function workflowNativeLinks(trace, workflowId, until) {
  if (!trace.workflows.some(workflow => workflow.id === workflowId)) throw new Error("Unknown native linkage workflow");
  const origins = new Map();
  const add = (target, root, relation, at) => {
    if (target.repository.toLowerCase() !== trace.repository.toLowerCase()) return;
    if (!origins.has(target.id)) origins.set(target.id, []);
    origins.get(target.id).push({ rootId: root.id, rootNumber: root.number, relation, at,
      rootCreatedAt: root.createdAt, runId: root.workflowReference.runId,
      runReference: root.runValidation?.status ?? "unverified",
      creationReceipt: "not-collected" });
  };
  for (const root of trace.entities.filter(node => !node.error && node.root && node.workflowReference?.workflowId === workflowId)) {
    if (root.kind === "PullRequest") add(root, root, "direct-workflow-marker", root.createdAt);
    if (root.kind === "Issue") {
      for (const edge of root.edges.filter(edge => ["closed-by", "referenced-by"].includes(edge.relation)
        && /\/pull\/\d+$/.test(edge.target.url))) add(edge.target, root, edge.relation, edge.at);
    }
  }
  const contributions = trace.entities.filter(node => !node.error && node.kind === "PullRequest"
    && node.mergedAt && node.mergedAt < until && /^[a-f0-9]{40}$/.test(node.mergeCommit ?? "") && origins.has(node.id))
    .flatMap(node => {
      const linkedFrom = origins.get(node.id).filter(origin => origin.rootCreatedAt <= node.mergedAt
        && origin.at <= node.mergedAt);
      return linkedFrom.length ? [{ id: node.id, number: node.number, url: node.url, mergedAt: node.mergedAt,
        mergeCommit: node.mergeCommit, attribution: "corroborated", linkedFrom }] : [];
    });
  return {
    schemaVersion: 1, kind: "native-workflow-links", repository: trace.repository, workflowId,
    sourceRevision: trace.sourceRevision, since: trace.createdWindow.since, until,
    observedAt: trace.completedAt, complete: trace.discovery.complete
      && trace.entities.every(node => !node.error) && trace.discovery.errors.length === 0 && trace.discovery.rejected.length === 0,
    graphConnectionsComplete: trace.entities.every(node => node.historyComplete && node.closingLinksComplete),
    rootCohort: trace.entities.filter(node => node.root).length, contributions,
    limitations: ["Corroborated markers and explicit GitHub graph links are not safe-output creation receipts or exclusive causal attribution.",
      "This cohort excludes unresolved workflow markers, comments, edited-away markers and deleted outputs.",
      "Links discovered after the PR merged are not used to backdate contribution.",
      "Merge and check rollups do not prove native improvement, race safety, behavior preservation or required-regression acceptance."],
  };
}

export async function collectWorkflowValueGraph(historyDirectory, workflowId, since, outputDirectory) {
  const history = readOutputHistory(historyDirectory);
  const workflow = history.index.workflows.find(row => row.id === workflowId);
  if (!workflow) throw new Error("Workflow missing from frozen source inventory");
  if (existsSync(path.join(outputDirectory, "trace.json.gz")) || existsSync(path.join(outputDirectory, "links.json.gz"))) {
    throw new Error("Refusing to overwrite preserved workflow graph observations");
  }
  mkdirSync(outputDirectory, { recursive: true });
  let requests = 0;
  const getJson = async (endpoint, query) => {
    requests++;
    if (requests % 25 === 0) console.error(`Acquiring workflow graph: ${requests} requests`);
    const args = query ? ["api", "graphql", "-f", `query=${query}`] : ["api", endpoint];
    const { stdout } = await execute("gh", args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat" } });
    return JSON.parse(stdout);
  };
  const trace = await collectOutcomeTrace({ repository: history.index.repository, revision: history.index.sourceRevision,
    workflows: [workflow] }, { since, until: history.index.until, limit: 1000, requestBudget: 1500, inventory: history }, getJson);
  writeTraceArchive(path.join(outputDirectory, "trace.json.gz"), trace);
  const links = workflowNativeLinks(trace, workflowId, history.index.until);
  writeCensusJson(path.join(outputDirectory, "links.json.gz"), links);
  return links;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error("usage: collect-workflow-value-graph.mjs OUTPUT_HISTORY WORKFLOW SINCE NEW_ARCHIVE");
  const result = await collectWorkflowValueGraph(...args);
  console.log(JSON.stringify({ complete: result.complete, roots: result.rootCohort, contributions: result.contributions.length }));
}
