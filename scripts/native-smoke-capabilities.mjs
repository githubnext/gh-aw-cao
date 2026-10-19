import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOriginal, sourceReader, sha256 } from "./native-smoke-copilot-small.mjs";
import { readZip } from "./native-smoke-pydantic.mjs";

export const proofRoot = fileURLToPath(new URL("../docs/operational-value/proof/native-smoke-capabilities/", import.meta.url));
export const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const engines = { claude: "Claude", gemini: "Gemini", kiro: "Kiro", opencode: "OpenCode", cursor: "Cursor", crush: "Crush" };
const ids = ["capabilities", "expandedReadback", "literalReadback", "writeReadback", "build", "fullAcceptance"];

export function zipMember(bytes, mode) {
  if (!["protected", "stdio"].includes(mode)) throw new Error("Unknown archive selection");
  const files = readZip(bytes);
  const names = [...files.keys()].filter(name => mode === "protected"
    ? /^[0-9]+_agent\.txt$/i.test(name) : name === "agent-stdio.log");
  if (names.length > 1) throw new Error("Ambiguous native archive member");
  if (!names.length) return { status: "missing", text: null };
  const content = files.get(names[0]);
  if (content.length > 32 * 1024 * 1024) throw new Error("Native member exceeds bound");
  return { status: "retained", path: names[0], text: content.toString("utf8") };
}

export function nativeEvents(log, bounds) {
  const events = [];
  for (const [index, line] of log.split("\n").entries()) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) (\{.*\})\r?$/);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[2]); }
    catch (error) {
      if (/"type"\s*:\s*"(?:assistant|user|tool_use|tool_call|tool_result)"/.test(match[2])) {
        throw new Error(`Malformed native provider event: ${error.message}`);
      }
      continue;
    }
    if (!["assistant", "user", "tool_use", "tool_call", "tool_result"].includes(value.type)) continue;
    const time = new Date(match[1]).getTime();
    if (!Number.isFinite(time) || time < Date.parse(bounds.start) || time > Date.parse(bounds.end) + 1000) {
      throw new Error("Native event outside original protected job");
    }
    events.push({ value, at: new Date(time).toISOString(), line: index + 1 });
  }
  return events;
}

