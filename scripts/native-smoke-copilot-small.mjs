import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const defaultRoot = new URL("../docs/operational-value/proof/smoke-copilot-small/", import.meta.url);
export const readJson = file => JSON.parse(readFileSync(file, "utf8"));

export function readOriginal(root, original) {
  if (!original || !Number.isSafeInteger(original.bytes) || original.bytes < 0
    || original.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(original.sha256)
    || !Array.isArray(original.parts) || !original.parts.length) throw new Error("Invalid original reference");
  const parts = original.parts.map(part => {
    if (!/^originals\/[a-f0-9]{64}-\d+\.gz$/.test(part.file)) throw new Error("Unsafe original part");
    const bytes = readFileSync(path.join(root, part.file));
    if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error("Original part custody mismatch");
    return gunzipSync(bytes, { maxOutputLength: 192 * 1024 });
  });
  const bytes = Buffer.concat(parts);
  if (bytes.length !== original.bytes || sha256(bytes) !== original.sha256) throw new Error("Original custody mismatch");
  return bytes;
}

export function sourceReader(root) {
  const inventory = readJson(path.join(root, "sources.json"));
  const objects = new Map(inventory.objects.map(row => [row.id, row]));
  const cache = new Map();
  const object = (id, type) => {
    if (cache.has(id)) return cache.get(id);
    const row = objects.get(id);
    if (!row) return null;
    if (row.type !== type) throw new Error("Git object type mismatch");
    const bytes = readOriginal(root, row.original);
    if (gitHash(type, bytes) !== id) throw new Error("Git object hash mismatch");
    cache.set(id, bytes);
    return bytes;
  };
  const resolve = (commit, file) => {
    if (!/^[a-f0-9]{40}$/.test(commit) || file.split("/").some(x => !x || x === ".." || x === ".")) {
      throw new Error("Unsafe source identity");
    }
    const bytes = object(commit, "commit");
    if (!bytes) return { status: "missing-commit" };
    let id = bytes.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
    if (!id) throw new Error("Invalid source commit");
    const parts = file.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const tree = object(id, "tree");
      if (!tree) return { status: "missing-tree" };
      let offset = 0, entry;
      while (offset < tree.length) {
        const space = tree.indexOf(32, offset), nul = tree.indexOf(0, space);
        if (space < 0 || nul < 0 || nul + 21 > tree.length) throw new Error("Malformed source tree");
        if (tree.subarray(space + 1, nul).toString() === parts[depth]) {
          entry = { mode: tree.subarray(offset, space).toString(), id: tree.subarray(nul + 1, nul + 21).toString("hex") };
        }
        offset = nul + 21;
      }
      if (!entry) return { status: "absent" };
      id = entry.id;
      if (depth < parts.length - 1 && entry.mode !== "40000") throw new Error("Invalid source tree mode");
      if (depth === parts.length - 1) {
        if (entry.mode !== "100644") throw new Error("Invalid source file mode");
        const content = object(id, "blob");
        return { status: content ? "retained" : "missing-blob", id, content: content?.toString() };
      }
    }
    throw new Error("Empty source path");
  };
  return { inventory, object, resolve };
}

export function readPacketReceipts(root) {
  const packets = readJson(path.join(root, "packets.json"));
  return packets.flatMap(packet => {
    const manifest = JSON.parse(readOriginal(root, packet.manifest));
    const originals = [...(manifest.requests ?? []), ...(manifest.receipts ?? [])]
      .filter(row => row && !Array.isArray(row) && typeof row === "object");
    const expected = originals.filter(row => row.workflow === "smoke-copilot-small");
    if (expected.length !== packet.receipts.length) throw new Error("Packet receipt count mismatch");
    return packet.receipts.map(row => {
      const { originals: refs, manifestIndex, ...receipt } = row;
      if (JSON.stringify(receipt) !== JSON.stringify(originals[manifestIndex])) throw new Error("Packet receipt alteration");
      const bodies = {};
      for (const [key, reference] of Object.entries(refs)) {
        const body = readOriginal(root, reference);
        const sizeKey = key === "file" ? "bytes" : key === "response" ? "bodyBytes" : "blobBytes";
        const hashKey = key === "file" ? "sha256" : key === "response" ? "bodySha256" : "blobSha256";
        if (body.length !== receipt[sizeKey] || sha256(body) !== receipt[hashKey]) throw new Error("Producer receipt custody mismatch");
        bodies[key] = body;
      }
      return { receipt, bodies };
    });
  });
}

