import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { epochNs, readZip } from "../../../../scripts/native-smoke-pydantic.mjs";

export const contract = JSON.parse(readFileSync(new URL("contract.json", import.meta.url)));
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const equal = isDeepStrictEqual;
const utc = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const lines = text => text.trim().split("\n").filter(Boolean);
const objects = text => lines(text).map(line => JSON.parse(line));
const relevant = event => event.item?.type === "mcp_tool_call"
  && event.item.server === "github" && event.item.tool === "list_issues";
const argumentsValid = args => args?.owner === "github" && args.repo === "gh-aw"
  && args.state === "OPEN" && args.perPage === 3
  && equal(args.fields, ["number", "title", "state"]);
const unknown = reason => ({ status: "unknown", nativeAccess: null, filteredResources: null,
  upstreamIssues: null, agentIssueReadback: null, fullGoal: null, reason });

export function inspectNativeAccess({ protectedLog, stdio, session, rpc, githubLog, step }) {
  if (![protectedLog, stdio, session, rpc, githubLog].every(value => typeof value === "string")
    || !utc(step?.started_at) || !utc(step?.completed_at)) throw new Error("Malformed original Codex native inputs");
  const start = Date.parse(step.started_at), end = Date.parse(step.completed_at) + 1000;
  const protectedEvents = [];
  for (const line of lines(protectedLog)) {
    if (line.includes("\x1b")) continue;
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (\{"type":.*)\r?$/);
    if (!match || Date.parse(match[1]) < start || Date.parse(match[1]) >= end) continue;
    const event = JSON.parse(match[2]);
    if (relevant(event)) protectedEvents.push({ at: match[1], event });
  }
  const starts = protectedEvents.filter(row => row.event.type === "item.started");
  const finishes = protectedEvents.filter(row => row.event.type === "item.completed");
  if (starts.length !== 1 || finishes.length !== 1) return unknown("Missing or ambiguous protected native MCP invocation/result");
  const first = starts[0], last = finishes[0], input = first.event.item, output = last.event.item;
  if (epochNs(first.at) >= epochNs(last.at) || !input.id || input.id !== output.id || !argumentsValid(input.arguments)
    || !equal(input.arguments, output.arguments) || input.status !== "in_progress"
    || output.status !== "completed" || output.error !== null || !output.result || output.result.isError) {
    return unknown("Protected native call identity, arguments, chronology or non-error completion does not match");
  }
  const raw = lines(stdio).filter(line => line.startsWith('{"type":')).map(JSON.parse).filter(relevant);
  if (raw.length !== 2 || !equal(raw[0], first.event) || !equal(raw[1], last.event)) {
    return unknown("Artifact native events do not exactly match protected Codex stdout");
  }
  const normalized = objects(session).filter(relevant);
  if (normalized.length !== 2 || normalized[0].type !== "tool.execution_start"
    || normalized[1].type !== "tool.execution_complete"
    || !equal(normalized[0].item, input) || !equal(normalized[1].item, output)
    || normalized.some(row => row.data?.toolCallId !== input.id || row.data.mcpServerName !== "github"
      || row.data.toolName !== "list_issues" || !equal(row.data.input, input.arguments))
    || normalized[1].data.success !== true || !equal(normalized[1].data.output, output.result)) {
    return unknown("Normalized native session does not preserve exact call/result identity");
  }
  const configured = lines(githubLog).filter(line =>
    /^\[\d{4}-.*\] \[INFO\] \[backend\] Configuring HTTP MCP backend: github, url=https:\/\/api\.githubcopilot\.com\/mcp\/$/.test(line));
  if (configured.length !== 1) return unknown("Official remote GitHub MCP backend not independently captured");
  const records = objects(rpc), exchanges = [];
  if (records.some(row => !utc(row.timestamp))) return unknown("Malformed native gateway clock");
  let pending = null;
  for (const row of records.filter(row => row.server_id === "github"
    && Date.parse(row.timestamp) >= start && Date.parse(row.timestamp) < end)) {
    if (row.event === "rpc_request") {
      if (pending || row._schema !== "rpc-message/v2" || row.direction !== "OUT") {
        return unknown("Gateway exchange is overlapping or unsupported; no invented request-ID join");
      }
      pending = row;
    } else if (row.event === "rpc_response") {
      if (!pending || row._schema !== "rpc-message/v2" || row.direction !== "IN" || epochNs(row.timestamp) < epochNs(pending.timestamp)) {
        return unknown("Gateway response lacks one unique preceding request");
      }
      exchanges.push({ request: pending, response: row });
      pending = null;
    }
  }
  if (pending) return unknown("Gateway exchange is incomplete");
  const selected = exchanges.filter(row => row.request.method === "tools/call"
    && row.request.payload?.params?.name === "list_issues");
  if (selected.length !== 1) return unknown("Native call cannot be uniquely corroborated by the gateway exchange");
  const { request, response } = selected[0];
  if (!argumentsValid(request.payload.params.arguments) || !equal(request.payload.params.arguments, input.arguments)
    || epochNs(request.timestamp) < epochNs(first.at) || epochNs(response.timestamp) > epochNs(last.at) || response.payload?.error
    || response.payload?.result?.isError || !Array.isArray(response.payload?.result?.content)) {
    return unknown("Gateway/native arguments, interval or result do not agree");
  }
  const content = response.payload.result.content.filter(row => row.type === "text");
  if (content.length !== 1) return unknown("Unsupported upstream issue result structure");
  const upstream = JSON.parse(content[0].text);
  if (!Array.isArray(upstream.issues) || upstream.issues.length !== 3
    || upstream.issues.some(row => !Number.isSafeInteger(row.number) || row.number <= 0
      || row.state !== "OPEN" || typeof row.title !== "string" || !row.title.trim())
    || new Set(upstream.issues.map(row => row.number)).size !== 3) return unknown("Upstream native three-open-issue result not established");
  const filtered = records.filter(row => row.event === "difc_filtered" && row.server_id === "github" && row.tool_name === "list_issues");
  const ids = upstream.issues.map(row => row.number).sort((a, b) => a - b);
  if (filtered.length !== 3 || filtered.some(row => row._schema !== "difc-filtered/v2"
    || epochNs(row.timestamp) < epochNs(response.timestamp) || epochNs(row.timestamp) > epochNs(last.at)
    || row.description !== `issue:github/gh-aw#${row.number}`
    || !row.reason?.includes('below "approved"') || !row.integrity_tags?.includes("unapproved:public"))
    || !equal(filtered.map(row => Number(row.number)).sort((a, b) => a - b), ids)) {
    return unknown("Original integrity-policy resource witnesses do not match the upstream response");
  }
  const delivered = output.result.content;
  if (!Array.isArray(delivered) || delivered.length !== 2 || delivered[0].type !== "text" || delivered[0].text !== "[]"
    || delivered[1].type !== "text" || !delivered[1].text.startsWith("[Filtered] 3 item(s) in this response were removed by integrity policy")
    || !equal([...new Set([...delivered[1].text.matchAll(/issue:github\/gh-aw#(\d+)/g)].map(match => Number(match[1])))]
      .sort((a, b) => a - b), ids)) return unknown("Native result delivered to Codex does not independently witness the same three filtered resources");
  return { status: "accepted", nativeAccess: 1, filteredResources: 3, upstreamIssues: 3,
    agentIssueReadback: null, fullGoal: null, callId: input.id, issueIds: ids,
    startedAt: first.at, completedAt: last.at, reason: null,
    correlation: "Exact protected/native call ID plus one unique sequential gateway exchange with matching arguments and enclosing interval; gateway request records omit IDs",
    sourceEra: "Historical source required issue titles; modern expected-filter treatment is not backdated into full historical acceptance" };
}

let retained;
export function nativeCases() {
  if (retained) return retained;
  const packet = readJsonArchive(fileURLToPath(new URL("originals.json.gz", import.meta.url)),
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  if (packet.contractSha256 !== hash(readFileSync(new URL("contract.json", import.meta.url)))) throw new Error("Codex MCP original contract changed");
  const receipts = new Map();
  for (const row of packet.receipts) {
    const bytes = Buffer.from(row.bodyBase64, "base64");
    if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes || receipts.has(row.endpoint)
      || ![200, 404, 410].includes(row.status)) throw new Error("Codex MCP original custody changed");
    receipts.set(row.endpoint, { bytes, status: row.status });
  }
  const prefix = `repos/${contract.repository}`, workflowPath = `.github/workflows/${contract.workflow}`;
  const get = endpoint => {
    const row = receipts.get(endpoint);
    if (!row || row.status !== 200) throw new Error(`Required Codex MCP original unavailable: ${endpoint}`);
    return row.bytes;
  };
  const json = endpoint => JSON.parse(get(endpoint));
  const repository = json(prefix);
  if (repository.id !== contract.repositoryId || repository.private !== false || repository.visibility !== "public"
    || repository.full_name !== contract.repository) throw new Error("Codex MCP public repository authority mismatch");
  const source = (revision, extension) => {
    const row = json(`${prefix}/contents/${workflowPath}.${extension}?ref=${revision}`);
    const bytes = Buffer.from(row.content, "base64");
    if (row.encoding !== "base64" || row.size !== bytes.length || row.path !== `${workflowPath}.${extension}`
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== row.sha) throw new Error("Codex MCP immutable source blob mismatch");
    return { blob: row.sha, text: bytes.toString("utf8") };
  };
  const history = json(`${prefix}/commits?path=${workflowPath}.md&sha=${contract.revision}&per_page=100`);
  if (!history.length || history.length >= 100) throw new Error("Codex MCP source history incomplete");
  const introduction = json(`${prefix}/git/commits/${history.at(-1).sha}`);
  if (introduction.parents.length !== 1) throw new Error("Codex MCP source introduction parent ambiguous");
  const parent = json(`${prefix}/git/commits/${introduction.parents[0].sha}`);
  const added = [introduction, parent].map(commit => {
    const tree = json(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated !== false || tree.sha !== commit.tree.sha) throw new Error("Codex MCP introduction tree incomplete");
    return tree.tree.filter(row => row.path === `${workflowPath}.md`);
  });
  if (added[0].length !== 1 || added[0][0].type !== "blob" || added[1].length) throw new Error("Codex MCP first addition not proved");
  const inventory = json(`${prefix}/actions/workflows/${contract.workflow}.lock.yml/runs?per_page=100&created=%3C2026-10-18T15%3A00%3A12Z`);
  if (inventory.total_count !== inventory.workflow_runs.length
    || !equal(inventory.workflow_runs.map(row => row.id), contract.selection.runIds)) throw new Error("Codex MCP opportunity population changed");
  const cases = contract.selection.runIds.map(id => {
    const run = json(`${prefix}/actions/runs/${id}/attempts/1`);
    if (run.id !== id || run.run_attempt !== 1 || run.repository?.id !== contract.repositoryId
      || run.path !== `${workflowPath}.lock.yml` || run.created_at >= contract.cutoff) throw new Error("Codex MCP run identity mismatch");
    const editable = source(run.head_sha, "md"), compiled = source(run.head_sha, "lock.yml");
    const jobs = json(`${prefix}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
    const artifacts = json(`${prefix}/actions/runs/${id}/artifacts?per_page=100`);
    if (jobs.total_count !== jobs.jobs.length || artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete native Codex metadata page");
    const agents = jobs.jobs.filter(row => row.name === "agent");
    const base = { id: String(id), attempt: 1, at: run.updated_at, event: run.event,
      headSha: run.head_sha, editableBlob: editable.blob, compiledBlob: compiled.blob };
    if (!agents.length) return { ...base, ...unknown("No retained original agent job or native execution result") };
    if (agents.length !== 1 || agents[0].run_id !== id || agents[0].run_attempt !== 1) throw new Error("Codex MCP original agent job ambiguous");
    const job = agents[0], steps = job.steps.filter(row => row.name === "Execute Codex CLI");
    const candidates = artifacts.artifacts.filter(row => row.name === "agent" && !row.expired);
    if (steps.length !== 1 || candidates.length !== 1) return { ...base, ...unknown("Protected Codex execution step or original agent artifact unavailable") };
    const artifact = candidates[0], bytes = get(`${prefix}/actions/artifacts/${artifact.id}/zip`);
    if (artifact.workflow_run?.id !== id || artifact.size_in_bytes !== bytes.length
      || artifact.digest !== `sha256:${hash(bytes)}`) throw new Error("Codex native artifact provider identity/digest mismatch");
    if (!/^engine: codex$/m.test(editable.text) || !/^    mode: remote$/m.test(editable.text)
      || !editable.text.includes("listing 3 open issues") || !compiled.text.includes('"url": "https://api.githubcopilot.com/mcp/"')
      || !compiled.text.includes("- name: Start MCP Gateway") || !compiled.text.includes("- name: Stop MCP Gateway")) {
      throw new Error("Executed Codex remote-MCP goal/backend profile unsupported");
    }
    const files = readZip(bytes), member = name => {
      const value = files.get(name);
      if (!value) throw new Error(`Required original Codex artifact member missing: ${name}`);
      return value.toString("utf8");
    };
    const execution = JSON.parse(member("agent_execution.json"));
    if (execution.run_id !== id || execution.run_attempt !== 1 || execution.component !== "agent") throw new Error("Codex native artifact execution identity mismatch");
    const result = inspectNativeAccess({ protectedLog: get(`${prefix}/actions/jobs/${job.id}/logs`).toString("utf8"),
      stdio: member("agent-stdio.log"), session: member("agent-session.jsonl"), rpc: member("mcp-logs/rpc-messages.jsonl"),
      githubLog: member("mcp-logs/github.log"), step: steps[0] });
    return { ...base, at: job.completed_at, jobId: job.id, artifactId: artifact.id,
      historicalFilterAcceptanceDeclared: editable.text.includes("expected policy result"), ...result };
  });
  retained = { adoption: { commit: introduction.sha, adoptedAt: introduction.committer.date,
    baselineCommit: null, baselineAt: null }, cases };
  return retained;
}