export function decodeExecutions(engine, events) {
  const starts = new Map(), executions = [], seen = new Set(), sessions = new Set();
  const add = row => {
    if (!row.id || seen.has(row.id)) throw new Error("Duplicate native execution identity");
    seen.add(row.id);
    if (Date.parse(row.at) < Date.parse(row.startedAt)) throw new Error("Native completion precedes start");
    executions.push(row);
  };
  for (const { value: event, at, line } of events) {
    if (engine === "claude") {
      const blocks = event.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === "tool_use" && event.type === "assistant" && block.name === "Bash") {
          if (starts.has(block.id)) throw new Error("Duplicate Claude call start");
          starts.set(block.id, { block, at, line, session: event.session_id });
          sessions.add(event.session_id);
        }
        if (event.type !== "user" || block.type !== "tool_result" || !starts.has(block.tool_use_id)) continue;
        const start = starts.get(block.tool_use_id), result = event.tool_use_result;
        if (event.session_id !== start.session) throw new Error("Claude cross-session completion");
        if (typeof result?.stdout !== "string" || typeof result?.stderr !== "string"
          || typeof block.content !== "string" || !block.content.includes(result.stdout)) continue;
        add({ id: block.tool_use_id, tool: "bash", command: start.block.input?.command,
          output: result.stdout, stderr: result.stderr,
          success: block.is_error === false && result.interrupted === false,
          at, startedAt: start.at, startLine: start.line, endLine: line, session: start.session });
      }
    }
    if (engine === "opencode" && event.type === "tool_use" && event.part?.type === "tool") {
      const part = event.part, state = part.state;
      if (!["bash", "write"].includes(part.tool) || state?.status !== "completed") continue;
      if (part.sessionID !== event.sessionID || !Number.isFinite(state.time?.start)
        || !Number.isFinite(state.time?.end) || state.time.end < state.time.start
        || Math.abs(Date.parse(at) - state.time.end) > 60000) throw new Error("Invalid OpenCode native identity/time");
      sessions.add(event.sessionID);
      add({ id: part.callID, tool: part.tool, command: state.input?.command,
        file: state.input?.filePath, content: state.input?.content,
        output: state.output, stderr: "",
        success: part.tool === "bash" ? state.metadata?.exit === 0 && state.metadata?.truncated === false
          && state.metadata?.output === state.output : state.metadata?.truncated === false
          && state.metadata?.filepath === state.input?.filePath && state.output === "Wrote file successfully.",
        at: new Date(state.time.end).toISOString(), startedAt: new Date(state.time.start).toISOString(),
        startLine: line, endLine: line, session: event.sessionID });
    }
    if (engine === "cursor" && event.type === "tool_call" && event.tool_call?.shellToolCall) {
      sessions.add(event.session_id);
      if (event.subtype === "started" && event.tool_call?.shellToolCall) {
        if (starts.has(event.call_id)) throw new Error("Duplicate Cursor call start");
        starts.set(event.call_id, { event, at, line });
      }
      if (event.subtype !== "completed" || !event.tool_call?.shellToolCall) continue;
      const start = starts.get(event.call_id), call = event.tool_call.shellToolCall, result = call.result?.success;
      if (!start || start.event.session_id !== event.session_id
        || start.event.tool_call.shellToolCall.args.command !== call.args?.command) throw new Error("Cursor completion lacks matching start");
      if (!result || result.command !== call.args.command || typeof result.stdout !== "string"
        || typeof result.stderr !== "string") continue;
      const background = result.backgroundReason;
      const pending = background ? { taskId: String(result.shellId), backgroundReason: background } : null;
      add({ id: event.call_id, tool: "bash", command: call.args.command, output: result.stdout, stderr: result.stderr,
        success: result.exitCode === 0, pending, at, startedAt: start.at,
        startLine: start.line, endLine: line, session: event.session_id });
    }
    if (engine === "cursor" && event.type === "tool_call" && event.subtype === "completed"
      && event.tool_call?.awaitToolCall) {
      const call = event.tool_call.awaitToolCall, complete = call.result?.success?.complete;
      if (!complete || String(complete.taskId) !== String(call.args?.taskId)) continue;
      const prior = executions.filter(row => row.pending?.taskId === String(complete.taskId) && row.session === event.session_id);
      if (prior.length !== 1 || Date.parse(at) < Date.parse(prior[0].at)) throw new Error("Cursor async completion lacks unique task");
      prior[0].asyncCompletion = { at, line, exitCode: complete.exitCode };
    }
  }
  if (sessions.size > 1 || sessions.has(undefined)) throw new Error("Ambiguous native provider session");
  return executions;
}

export function inspectExecution(engine, runId, execution) {
  const result = { expandedReadback: null, literalReadback: null, writeReadback: null, build: null };
  if (execution.tool !== "bash" || typeof execution.command !== "string" || typeof execution.output !== "string") return result;
  const prefix = `Smoke test passed for ${engines[engine]} at `;
  const file = `/tmp/gh-aw/agent/smoke-test-${engine}-${runId}.txt`;
  const command = execution.command.trim(), output = execution.output.replace(/\r\n/g, "\n");
  const read = `cat ${file}`;
  const write = `mkdir -p /tmp/gh-aw/agent && echo "${prefix}$(date)" > ${file} && ${read}`;
  const make = "GOCACHE=/tmp/gh-aw/agent/go-cache GOMODCACHE=/tmp/gh-aw/agent/go-mod make build";
  const compound = command === `${write} && ${make}`;
  const knownRead = command === read || command === write || compound;
  const successfulRead = execution.success && knownRead;
  if (successfulRead) {
    const line = output.split("\n")[0];
    result.literalReadback = false;
    result.expandedReadback = false;
    if (line.startsWith(prefix) && (compound || output.replace(/\n$/, "") === line)) {
      const suffix = line.slice(prefix.length);
      result.literalReadback = line === `${prefix}$(date)`;
      result.expandedReadback = !result.literalReadback && /^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d\d:\d\d:\d\d [A-Z]+ \d{4}$/.test(suffix)
        && Number.isFinite(Date.parse(suffix))
        && Math.abs(Date.parse(suffix) - Date.parse(execution.at)) <= 3600000;
      if ((command === write || compound) && result.expandedReadback) result.writeReadback = true;
    }
  }
  const makeCommand = command === make || compound;
  const completed = !execution.pending || execution.asyncCompletion;
  const buildExit = execution.asyncCompletion ? execution.asyncCompletion.exitCode : execution.success ? 0 : 1;
  if (makeCommand && completed) {
    const native = `${output}\n${execution.stderr ?? ""}`;
    result.build = buildExit === 0 && /^go build .* -o gh-aw \.\/cmd\/gh-aw$/m.test(native)
      && !/^make: \*\*\*|^go: .*failed|^error:/m.test(native);
  }
  return result;
}

