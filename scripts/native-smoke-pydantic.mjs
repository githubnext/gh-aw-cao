import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { gitDigest, proofRoot, sha256, writeJson } from "./collect-smoke-pydantic.mjs";

export const cutoff = "2026-10-18T15:00:12Z";
export const repository = "github/gh-aw";
export const repositoryId = 1036865607;
export const iso = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
export function epochNs(value) {
  if (!iso(value)) throw new Error("Invalid precise UTC clock");
  const fraction = value.match(/\.(\d+)Z$/)?.[1] ?? "";
  return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1000000n
    + BigInt(fraction.padEnd(9, "0"));
}

export function safeOwnedPath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/).some(part => ["", ".", ".."].includes(part))
    || relative.includes("\\")) throw new Error("Unsafe owned evidence reference");
  return path.join(root, relative);
}

export function verifiedFile(root, reference) {
  if (!reference || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0
    || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) throw new Error("Malformed custody reference");
  const bytes = readFileSync(safeOwnedPath(root, reference.path));
  if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) {
    throw new Error(`Original evidence custody mismatch: ${reference.path}`);
  }
  return bytes;
}

export function originalBytes(root, reference) {
  if (!reference.parts) return verifiedFile(root, reference);
  if (!Array.isArray(reference.parts) || !reference.parts.length
    || reference.parts.length > 1024) throw new Error("Malformed original parts");
  const bytes = Buffer.concat(reference.parts.map(part => verifiedFile(root, part)));
  if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) {
    throw new Error("Reassembled original custody mismatch");
  }
  return bytes;
}

export function readZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 64 * 1024 * 1024) {
    throw new Error("Invalid native ZIP size");
  }
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) throw new Error("Unsupported native ZIP directory");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16), decodedBytes = 0;
  if (count > 4096 || offset + size !== end) throw new Error("Invalid native ZIP directory bounds");
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid native ZIP entry");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20);
    const length = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > end || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000
      || files.has(name) || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) {
      throw new Error("Unsafe or unsupported native ZIP entry");
    }
    safeOwnedPath("/native", name.endsWith("/") ? name.slice(0, -1) : name);
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    if (bytes.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) {
      throw new Error("Conflicting native ZIP local entry");
    }
    const start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > bytes.readUInt32LE(end + 16)
      || length > 64 * 1024 * 1024 || decodedBytes + length > 128 * 1024 * 1024) {
      throw new Error("Native ZIP payload exceeds bounds");
    }
    const payload = bytes.subarray(start, start + compressed);
    const decoded = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: length || 1 });
    if (decoded.length !== length || crc32(decoded) !== crc) throw new Error("Native ZIP CRC/size mismatch");
    decodedBytes += decoded.length;
    files.set(name, decoded);
  }
  if (offset !== end) throw new Error("Native ZIP directory length mismatch");
  return files;
}

function treeEntries(bytes) {
  const rows = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
    if (space < offset || nul < space || nul + 21 > bytes.length) throw new Error("Invalid Git tree bytes");
    rows.push({ mode: bytes.subarray(offset, space).toString(),
      name: bytes.subarray(space + 1, nul).toString(),
      id: bytes.subarray(nul + 1, nul + 21).toString("hex") });
    offset = nul + 21;
  }
  return rows;
}

export function retainedSourceBlob(id, root = proofRoot) {
  const file = path.join(root, "source-originals.json");
  if (!existsSync(file)) return null;
  const index = readJsonArchive(file);
  const record = index.blobs.find(row => row.gitBlob === id);
  if (!record) return null;
  const blob = originalBytes(root, record.blob);
  const response = JSON.parse(originalBytes(root, record.response));
  if (gitDigest("blob", blob) !== id || response.sha !== id
    || response.encoding !== "base64" || !Buffer.from(response.content, "base64").equals(blob)) {
    throw new Error("Retained source provider/Git binding mismatch");
  }
  return blob;
}