export function readAgentLog(zip) {
  return execFileSync("python3", ["-c", [
    "import sys,zipfile,io,re",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "names=[n for n in z.namelist() if re.fullmatch(r'[0-9]+_agent\\.txt',n)]",
    "assert len(names)==1, 'Expected exactly one protected agent log'",
    "i=z.getinfo(names[0]); assert i.file_size <= 32*1024*1024, 'Agent log exceeds bound'",
    "sys.stdout.buffer.write(z.read(names[0]))",
  ].join("\n")], { input: zip, maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
}

export function readSession(zip) {
  return execFileSync("python3", ["-c", [
    "import sys,zipfile,io,re,json",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "names=[n for n in z.namelist() if re.fullmatch(r'sandbox/agent/logs/copilot-session-state/[a-f0-9-]+/events\\.jsonl',n)]",
    "assert len(names)==1, 'Expected exactly one native session'",
    "i=z.getinfo(names[0]); assert i.file_size <= 8*1024*1024, 'Native session exceeds bound'",
    "print(json.dumps({'path':names[0], 'events':z.read(names[0]).decode('utf-8')}))",
  ].join("\n")], { input: zip, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
}

export function typedExecutions(log, bounds) {
  const starts = new Map(), completions = new Map(), ids = new Set();
  for (const line of log.replace(/^\uFEFF/, "").split("\n")) {
    const match = line.match(/^(?:(\d{4}-\d\d-\d\dT[\d:.]+Z) )?(\{"type":.*\})\r?$/);
    if (!match) continue;
    let event;
    try { event = JSON.parse(match[2]); }
    catch (error) { throw new Error(`Malformed protected event: ${error.message}`); }
    if (!["tool.execution_start", "tool.execution_complete"].includes(event.type)) continue;
    if (typeof event.id !== "string" || ids.has(event.id) || typeof event.data?.toolCallId !== "string"
      || !Number.isFinite(Date.parse(event.timestamp))
      || (match[1] && Math.abs(Date.parse(match[1]) - Date.parse(event.timestamp)) > 60000)
      || Date.parse(event.timestamp) < Date.parse(bounds.start)
      || Date.parse(event.timestamp) > Date.parse(bounds.end)) throw new Error("Invalid protected execution identity/time");
    ids.add(event.id);
    const store = event.type === "tool.execution_start" ? starts : completions;
    if (store.has(event.data.toolCallId)) throw new Error("Conflicting protected execution identity");
    store.set(event.data.toolCallId, event);
  }
  return [...starts.entries()].filter(([, event]) => event.data.toolName === "bash").map(([id, start]) => {
    const end = completions.get(id);
    if (!end) return { id, command: start.data.arguments?.command, status: "missing-completion" };
    if (Date.parse(end.timestamp) < Date.parse(start.timestamp)) throw new Error("Execution completion precedes start");
    const exits = end.data.result?.contents?.filter(row => row.type === "shell_exit") ?? [];
    const content = end.data.result?.content;
    const trailer = typeof content === "string"
      ? content.match(/^([\s\S]*)\n<shellId: [0-9]+ completed with exit code 0>$/) : null;
    const nativeOutput = exits.length === 1 && exits[0].exitCode === 0 && typeof exits[0].outputPreview === "string"
      ? exits[0].outputPreview : !end.data.result?.contents && trailer ? trailer[1] : null;
    const success = end.data.success === true && end.data.shellExecution?.exitCode === 0 && nativeOutput !== null;
    return { id, command: start.data.arguments?.command, status: success ? "completed" : "unsuccessful-or-untyped",
      output: success ? nativeOutput : null, startedAt: start.timestamp, completedAt: end.timestamp,
      providerModel: start.data.model ?? null, startEventId: start.id, endEventId: end.id };
  });
}

export function inspectExecution(execution, runId) {
  const result = { arithmetic: null, readback: null, written: null, newlineCount: null, reason: null };
  if (execution.status !== "completed" || typeof execution.command !== "string") {
    return { ...result, reason: execution.status };
  }
  const command = execution.command.trim();
  const output = execution.output?.replace(/\r\n/g, "\n");
  if (typeof output !== "string") return { ...result, reason: "missing native stdout" };
  const file = `/tmp/smoke-copilot-small-${runId}.txt`;
  if (/^echo\s+\$\(\(\s*6\s*\*\s*7\s*\)\)\s*;?$/.test(command)) {
    result.arithmetic = output.trim() === "42";
  }
  const countAndArithmetic = `cat ${file} | wc -l; echo $((6 * 7))`;
  if (command === countAndArithmetic) {
    const lines = output.trim().split("\n");
    if (lines.length === 2 && /^\s*\d+\s*$/.test(lines[0]) && /^\s*-?\d+\s*$/.test(lines[1])) {
      result.arithmetic = lines[1].trim() === "42";
      result.newlineCount = Number(lines[0]);
    }
  }
  if (command === `cat ${file}` || command === `cat '${file}'` || command === `cat "${file}"`) {
    const lines = output.replace(/\n$/, "").split("\n");
    result.readback = lines.length === 3 && lines.every(line => line.trim().length > 0);
  }
  if (result.arithmetic === null && result.readback === null) result.reason = "command outside frozen native grammar";
  return result;
}

export function joinedWriteReadback(executions, creations) {
  const accepted = executions.filter(row => row.facets.readback === true && creations.some(creation =>
    Date.parse(creation.completedAt) <= Date.parse(row.startedAt)
    && creation.readbackSha256 === sha256(Buffer.from(row.output.replace(/\n$/, "")))));
  return accepted.length ? { value: true, at: accepted.map(row => row.completedAt).sort()[0] } : { value: null, at: null };
}

export function assessRun(run, jobs, log, source, compiled, session = null) {
  if (run.repository?.id !== 1036865607 || run.repository?.full_name !== "github/gh-aw"
    || run.repository?.private !== false
    || run.path !== ".github/workflows/smoke-copilot-small.lock.yml"
    || !Number.isSafeInteger(run.id) || run.run_attempt !== 1 || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) throw new Error("Run source/identity mismatch");
  const agent = jobs.jobs.filter(job => job.name === "agent");
  if (agent.length !== 1 || agent[0].run_id !== run.id || agent[0].head_sha !== run.head_sha
    || !agent[0].started_at || !agent[0].completed_at) throw new Error("Protected job identity mismatch");
  const sourceApplicable = source.status === "retained"
    && source.content.includes('original 3-line haiku about software testing')
    && source.content.includes('/tmp/smoke-copilot-small-${{ github.run_id }}.txt')
    && source.content.includes('echo $((6 * 7))');
  if (!sourceApplicable || compiled.status !== "retained"
    || !compiled.content.includes("smoke-copilot-small")) return {
    runId: run.id, attempt: 1, head: run.head_sha, sourceApplicable: false,
    arithmetic: null, readback: null, written: null, fullAcceptance: null,
    missingReason: "Original source/compiled binding unavailable or incompatible",
  };
  const bounds = { start: agent[0].started_at, end: agent[0].completed_at };
  const executions = typedExecutions(session?.events ?? log, bounds)
    .map(execution => ({ ...execution, facets: inspectExecution(execution, run.id) }));
  if (session) for (const execution of executions) {
    const escaped = execution.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matching = new RegExp(`^\\d{4}-[^\\n]+ agent/agent tool.execution_complete toolName=bash toolCallId=${escaped} \\[succeeded\\]`, "m");
    const sessionPath = session.path.replace("sandbox/agent/logs/", "");
    if (execution.status === "completed" && (!matching.test(log) || !log.includes(`path=${sessionPath}`))) {
      throw new Error("Native session lacks protected completion/session-path corroboration");
    }
  }
  const facet = name => {
    const values = executions.filter(row => row.facets[name] !== null);
    if (!values.length) return null;
    return values.some(row => row.facets[name] === true);
  };
  const facetAt = name => executions.filter(row => row.facets[name] === facet(name))
    .map(row => row.completedAt).filter(Boolean).sort()[0] ?? null;
  const knownFacetAt = name => facet(name) === null ? null : facetAt(name);
  const times = ["arithmetic", "readback", "written"].map(knownFacetAt).filter(Boolean).sort();
  const sessionEvents = session ? session.events.trim().split("\n").map(line => JSON.parse(line)) : [];
  const creations = sessionEvents.filter(row => row.type === "tool.execution_start" && row.data?.toolName === "create"
    && row.data.arguments?.path === `/tmp/smoke-copilot-small-${run.id}.txt`).flatMap(start => {
    const end = sessionEvents.find(row => row.type === "tool.execution_complete"
      && row.data?.toolCallId === start.data.toolCallId);
    const text = start.data.arguments?.file_text;
    const matching = `tool.execution_complete toolName=create toolCallId=${start.data.toolCallId} [succeeded]`;
    return end?.data.success === true && typeof text === "string"
      && end.data.fileEdits?.some(row => row.kind === "create" && row.path === start.data.arguments.path)
      && log.includes(matching) ? [{ callId: start.data.toolCallId, completedAt: end.timestamp,
        contentSha256: sha256(Buffer.from(text)), readbackSha256: sha256(Buffer.from(text.replace(/\n$/, ""))),
        newlineCount: text.split("\n").length - 1,
        limitation: "Successful create proves file bytes written, not originality or full cat content readback" }] : [];
  });
  const written = joinedWriteReadback(executions, creations);
  return { runId: run.id, attempt: 1, head: run.head_sha, sourceBlob: source.id, compiledBlob: compiled.id,
    sourceApplicable: true, arithmetic: facet("arithmetic"), readback: facet("readback"), written: written.value,
    arithmeticAt: knownFacetAt("arithmetic"), readbackAt: knownFacetAt("readback"), writtenAt: written.at,
    nativeNewlineReads: executions.filter(row => row.facets.newlineCount !== null).map(row => ({
      callId: row.id, newlineCount: row.facets.newlineCount, completedAt: row.completedAt,
      limitation: "wc -l newline count is not complete content readback, originality or haiku quality",
    })),
    nativeFileCreations: creations,
    knownImportedFailures: executions.filter(row => row.command?.startsWith("playwright-cli open ")
      && row.output?.includes("GLIBC_2.43") && row.output.includes("not found")).map(row => ({
      requirement: "Playwright JavaScript title equality", callId: row.id, completedAt: row.completedAt,
      reason: "Native Chromium launch error: required GLIBC_2.43 unavailable; successful shell pipeline status does not prove browser success",
    })),
    fullAcceptance: null, observedProviderModels: [...new Set(executions.map(row => row.providerModel).filter(Boolean))],
    completedAt: times.at(-1) ?? null,
    executions: executions.map(({ output, command, ...row }) => ({
      ...row, commandSha256: sha256(Buffer.from(command ?? "")), stdoutSha256: output == null ? null : sha256(Buffer.from(output)),
    })),
    missingReason: "Originality, literary quality, alias resolution and full imported acceptance not established by narrow native facets",
  };
}

export function loadNative(root) {
  const source = sourceReader(root);
  const receipts = readPacketReceipts(root);
  const get = endpoint => {
    const matches = receipts.filter(row => row.receipt.endpoint === endpoint && row.receipt.status === 200);
    if (!matches.length) return null;
    const bytes = matches.map(row => row.bodies.file ?? row.bodies.response);
    if (new Set(bytes.map(sha256)).size !== 1) throw new Error("Conflicting original endpoint receipts");
    return bytes[0];
  };
  const runs = receipts.filter(row => /^repos\/github\/gh-aw\/actions\/runs\/\d+$/.test(row.receipt.endpoint)
    && row.receipt.status === 200).map(row => JSON.parse(row.bodies.file ?? row.bodies.response));
  const unique = new Map(runs.map(run => [run.id, run]));
  return [...unique.values()].map(run => {
    const prefix = `repos/github/gh-aw/actions/runs/${run.id}`;
    const jobs = get(`${prefix}/attempts/1/jobs?per_page=100`);
    const logs = get(`${prefix}/attempts/1/logs`);
    if (!jobs || !logs) return { runId: run.id, attempt: 1, head: run.head_sha,
      arithmetic: null, readback: null, written: null, fullAcceptance: null, missingReason: "Missing protected jobs/log originals" };
    const artifactList = get(`${prefix}/artifacts?per_page=100`);
    const artifacts = artifactList ? JSON.parse(artifactList) : null;
    if (artifacts && artifacts.total_count !== artifacts.artifacts?.length) throw new Error("Incomplete artifact inventory");
    const agentArtifacts = artifacts?.artifacts.filter(row => row.name === "agent") ?? [];
    let session = null;
    if (agentArtifacts.length > 1) throw new Error("Ambiguous native session artifacts");
    if (agentArtifacts.length) {
      const artifact = agentArtifacts[0];
      const bytes = get(`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`);
      if (bytes) {
        if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
          || artifact.workflow_run?.repository_id !== 1036865607
          || artifact.workflow_run?.head_repository_id !== 1036865607
          || artifact.digest !== `sha256:${sha256(bytes)}`) throw new Error("Native artifact producer binding mismatch");
        session = JSON.parse(readSession(bytes));
      }
    }
    return assessRun(run, JSON.parse(jobs), readAgentLog(logs),
      source.resolve(run.head_sha, ".github/workflows/smoke-copilot-small.md"),
      source.resolve(run.head_sha, ".github/workflows/smoke-copilot-small.lock.yml"), session);
  });
}