export function assessRun(run, jobs, log, source, compiled) {
  const workflow = run.path?.match(/^\.github\/workflows\/(smoke-(?:claude|gemini|kiro|opencode|cursor|crush))\.lock\.yml$/)?.[1];
  if (!workflow || run.repository?.id !== 1036865607 || run.repository?.full_name !== "github/gh-aw"
    || run.repository?.private !== false || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)
    || jobs.total_count !== jobs.jobs?.length) throw new Error("Original run identity mismatch");
  const agent = jobs.jobs.filter(row => /^agent$/i.test(row.name));
  if (agent.length !== 1 || agent[0].run_id !== run.id || agent[0].head_sha !== run.head_sha
    || agent[0].run_attempt !== run.run_attempt) throw new Error("Original protected job identity mismatch");
  const engine = workflow.slice(6), title = engines[engine];
  const row = { workflow, runId: run.id, attempt: run.run_attempt, head: run.head_sha, jobId: agent[0].id,
    at: agent[0].completed_at, expandedReadback: null, literalReadback: null, writeReadback: null, build: null,
    fullAcceptance: null, native: [], rejections: [], gap: null };
  if (!source?.includes(`/tmp/gh-aw/agent/smoke-test-${engine}-\${{ github.run_id }}.txt`)
    || !source.includes(`Smoke test passed for ${title} at $(date)`)
    || !compiled?.includes(`Execute ${engine === "claude" ? "Claude Code" : engine === "cursor" ? "Cursor Agent" : title} CLI`)
    || /\n\s+command:\s*\|/.test(source)) return { ...row, gap: "Exact-head source/compiled native contract incompatible or unavailable" };
  if (log === null) return { ...row, gap: "Protected agent log absent; no native observation" };
  const events = nativeEvents(log, { start: agent[0].started_at, end: agent[0].completed_at });
  const executions = decodeExecutions(engine, events);
  for (const execution of executions) {
    const facets = inspectExecution(engine, run.id, execution);
    if (Object.values(facets).every(value => value === null)) continue;
    if (facets.literalReadback === true && engine === "opencode") {
      const writes = executions.filter(write => write.tool === "write" && write.success
        && write.file === `/tmp/gh-aw/agent/smoke-test-${engine}-${run.id}.txt`
        && write.content === execution.output.replace(/\n$/, "")
        && Date.parse(write.at) <= Date.parse(execution.startedAt));
      if (writes.length) facets.writeReadback = true;
    }
    row.native.push({ id: execution.id, session: execution.session, at: execution.asyncCompletion?.at ?? execution.at,
      startLine: execution.startLine, endLine: execution.endLine, commandSha256: sha256(execution.command),
      stdoutSha256: sha256(execution.output), stdoutBytes: Buffer.byteLength(execution.output),
      facets, asyncCompletion: execution.asyncCompletion ?? null });
  }
  for (const id of ids.slice(1, -1)) {
    const known = row.native.filter(native => native.facets[id] !== null);
    row[id] = known.length ? known.some(native => native.facets[id]) : null;
  }
  if (row.build === false) { row.fullAcceptance = false; row.rejections.push("Native source-required make build failed"); }
  if (row.literalReadback === true && row.expandedReadback !== true) row.rejections.push("Literal $(date) readback is not expanded-date acceptance");
  if (!row.native.length) {
    row.gap = engine === "kiro" ? "Native transcript omits returned bytes and shared call IDs; command/completion/prose cannot establish operation effects"
      : engine === "gemini" ? "No source-required native operation receipt retained; setup/authentication failure or missing structured capture"
        : engine === "crush" ? "No independently captured source-required tool effects in retained transcript"
          : "No source-matched native effect in retained transcript";
  }
  return row;
}