export function verifyGitClosure(root, revision) {
  const closure = readJsonArchive(path.join(root, `git/${revision}-closure.json`));
  if (closure.revision !== revision) throw new Error("Git closure revision mismatch");
  const objects = new Map(closure.objects.map(reference => {
    const bytes = readFileSync(safeOwnedPath(root, reference.file));
    if (sha256(bytes) !== reference.sha256) throw new Error("Git custody reference mismatch");
    const object = readJsonArchive(safeOwnedPath(root, reference.file));
    const native = Buffer.from(object.content, "base64");
    if (!["commit", "tree", "blob"].includes(object.type) || native.length !== object.bytes
      || gitDigest(object.type, native) !== object.id) throw new Error("Git native object mismatch");
    return [object.id, { ...object, native }];
  }));
  const commit = objects.get(revision);
  if (commit?.type !== "commit") throw new Error("Missing native commit");
  const text = commit.native.toString("utf8");
  const tree = text.match(/^tree ([a-f0-9]{40})$/m)?.[1];
  const parent = text.match(/^parent ([a-f0-9]{40})$/m)?.[1] ?? null;
  const committed = text.match(/^committer .+ (\d+) [+-]\d{4}$/m)?.[1];
  if (!tree || !committed) throw new Error("Malformed native commit identity");
  const files = closure.files.map(file => {
    let id = tree;
    for (const [index, component] of file.path.split("/").entries()) {
      const object = objects.get(id);
      if (object?.type !== "tree" || file.chain[index] !== id) throw new Error("Missing native tree membership");
      const entry = treeEntries(object.native).find(row => row.name === component);
      if (!entry) {
        if (file.status !== "absent") throw new Error("False Git file presence");
        return file;
      }
      if (index === file.path.split("/").length - 1) {
        if (file.status !== "present" || entry.id !== file.id || entry.mode !== file.mode) {
          throw new Error("False Git file identity");
        }
        return { ...file, bytes: objects.get(entry.id)?.native ?? retainedSourceBlob(entry.id, root) };
      }
      if (entry.mode !== "40000") throw new Error("Non-directory Git path ancestor");
      id = entry.id;
    }
    throw new Error("Unresolved Git file");
  });
  return { revision, parent, committedAt: new Date(Number(committed) * 1000).toISOString().replace(".000Z", "Z"), files };
}

export function introduction(root = proofRoot) {
  const child = verifyGitClosure(root, "0e301e6777bef1d23305c8031dcd161a642836f5");
  const parent = verifyGitClosure(root, "cc3330af665107c4e4e1b8dbff618ae23b792314");
  if (child.parent !== parent.revision
    || child.files.some(file => file.status !== "present")
    || parent.files.some(file => file.status !== "absent")) throw new Error("False source introduction");
  return { commit: child.revision, adoptedAt: child.committedAt,
    baselineCommit: parent.revision, baselineAt: parent.committedAt };
}

export function validateRequest(request) {
  if (!request || !["windowStart", "windowEnd", "observedAt"].every(key => iso(request[key]))
    || epochNs(request.windowStart) >= epochNs(request.windowEnd)
    || epochNs(request.windowEnd) > epochNs(request.observedAt)
    || (request.repository !== undefined && request.repository !== repository)) {
    throw new Error("Invalid native measurement request or clock");
  }
  return request;
}

export function validateNativeRun(metadata, jobs, artifacts, publicMetadata) {
  if (publicMetadata?.id !== repositoryId || publicMetadata.full_name !== repository
    || publicMetadata.private !== false || metadata?.repository?.id !== repositoryId
    || metadata.repository.full_name !== repository || metadata.repository.private !== false
    || metadata.path !== ".github/workflows/smoke-pydantic.lock.yml"
    || !Number.isSafeInteger(metadata.id) || metadata.id <= 0
    || !Number.isSafeInteger(metadata.run_attempt) || metadata.run_attempt <= 0
    || !/^[a-f0-9]{40}$/.test(metadata.head_sha ?? "")
    || !["created_at", "run_started_at", "updated_at"].every(key => iso(metadata[key]))
    || Date.parse(metadata.created_at) > Date.parse(metadata.run_started_at)
    || Date.parse(metadata.run_started_at) > Date.parse(metadata.updated_at)
    || Date.parse(metadata.updated_at) > Date.parse(cutoff)
    || metadata.status !== "completed" || typeof metadata.event !== "string") {
    throw new Error("Native run identity, public authority, source or clock mismatch");
  }
  if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length
    || jobs.jobs.some(job => job.run_id !== metadata.id
      || !Number.isSafeInteger(job.id) || job.id <= 0
      || !Array.isArray(job.steps))) throw new Error("Incomplete or mismatched protected jobs inventory");
  if (!Array.isArray(artifacts?.artifacts) || artifacts.total_count !== artifacts.artifacts.length
    || artifacts.artifacts.some(artifact => !Number.isSafeInteger(artifact.id) || artifact.id <= 0
      || artifact.workflow_run?.id !== metadata.id || artifact.workflow_run?.head_sha !== metadata.head_sha)) {
    throw new Error("Incomplete or mismatched native artifact inventory");
  }
  return { id: `${metadata.id}/${metadata.run_attempt}`, runId: metadata.id,
    attempt: metadata.run_attempt, headSha: metadata.head_sha, event: metadata.event,
    startedAt: metadata.run_started_at, completedAt: metadata.updated_at,
    url: metadata.html_url };
}

