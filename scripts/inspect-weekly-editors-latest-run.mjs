import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/weekly-editors-health-check";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const packets = Object.fromEntries(["artifacts", "jobs", "logs"].map(name => {
  const packet = readJsonArchive(`${root}/latest-run-${name}.json`);
  const bytes = Buffer.from(packet.originalBody, "base64");
  if (packet.receipt.name !== name || packet.receipt.status !== 200 || packet.receipt.refusal
    || bytes.toString("base64") !== packet.originalBody || bytes.length !== packet.receipt.bodyBytes
    || hash(bytes) !== packet.receipt.bodySha256) throw new Error("Latest run provider packet integrity mismatch");
  return [name, { ...packet, bytes }];
}));
const inventory = JSON.parse(packets.artifacts.bytes);
const jobs = JSON.parse(packets.jobs.bytes);
const head = "d3915e4a21040c00a6e11e1acb0aac42605abc4c";
if (inventory.total_count !== inventory.artifacts.length || packets.artifacts.receipt.headers.link
  || jobs.total_count !== jobs.jobs.length || packets.jobs.receipt.headers.link) {
  throw new Error("Incomplete original artifact/job discovery");
}
for (const artifact of inventory.artifacts) {
  if (artifact.workflow_run?.id !== 39014584632 || artifact.workflow_run.repository_id !== 1036865607
    || artifact.workflow_run.head_sha !== head || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    || artifact.archive_download_url !== `https://api.github.com/repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`) {
    throw new Error("Original artifact producer identity mismatch");
  }
}
for (const job of jobs.jobs) {
  if (job.run_id !== 39014584632 || job.run_attempt !== 1 || job.head_sha !== head) {
    throw new Error("Original job attempt/head mismatch");
  }
}
const agent = jobs.jobs.find(job => job.name === "agent");
if (agent?.id !== 117344046063) throw new Error("Unexpected original agent producer");
mkdirSync(".tmp", { recursive: true });
const temporary = mkdtempSync(path.resolve(".tmp/weekly-editors-log-"));
try {
  const zip = path.join(temporary, "original.zip");
  writeFileSync(zip, packets.logs.bytes);
  const names = execFileSync("unzip", ["-Z", "-1", zip], { encoding: "utf8", maxBuffer: 65536 }).trim().split("\n");
  if (names.length > 128 || new Set(names).size !== names.length
    || names.some(name => name.startsWith("/") || name.split("/").includes(".."))) throw new Error("Unsafe original ZIP inventory");
  const entries = names.map(name => {
    const bytes = execFileSync("unzip", ["-p", zip, name], { maxBuffer: 2 * 1024 * 1024 });
    return { name, bytes: bytes.length, sha256: hash(bytes), text: bytes.toString("utf8") };
  });
  if (entries.reduce((sum, entry) => sum + entry.bytes, 0) > 8 * 1024 * 1024) throw new Error("Original log scope budget exceeded");
  const agentLog = entries.find(entry => entry.name === "4_agent.txt");
  if (!agentLog) throw new Error("Original agent log absent");
  const events = agentLog.text.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(\S+) (\{.*\})$/);
    if (!match) return [];
    let event;
    try { event = JSON.parse(match[2]); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
    return [{ line: index + 1, emittedAt: match[1], event }];
  });
  const starts = events.filter(row => row.event.type === "tool.execution_start");
  const toolCalls = starts.map(row => {
    const start = row.event;
    const completions = events.filter(candidate => candidate.event.type === "tool.execution_complete"
      && candidate.event.data.toolCallId === start.data.toolCallId);
    if (completions.length !== 1) throw new Error("Ambiguous original tool call completion");
    const end = completions[0];
    if (Date.parse(row.emittedAt) < Date.parse(agent.started_at)
      || Date.parse(end.emittedAt) > Date.parse(agent.completed_at)
      || Date.parse(end.emittedAt) < Date.parse(row.emittedAt)) throw new Error("Original tool execution outside producer job");
    return {
      toolCallId: start.data.toolCallId, toolName: start.data.toolName, arguments: start.data.arguments,
      startLine: row.line, completionLine: end.line, startedAt: row.emittedAt, completedAt: end.emittedAt,
      success: end.event.data.success, error: end.event.data.error ?? null,
      resultContent: end.event.data.result?.content ?? null,
      originalStart: start, originalCompletion: end.event,
    };
  });
  const httpRequests = toolCalls.filter(call => ["web_fetch", "web-fetch", "browser_navigate"].includes(call.toolName)
    || (call.toolName === "bash" && /^\s*curl(?:\s|$)/.test(call.arguments?.command ?? "")));
  const protectedDenials = toolCalls.filter(call => call.error?.code === "denied");
  const viewedInventory = toolCalls.find(call => call.toolName === "view" && call.success === true)?.resultContent;
  const inventoryBytes = viewedInventory ? Buffer.from(viewedInventory) : null;
  const actualInventory = readJsonArchive(`${root}/investigation.json`).sources
    .find(source => source.path === "docs/src/content/docs/reference/editors.mdx");
  if (!inventoryBytes || hash(inventoryBytes) !== actualInventory.sha256) throw new Error("Producer-viewed editor inventory mismatch");
  const report = {
    schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607, workflow: "weekly-editors-health-check",
    runId: 39014584632, attempt: 1, headSha: head, producerJob: {
      id: agent.id, name: agent.name, startedAt: agent.started_at, completedAt: agent.completed_at,
    },
    acquisition: Object.fromEntries(Object.entries(packets).map(([name, packet]) => [name, packet.receipt])),
    artifacts: inventory.artifacts, artifactPagination: { total: inventory.total_count, returned: inventory.artifacts.length, link: null },
    jobs: jobs.jobs.map(({ id, name, run_id, run_attempt, head_sha, started_at, completed_at, status, conclusion }) =>
      ({ id, name, run_id, run_attempt, head_sha, started_at, completed_at, status, conclusion })),
    jobPagination: { total: jobs.total_count, returned: jobs.jobs.length, link: null },
    zip: { sha256: hash(packets.logs.bytes), bytes: packets.logs.bytes.length,
      entries: entries.map(({ text: _text, ...entry }) => entry) },
    originalAgentEvents: { source: "4_agent.txt", sha256: agentLog.sha256, parsedEvents: events.length, toolCalls },
    observedEditorInventory: { blob: actualInventory.blob, sha256: hash(inventoryBytes), matchedImmutableInventory: true },
    inspection: {
      originalToolCalls: toolCalls.length, originalHttpToolCalls: httpRequests.length,
      protectedPermissionDenials: protectedDenials.length,
      specificDeniedCommand: protectedDenials[0]?.arguments?.command ?? null,
      conclusion: "No actual editor HTTP GET was invoked in this producer trace. Missing instrumentation, not failed editor reachability.",
      claimVsFact: "Agent narrative says curl/Playwright were blocked; the protected denial is for a compound cat/command-v invocation. It is not evidence an actual curl probe ran and failed.",
      excludedStatus200: "HTTP 200 in safeoutputs bridge logs belongs to internal safe-output RPC, not any editor URL.",
    },
    nativeEvidence: { originalEditorHttpReceipts: 0, eligibleEditorCount: 3, availableEditorCount: null,
      failedEditorCount: null, availabilityPercent: null, fullGoalAcceptance: "not measured", contribution: "not measured" },
    frozenFunction: { sha256: "1accbcef17c6392a0b0163807914515c25b4172ad41c30457db4fa3ad5c4ce21", changed: false },
    nextEvidence: {
      authorization: "not released",
      corroborationOnly: inventory.artifacts.filter(artifact => ["agent", "info"].includes(artifact.name))
        .map(artifact => ({ id: artifact.id, name: artifact.name, digest: artifact.digest,
          endpoint: `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`,
          role: artifact.name === "agent" ? "Original session trace corroboration; no HTTP request is implied." : "Producer/source metadata corroboration only." })),
      remainder: "Other 78 discovered runs retain pending original producer receipt scope; no further acquisition was performed.",
    },
  };
  writeJsonArchive(`${root}/latest-run-inspection.json`, report);
  console.log(JSON.stringify({ inspection: report.inspection, nativeEvidence: report.nativeEvidence, next: report.nextEvidence }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