export function loadNative(root = proofRoot) {
  const packet = readJson(path.join(root, "acquisition.json")), sources = sourceReader(root);
  const receipts = packet.requests;
  const body = row => {
    const bytes = readOriginal(root, row.original);
    if (sha256(bytes) !== row.bodySha256 || row.status !== 200) throw new Error("Provider custody mismatch");
    return bytes;
  };
  const authority = JSON.parse(body(receipts.find(row => row.endpoint === "repos/github/gh-aw")));
  if (authority.id !== 1036865607 || authority.private !== false || authority.full_name !== "github/gh-aw") throw new Error("Public authority mismatch");
  const resolve = (workflow, head, file) => {
    const profile = sources.inventory.profiles.find(row => row.workflow === workflow && row.commit === head);
    const entry = profile?.paths[file];
    if (!entry || entry.status !== "retained") return null;
    if (entry.resolutionEndpoint) {
      const endpoint = `repos/github/gh-aw/contents/${file}?ref=${head}`;
      if (entry.resolutionEndpoint !== endpoint) throw new Error("Immutable content resolution mismatch");
      const data = JSON.parse(body(receipts.find(row => row.endpoint === endpoint)));
      if (data.sha !== entry.id || data.path !== file) throw new Error("Provider immutable source resolution mismatch");
      const bytes = sources.object(entry.id, "blob");
      if (!bytes || !bytes.equals(Buffer.from(data.content, "base64"))) throw new Error("Provider source content mismatch");
      return bytes.toString();
    }
    const resolved = sources.resolve(head, file);
    if (resolved.status !== "retained" || resolved.id !== entry.id) throw new Error("Source tree resolution mismatch");
    return resolved.content;
  };
  const runs = receipts.filter(row => /^repos\/github\/gh-aw\/actions\/runs\/\d+$/.test(row.endpoint));
  const identities = new Set();
  return runs.map(receipt => {
    const run = JSON.parse(body(receipt)), base = `${receipt.endpoint}/attempts/${run.run_attempt}`;
    if (identities.has(`${run.id}/${run.run_attempt}`)) throw new Error("Duplicate original attempt");
    identities.add(`${run.id}/${run.run_attempt}`);
    const jobs = JSON.parse(body(receipts.find(row => row.endpoint === `${base}/jobs?per_page=100`)));
    const logReceipt = receipts.find(row => row.endpoint === `${base}/logs`);
    const log = zipMember(body(logReceipt), "protected");
    return assessRun(run, jobs, log.text, resolve(receipt.workflow, run.head_sha, `.github/workflows/${receipt.workflow}.md`),
      resolve(receipt.workflow, run.head_sha, `.github/workflows/${receipt.workflow}.lock.yml`));
  });
}