export function decodeCanonicalFrames(log) {
  const lines = log.split("\n");
  const header = lines.find(line => /^\x1eGH-AW-SESSION-KEY:[0-9a-f]{32}\x1e$/.test(line));
  const key = header?.match(/^\x1eGH-AW-SESSION-KEY:([0-9a-f]{32})\x1e$/)?.[1];
  const types = new Set(["session.init", "user.message", "assistant.message", "assistant.reasoning",
    "tool.execution_start", "tool.execution_complete", "session.result"]);
  const events = [];
  let malformedFrames = 0;
  if (!key) return { events, malformedFrames, authenticatedFrames: false };
  for (const line of lines) {
    const match = line.match(/^\x1eGH-AW-SESSION\/([0-9a-f]{32}) (\{.*\})$/);
    if (!match || match[1] !== key) continue;
    let event;
    try { event = JSON.parse(match[2]); }
    catch { malformedFrames++; continue; }
    if (event && types.has(event.type) && event.data && typeof event.data === "object"
      && !Array.isArray(event.data)) events.push(event);
  }
  return { events, malformedFrames, authenticatedFrames: true };
}

function nativeText(output) {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    if (typeof output.content === "string") return output.content;
    if (typeof output.text === "string") return output.text;
  }
  return null;
}

function rootReadPath(input, cwd) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const paths = ["path", "file_path", "file"].filter(key => typeof input[key] === "string");
  if (paths.length !== 1) return false;
  const file = input[paths[0]];
  return file === "README.md" || file === "./README.md" || file === `${cwd}/README.md`;
}