export function capabilityModule(workflow, pins) {
  const relative = {
    interpreter: "scripts/native-smoke-capabilities.mjs",
    custody: "scripts/native-smoke-copilot-small.mjs",
    zip: "scripts/native-smoke-pydantic.mjs",
    zipDependency: "scripts/collect-smoke-pydantic.mjs",
    acceptance: "docs/operational-value/proof/native-smoke-capabilities/acceptance.json",
    extension: "docs/operational-value/proof/native-smoke-capabilities/partial-extension.json",
    sources: "docs/operational-value/proof/native-smoke-capabilities/sources.json",
    acquisition: "docs/operational-value/proof/native-smoke-capabilities/acquisition.json",
  };
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const [key, file] of Object.entries(relative)) if (sha256(readFileSync(path.join(repositoryRoot, file))) !== pins[key]) {
    throw new Error(`Frozen capability dependency changed: ${key}`);
  }
  const sources = readJson(path.join(proofRoot, "sources.json"));
  if (!sources.adoptions[workflow]) throw new Error("Unknown native capability workflow");
  const metric = (id, name, role) => ({ id, name, role, direction: "increase", unit: "capability proofs",
    formula: id === "capabilities" ? "Distinct dated-or-literal file readback facets plus actual completed builds, once per original attempt; native partial subset only"
      : `Distinct original attempts with independently verified ${id}; unknown attempts do not become zero`,
    presentation: { name, legendLabel: name.slice(0, 24), transform: "identity" } });
  const definition = {
    schemaVersion: 3, slug: workflow, repository: "github/gh-aw", workflowName: `${workflow} native capability facets`,
    sourcePath: `.github/workflows/${workflow}.md`,
    intent: { goal: "Exercise actual source-required native engine operations, not produce PASS reports",
      acceptance: "Source-bound provider-native invocation/completion and independently returned bytes; partial filesystem/build proof, full original requirements preserved separately",
      temporalAnchor: "workflow-adoption" },
    adoption: sources.adoptions[workflow], evaluation: { mode: "attainment-only" },
    evidence: { key: "native-smoke-capabilities-v2", repositories: ["github/gh-aw"],
      opportunity: "Retained selected original run attempts, not all historical workflow activity",
      filters: ["Exact historical source/import profiles", "Original protected job identity/time", "Native arguments, completion and bytes", "No prose, success-job or output-existence acceptance"],
      collection: "Deterministic offline parsing of bounded original public Actions receipts and Git objects; no model calls or target code execution",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Freeze native source-derived contracts once; independently capture, deterministically collect/score/replay",
      recommendation: "Not rated: no agreed keep bar or measured costs; partial capability observations are not complete acceptance or current runtime certification",
      presentation: { label: "Native capability proofs", betterLabel: "More verified native facets" } },
    summary: { nativeLabel: "Source-defined native operation effects, retained subset" },
    metrics: [metric("capabilities", "Native capability facets", "primary"),
      metric("expandedReadback", "Expanded date readback", "diagnostic"), metric("literalReadback", "Literal template readback", "diagnostic"),
      metric("writeReadback", "File write and readback", "diagnostic"), metric("build", "Native completed builds", "diagnostic"),
      metric("fullAcceptance", "Full source acceptance", "diagnostic")],
    validationExamples: { targetAttained: Object.fromEntries([["valid", true], ...ids.map(id => [id, 1])]),
      targetMissed: Object.fromEntries([["valid", true], ...ids.map(id => [id, 0])]),
      missing: { valid: false }, malformed: { valid: true, capabilities: "PASS" } },
    implementation: { version: "native-smoke-capabilities-v2", authoring: "outcome-informed retrospective", pins,
      profiles: sources.profiles.filter(row => row.workflow === workflow), predecessor: "acceptance.json v1 remains unchanged",
      fullAcceptance: "Original GitHub MCP, web-fetch, runtime checks, imports and safe-output requirements are not replaced by partial facets" },
  };
  let facts;
  return { definition, scoreMetric(id, evidence) {
    if (!ids.includes(id) || evidence?.valid !== true) return null;
    const value = evidence[id];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }, collectBatch(requests) {
    if (!Array.isArray(requests)) throw new Error("Expected capability batch");
    facts ??= loadNative().filter(row => row.workflow === workflow);
    return requests.map(request => {
      const { windowStart, windowEnd, observedAt, repository = "github/gh-aw" } = request;
      if (repository !== "github/gh-aw" || ![windowStart, windowEnd, observedAt].every(value =>
        typeof value === "string" && Number.isFinite(Date.parse(value))) || Date.parse(windowStart) >= Date.parse(windowEnd)
        || Date.parse(observedAt) < Date.parse(windowEnd)) throw new Error("Invalid capability interval");
      const inside = at => at && Date.parse(at) >= Date.parse(windowStart) && Date.parse(at) < Date.parse(windowEnd);
      const native = facts.flatMap(row => row.native.map(facet => ({ ...facet, runId: row.runId, attempt: row.attempt }))).filter(row => inside(row.at));
      const relevant = facts.filter(row => inside(row.at) || row.native.some(item => inside(item.at)));
      const evidence = { valid: true, windowStart, windowEnd, observedAt, coverageStatus: "partial",
        costs: "not measured", acceptance: "partial native facets, not complete workflow acceptance", facts: relevant,
        missingReason: native.length ? "Retained source-bound subset only; unobserved attempts and full acceptance remain unknown"
          : "No independently captured native effects in this interval; unknown, not zero" };
      for (const id of ids.slice(1, -1)) {
        const attempts = new Map();
        for (const row of native) if (row.facets[id] !== null) {
          const key = `${row.runId}/${row.attempt}`;
          attempts.set(key, attempts.get(key) === true || row.facets[id] === true);
        }
        evidence[id] = attempts.size ? [...attempts.values()].filter(Boolean).length : null;
      }
      const proven = new Set();
      for (const row of native) {
        if (row.facets.expandedReadback === true || row.facets.literalReadback === true) proven.add(`${row.runId}/${row.attempt}/readback`);
        if (row.facets.build === true) proven.add(`${row.runId}/${row.attempt}/build`);
      }
      evidence.capabilities = native.length ? proven.size : null;
      const full = relevant.filter(row => row.fullAcceptance !== null);
      evidence.fullAcceptance = full.length ? full.filter(row => row.fullAcceptance).length : null;
      return { evidence, provenance: [{ repository, kind: "frozen-native-implementation", ref: `sha256:${pins.interpreter}` },
        { repository, kind: "original-provider-custody", ref: `sha256:${pins.acquisition}` },
        { repository, kind: "immutable-source-profiles", ref: `sha256:${pins.sources}` }], commit: sources.revision };
    });
  } };
}