export function assessCanonical(log, readme, run) {
  const decoded = decodeCanonicalFrames(log);
  const unknown = { read: "unknown", inference: "unknown", mcpAvailability: "unknown",
    transport: "unknown", safeOutputPersistence: "unknown", fullGoal: "unknown", contribution: "unknown",
    pythonFilesystemRead: "unknown", pythonReadContribution: "unknown" };
  const facets = { ...unknown }, facetAt = {}, receipts = [];
  const validClock = event => iso(event.timestamp)
    && epochNs(event.timestamp) >= epochNs(run.startedAt)
    && epochNs(event.timestamp) <= epochNs(run.completedAt);
  const initial = decoded.events.find(event => event.type === "session.init"
    && event.data.sourceEngine === "pydantic-ai" && typeof event.data.cwd === "string"
    && path.posix.isAbsolute(event.data.cwd) && validClock(event));
  if (!initial) return { facets, facetAt, receipts, reason: "No native Pydantic session initialization." };
  const firstLine = readme.toString("utf8").split("\n")[0].replace(/\r$/, "");
  const calls = new Map();
  const seenIds = new Set();
  for (const event of decoded.events) {
    if (!validClock(event) || epochNs(event.timestamp) < epochNs(initial.timestamp)
      || (initial.session_id !== undefined && event.session_id !== initial.session_id)) continue;
    const data = event.data;
    if (event.type === "assistant.message" && typeof data.content === "string"
      && data.content.split("\n").some(line => /^(?:2\s*\+\s*2\s*=\s*)?4[.!]?$/.test(line.trim()))) {
      if (facets.inference !== "passed") facetAt.inference = event.timestamp;
      facets.inference = "passed";
    }
    if (event.type === "tool.execution_start" && typeof data.toolCallId === "string") {
      if (seenIds.has(data.toolCallId)) throw new Error("Ambiguous repeated native tool call ID");
      seenIds.add(data.toolCallId);
      calls.set(data.toolCallId, event);
    }
    if (event.type !== "tool.execution_complete") continue;
    const start = calls.get(data.toolCallId);
    if (!start || start.data.toolName !== data.toolName
      || epochNs(start.timestamp) > epochNs(event.timestamp)) continue;
    calls.delete(data.toolCallId);
    const pythonRead = typeof start.data.input?.code === "string"
      && /^from pathlib import Path[ \t]*\r?\n[ \t]*readme_content[ \t]*=[ \t]*Path\((['"])README\.md\1\)\.read_text\(\)[ \t]*\r?\n[ \t]*readme_content\.splitlines\(\)\[0\][ \t]*$/
        .test(start.data.input.code.trim());
    if (data.toolName === "run_code" && pythonRead
      && data.success === true && data.status === "success"
      && nativeText(data.output) === firstLine) {
      facets.pythonFilesystemRead = "passed";
      facets.pythonReadContribution = "passed";
      facetAt.pythonFilesystemRead ??= event.timestamp;
      facetAt.pythonReadContribution ??= event.timestamp;
      receipts.push({ kind: "native-Python-filesystem-read-not-read_file",
        nativeToolName: data.toolName, toolCallId: data.toolCallId,
        startedAt: start.timestamp, at: event.timestamp, cwd: initial.data.cwd,
        request: start.data.input,
        result: { success: data.success, status: data.status, output: data.output },
        codeSha256: sha256(Buffer.from(start.data.input.code)),
        requestSha256: sha256(Buffer.from(JSON.stringify(start.data.input))),
        outputSha256: sha256(Buffer.from(firstLine)) });
    }
    if (data.toolName === "read_file" && rootReadPath(start.data.input, initial.data.cwd)) {
      const text = nativeText(data.output);
      const accepted = data.success === true && data.status === "success" && text !== null
        && text.split("\n")[0].replace(/\r$/, "") === firstLine;
      const failed = data.success === false || data.status === "error"
        || (data.success === true && data.status === "success" && text !== null && !accepted);
      if (accepted) {
        facets.read = "passed";
        facets.contribution = "passed";
        facetAt.read ??= event.timestamp;
        facetAt.contribution ??= event.timestamp;
        receipts.push({ kind: "native-read_file", toolCallId: data.toolCallId,
          at: event.timestamp, outputSha256: sha256(Buffer.from(text)), firstLineSha256: sha256(Buffer.from(firstLine)) });
      } else if (failed && facets.read !== "passed") {
        facets.read = "failed";
        facetAt.read = event.timestamp;
      }
    }
    if (["create_issue", "safeoutputs_create_issue", "safeoutputs__create_issue",
      "mcp__safeoutputs__create_issue"].includes(data.toolName)
      && data.success === true && data.status === "success" && data.output?.isError !== true) {
      facets.mcpAvailability = "passed";
      facetAt.mcpAvailability ??= event.timestamp;
      receipts.push({ kind: "native-MCP-availability-not-persistence", toolCallId: data.toolCallId,
        at: event.timestamp });
    }
  }
  const final = decoded.events.findLast(event => event.type === "session.result"
    && event.data.sourceType === "pydantic-ai" && validClock(event)
    && epochNs(event.timestamp) >= epochNs(initial.timestamp)
    && (initial.session_id === undefined || event.session_id === initial.session_id));
  if (final && decoded.malformedFrames === 0 && !decoded.events.some(event => event.type === "tool.execution_start"
    && event.data.toolName === "read_file") && facets.read === "unknown") {
    facets.read = "failed";
    facetAt.read = final.timestamp;
  }
  return { facets, facetAt, receipts,
    reason: "Native partial cases only; transport, persistence and complete source-goal acceptance require independent additional receipts.",
    malformedFrames: decoded.malformedFrames };
}

export function gatewayEnumeration(files, run) {
  const bytes = files.get("mcp-logs/rpc-messages.jsonl");
  if (!bytes) return null;
  const rows = bytes.toString().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const request = rows.find(row => row._schema === "rpc-message/v2"
    && row.server_id === "safeoutputs" && row.direction === "OUT"
    && row.method === "tools/list" && row.payload?.method === "tools/list");
  const response = rows.find(row => row._schema === "rpc-message/v2"
    && row.server_id === "safeoutputs" && row.direction === "IN"
    && (request?.payload?.id === undefined || row.payload?.id === request.payload.id)
    && Array.isArray(row.payload?.result?.tools) && !row.payload.error);
  if (!request || !response || !iso(request.timestamp) || !iso(response.timestamp)
    || epochNs(request.timestamp) > epochNs(response.timestamp)
    || epochNs(request.timestamp) < epochNs(run.startedAt)
    || epochNs(response.timestamp) > epochNs(run.completedAt)
    || !response.payload.result.tools.some(tool => tool.name === "create_issue")) return null;
  return { kind: "host-gateway-MCP-tools-list-only", requestAt: request.timestamp,
    responseAt: response.timestamp, rpcSha256: sha256(bytes),
    toolNames: response.payload.result.tools.map(tool => tool.name),
    requestResponseCorrelation: request.payload.id === undefined ? "unknown-request-envelope-omits-id" : "matching-jsonrpc-id",
    agentUsableMcpProven: false, agentTransportProven: false };
}

export function collectNative(root = proofRoot) {
  const source = verifyGitClosure(root, "c86377ec47b38f0b5af463277ee55d1d03d08da8");
  const workflow = source.files.find(row => row.path === ".github/workflows/smoke-pydantic.md");
  if (workflow?.id !== "39e64a09ad74877e7533d69f858e9a479f9ce318" || !workflow.bytes) {
    throw new Error("Frozen intent source is missing or has changed");
  }
  const provenance = [{ repository, kind: "immutable-intent-source-not-outcome",
      ref: `git-blob:${workflow.id}:sha256:${sha256(workflow.bytes)}` }],
    file = path.join(root, "request-originals.json");
  if (!existsSync(file)) return {
    cases: [], missingReason: "Original native run receipts have not been supplied.", provenance,
  };
  const index = readJsonArchive(file);
  const review = readJsonArchive(path.join(root, "source-review.json"));
  const get = endpoint => {
    const entries = index.requests.filter(row => row.endpoint === endpoint);
    if (entries.length !== 1) throw new Error(`Missing or ambiguous original endpoint: ${endpoint}`);
    return { bytes: originalBytes(root, entries[0].original), reference: entries[0].original };
  };
  const json = endpoint => JSON.parse(get(endpoint).bytes);
  const cases = review.runProfiles.map(profile => {
    const prefix = `repos/${repository}/actions/runs/${profile.runId}`;
    const metadata = json(prefix);
    const jobs = json(`${prefix}/attempts/${profile.attempt}/jobs?per_page=100`);
    const inventory = json(`${prefix}/artifacts?per_page=100`);
    const run = validateNativeRun(metadata, jobs, inventory, metadata.repository);
    if (run.attempt !== profile.attempt || run.headSha !== profile.headSha) throw new Error("Reviewed source/run binding mismatch");
    const tree = verifyGitClosure(root, run.headSha);
    const required = [
      [".github/workflows/smoke-pydantic.md", profile.sourceGitBlob],
      [".github/workflows/smoke-pydantic.lock.yml", profile.compiledGitBlob],
      ["README.md", profile.readmeGitBlob],
    ].map(([name, id]) => {
      const item = tree.files.find(row => row.path === name);
      if (item?.id !== id || item.mode !== "100644" || !item.bytes) throw new Error("Missing or mismatched coherent source profile");
      return item.bytes;
    });
    const [markdown, compiled, readme] = required;
    if (!markdown.toString().includes("this test only passes when the file tool returns it.")
      || !compiled.toString().includes("name: Execute Pydantic AI CLI")) throw new Error("Incompatible native source acceptance");
    const importBlob = profile.runtime === "canonical-framed-clai2"
      ? review.referenceProfile.importGitBlob : profile.importGitBlob;
    if (!retainedSourceBlob(importBlob, root)) throw new Error("Missing reviewed external engine import");
    const agentJob = jobs.jobs.find(job => job.name === "agent");
    if (!agentJob?.steps.some(step => step.name === "Execute Pydantic AI CLI"
      && step.status === "completed" && iso(step.started_at))) throw new Error("Missing protected native producer step");
    const agentArtifact = inventory.artifacts.find(artifact => artifact.name === "agent");
    if (!agentArtifact || !/^sha256:[a-f0-9]{64}$/.test(agentArtifact.digest)) throw new Error("Missing native artifact provider digest");
    const original = get(`repos/${repository}/actions/artifacts/${agentArtifact.id}/zip`);
    if (`sha256:${sha256(original.bytes)}` !== agentArtifact.digest
      || original.bytes.length !== agentArtifact.size_in_bytes) throw new Error("Native artifact/provider digest mismatch");
    const files = readZip(original.bytes);
    const execution = JSON.parse(files.get("agent_execution.json")?.toString() ?? "null");
    if (execution?.component !== "agent" || execution.run_id !== run.runId
      || execution.run_attempt !== run.attempt || execution.state !== "started") throw new Error("Native execution identity mismatch");
    const protectedOriginal = get(`${prefix}/attempts/${run.attempt}/logs`);
    const protectedLogs = readZip(protectedOriginal.bytes);
    if (!protectedLogs.has("3_agent.txt") || !protectedLogs.has("1_safe_outputs.txt")) {
      throw new Error("Missing protected producer/consumer original logs");
    }
    const itemsArtifact = inventory.artifacts.find(artifact => artifact.name === "safe-outputs-items");
    if (!itemsArtifact || !/^sha256:[a-f0-9]{64}$/.test(itemsArtifact.digest)) throw new Error("Missing native consumer artifact identity");
    const itemsOriginal = get(`repos/${repository}/actions/artifacts/${itemsArtifact.id}/zip`);
    if (`sha256:${sha256(itemsOriginal.bytes)}` !== itemsArtifact.digest
      || itemsOriginal.bytes.length !== itemsArtifact.size_in_bytes) throw new Error("Consumer artifact/provider digest mismatch");
    const itemFiles = readZip(itemsOriginal.bytes);
    const itemBytes = itemFiles.get("safe-output-items.jsonl");
    if (!itemBytes) throw new Error("Missing original consumer items file");
    const consumedItems = itemBytes.toString().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const consumerLog = protectedLogs.get("1_safe_outputs.txt");
    const stdio = files.get("agent-stdio.log");
    if (!stdio) throw new Error("Native artifact lacks its actual stdio");
    let native;
    if (profile.runtime === "canonical-framed-clai2") {
      if (!compiled.toString().includes("GH-AW-SESSION-KEY:")) throw new Error("Canonical source profile has no authenticated recorder");
      if (!compiled.toString().includes("LocalWorkspace('.', env=_env)")
        || !compiled.toString().includes("cwd: workspace, env, input:")) throw new Error("Missing source-owned native workspace binding");
      native = assessCanonical(stdio.toString(), readme, run);
    } else if (profile.runtime === "legacy-pai-console") {
      if (!compiled.toString().includes('const toolId = `pai_tool_${toolCallIndex++}`;')) {
        throw new Error("Legacy source parser identity mismatch");
      }
      native = {
        facets: { read: "unknown", inference: "unknown", mcpAvailability: "unknown",
          transport: "unknown", safeOutputPersistence: "unknown", fullGoal: "unknown", contribution: "unknown",
          pythonFilesystemRead: "unknown", pythonReadContribution: "unknown" },
        facetAt: {}, receipts: [],
        reason: "Legacy console records a read_file call but lacks native arguments and return bytes; derived tool-shaped entries cannot establish the read.",
      };
    } else throw new Error("Unreviewed native runtime era");
    const usage = JSON.parse(files.get("agent_usage.json")?.toString() ?? "null");
    if (!usage || !["input_tokens", "output_tokens", "ai_credits"].every(key =>
      typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0)) {
      throw new Error("Missing or invalid original native usage");
    }
    provenance.push(
      { repository, kind: "provider-digest-verified-original-agent-zip",
        ref: `artifact:${agentArtifact.id}:${agentArtifact.digest}` },
      { repository, kind: "original-protected-attempt-log-zip",
        ref: `run:${run.id}:sha256:${sha256(protectedOriginal.bytes)}` },
      { repository, kind: "immutable-run-source-profile", ref: `git:${run.headSha}:${profile.sourceGitBlob}:${profile.compiledGitBlob}:${profile.readmeGitBlob}` },
    );
    const times = Object.values(native.facetAt).sort((a, b) => epochNs(a) < epochNs(b) ? -1 : 1);
    return { id: run.id, runId: run.runId, attempt: run.attempt, headSha: run.headSha,
      sourceProfile: profile.runtime, at: times[0] ?? run.completedAt, availableAt: run.completedAt,
      ...native, nativeUsage: usage,
      hostGatewayEnumeration: gatewayEnumeration(files, run),
      safeOutputConsumerEvidence: {
        itemsArtifactId: itemsArtifact.id, itemsArtifactSha256: sha256(itemsOriginal.bytes),
        consumerLogSha256: sha256(consumerLog), appliedItems: consumedItems.length,
        reportIncomplete: /report_incomplete: (?:task completion unconfirmed|engine_driver_failure)/.test(consumerLog.toString()),
        prescribedIssuePersistence: null,
        interpretation: "An empty uploaded-items file is not persistence proof. The protected consumer records an incomplete signal, not accepted prescribed output.",
      },
      sourceEvidence: { agentArtifactId: agentArtifact.id, agentArtifactSha256: sha256(original.bytes),
        stdioSha256: sha256(stdio), readmeGitBlob: profile.readmeGitBlob,
        protectedLogsSha256: sha256(protectedOriginal.bytes) } };
  });
  return { cases, provenance,
    missingReason: "Two selected original attempts only; full historical run population and unobserved periods remain unknown." };
}

export const nativeDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function renderAssessment() {
  const { definition, scoreMetric } = await import("../docs/operational-value/proof/functions/smoke-pydantic.mjs");
  const directory = path.join(proofRoot, "reports/github-gh-aw");
  const timelineFile = path.join(directory, "smoke-pydantic-timeline.json");
  const timeline = readJsonArchive(timelineFile);
  const functionFile = fileURLToPath(new URL("../docs/operational-value/proof/functions/smoke-pydantic.mjs", import.meta.url));
  if (timeline.valueFunction.sha256 !== sha256(readFileSync(functionFile))) throw new Error("Report/function pin mismatch");
  const native = collectNative();
  const discovery = readJsonArchive(path.join(proofRoot, "discovery.json"));
  const pin = file => ({ path: path.relative(fileURLToPath(new URL("../", import.meta.url)), file),
    bytes: readFileSync(file).length, sha256: sha256(readFileSync(file)) });
  const partialReads = native.cases.flatMap(row => row.receipts)
    .filter(receipt => receipt.kind === "native-Python-filesystem-read-not-read_file");
  const report = {
    schemaVersion: 1, workflow: "smoke-pydantic", status: "native-partial-measured",
    readyForCoordinatorReplay: true, portfolioQualification: "Coordinator decision; no global benchmark record modified.",
    workingInstrument: {
      schemaVersion: 3, contractVersion: definition.evidence.key,
      collector: "Actual original-metadata/source/protected-log/provider-digest-checked artifact collector",
      requestShape: "{observedAt,windowStart,windowEnd}",
      execution: "Offline collection, scoring, refresh and report rendering; no models, network, installs or target-code execution.",
      fullAcceptanceOracle: false,
    },
    pins: { function: pin(functionFile), timeline: pin(timelineFile),
      pulse: pin(path.join(directory, "smoke-pydantic-pulse.html")),
      strictPredecessor: pin(path.join(proofRoot, "predecessor-v1.json")) },
    genuineNativeMeasurement: {
      strictReadFile: { acceptedObservedCases: 0, assessedAttempts: 1, unknownAttempts: 1,
        completePopulationTotal: null, explanation: "Oct17 complete canonical primary-session trace never invokes read_file; Oct9 console mention lacks native arguments/read bytes." },
      pythonFilesystemPartial: {
        acceptedObservedCases: native.cases.filter(row => row.facets.pythonFilesystemRead === "passed").length,
        successfulNativeReadResults: partialReads.length,
        deduplication: "Three successful Python reads in one service lifetime count as one case.",
        firstLineSha256: sha256(Buffer.from("# GitHub Agentic Workflows")),
        completePopulationTotal: null,
        interpretation: "Explicit additive historical partial, not read_file conformance or ex-ante acceptance.",
      },
      standaloneModelAnswer: null, agentUsableMcp: null, agentTransport: null,
      prescribedIssuePersistence: null, fullGoalAcceptance: null,
      workflowContribution: { observedPythonReadCases: native.cases.filter(row =>
        row.facets.pythonReadContribution === "passed").length,
        strength: "Original producer receipt-bound", causalRepositoryImprovement: null },
      hostGatewayOnly: { observedToolsListResponses: native.cases.filter(row => row.hostGatewayEnumeration).length,
        interpretation: "Host safeoutputs tools/list responses are distinct from the agent's usable MCP capability or transport." },
    },
    periods: timeline.snapshots.map(snapshot => ({
      window: snapshot.window, coverage: snapshot.evidence.coverageStatus,
      maturity: snapshot.evidence.maturityStatus, retainedAttempts: snapshot.evidence.retainedAttemptCount,
      metrics: Object.fromEntries(definition.metrics.map(metric => [metric.id, scoreMetric(metric.id, snapshot.evidence)])),
    })),
    nativeAttempts: native.cases,
    costs: {
      fullPeriodCosts: null, currencyCosts: null, costPerAcceptedOutcome: null,
      sampledAgentUsage: native.cases.map(row => ({ runId: row.runId, attempt: row.attempt,
        sourceProfile: row.sourceProfile, usage: row.nativeUsage })),
      interpretation: "Original matching agent_usage quantities only; not complete workflow/period billing or dollars. No division by reports, strict zero or unknown outcomes.",
    },
    sourceHistory: { ...introduction(), initialGoalDiffers: true, currentGoalIntroduction: null,
      temporalAnchorScope: "Actual workflow-lineage introduction, not invented introduction of the later README goal.",
      applicability: definition.sourceProfiles,
      historicalInterpretation: "Source-grounded reconstruction; not ex-ante acceptance. No comparable pre-adoption measure reconstructed, and history is not claimed exhausted." },
    discovery: { ...discovery.inventory, workflowSeeds: discovery.seedNumbers.length,
      closureIdentities: discovery.closure.length,
      absentReferences: discovery.closure.filter(row => row.status === "absent-reference").length,
      interpretation: "Complete surviving issue/PR discovery closure; no candidate is accepted as a native outcome." },
    temporalCoverage: { cutoff, periodCount: timeline.snapshots.length,
      completePopulation: false, comparableMovement: null, sustainedTrend: null,
      reason: "Only two selected attempts, different runtime/source eras, missing historical intervals and no two complete comparable periods." },
    decision: { status: "not rated", keepBar: null,
      reason: "No source-defined native keep bar; no causal, keep, retire or full-acceptance claim." },
    limitations: [
      "Strict read_file acceptance remains unchanged and its predecessor is preserved additively.",
      "The Python partial recognizes only its closed native request grammar, not arbitrary Python programs.",
      "Legacy console-derived tool-shaped records do not prove native arguments or returned bytes.",
      "No standalone arithmetic model response is inferred from calculator output.",
      "Protected consumers report incomplete signals and zero applied items; empty uploaded items alone are not persistence proof.",
      "Source profiles establish the observed executions, not general engine certification or complete transitive runtime identity.",
      "Campaign enrollment, collection deployment, remote memory writes, commits, pushes and pull requests were not performed.",
    ],
    skillImprovement: "Keep exact-tool conformance separate from narrower native operation effects; preserve request/result bytes and source-owned workspace binding, never promote console-shaped tool records to read proof.",
  };
  writeJson(path.join(proofRoot, "assessment.json"), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--report") {
    renderAssessment().then(report => {
      console.log(JSON.stringify({ status: report.status, nativePythonReadCases:
        report.genuineNativeMeasurement.pythonFilesystemPartial.acceptedObservedCases,
      strictReadFileCases: report.genuineNativeMeasurement.strictReadFile.acceptedObservedCases }));
    }).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  } else console.log(JSON.stringify({ introduction: introduction(), cutoff }));
}
