import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const proofDirectory = path.join(root, "docs/operational-value/proof/smoke-copilot-sdk");
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const interpreterSha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const workflowBlob = "baf972d19ce8044f2c3b4eecf127aa0ab7db74ec";
const workflowPath = ".github/workflows/smoke-copilot-sdk.md";
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && [value, value.replace(/Z$/, ".000Z")].includes(new Date(value).toISOString());
const positive = value => Number.isSafeInteger(value) && value > 0;
const sdkCommand = runId => `mkdir -p /tmp/gh-aw/agent && now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" && printf 'Copilot SDK smoke test passed at %s\n' "$now" > /tmp/gh-aw/agent/smoke-copilot-sdk-${runId}.txt && echo '---FILE---' && cat /tmp/gh-aw/agent/smoke-copilot-sdk-${runId}.txt && echo '---CALC---' && echo $((6 * 7))`;
const zipProjections = new Map();

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function readNativeZip(bytes) {
  let footer = bytes.length - 22;
  while (footer >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(footer) !== 0x06054b50) footer--;
  if (footer < Math.max(0, bytes.length - 65557) || bytes.readUInt16LE(footer + 4) !== 0
    || bytes.readUInt16LE(footer + 6) !== 0 || footer + 22 + bytes.readUInt16LE(footer + 20) !== bytes.length) {
    throw new Error("Unsupported native ZIP footer");
  }
  const count = bytes.readUInt16LE(footer + 10), directory = bytes.readUInt32LE(footer + 16);
  if (count > 128 || count !== bytes.readUInt16LE(footer + 8)
    || directory + bytes.readUInt32LE(footer + 12) !== footer) throw new Error("Native ZIP directory mismatch");
  const members = [], names = new Set();
  let cursor = directory, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > footer || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Native ZIP entry mismatch");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd + extra + comment > footer) throw new Error("Native ZIP entry bounds mismatch");
    const nameBytes = bytes.subarray(cursor + 46, nameEnd), name = nameBytes.toString("utf8");
    total += size;
    if (!name || !Buffer.from(name).equals(nameBytes) || names.has(name) || name.includes("\\") || name.includes("\0")
      || name.startsWith("/") || name.split("/").some(part => part === ".." || part === ".")
      || flags & 1 || ![0, 8].includes(method) || size > 4 * 1024 * 1024 || total > 32 * 1024 * 1024
      || bytes.readUInt16LE(cursor + 34) !== 0 || ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0o170000) === 0o120000
      || offset + 30 > directory || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Unsafe native ZIP member");
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra, end = start + compressed;
    if (end > directory || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method
      || !bytes.subarray(offset + 30, offset + 30 + localName).equals(nameBytes)) throw new Error("Native ZIP local-header mismatch");
    const content = method === 0 ? Buffer.from(bytes.subarray(start, end))
      : inflateRawSync(bytes.subarray(start, end), { maxOutputLength: size + 1 });
    let crc = 0xffffffff;
    for (const byte of content) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    if (content.length !== size || ((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32LE(cursor + 16)) {
      throw new Error("Native ZIP content/CRC mismatch");
    }
    names.add(name);
    members.push({ path: name, bytes: size, sha256: digest(content), content });
    cursor = nameEnd + extra + comment;
  }
  if (cursor !== footer) throw new Error("Native ZIP directory length mismatch");
  return members;
}

function projectNativeZip(kind, bytes, project) {
  const key = `${kind}:${digest(bytes)}`;
  if (!zipProjections.has(key)) {
    zipProjections.set(key, project(readNativeZip(bytes)));
  }
  return structuredClone(zipProjections.get(key));
}

function decode(value) {
  if (typeof value !== "string" || value.length > 1024 * 1024) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

export function interpretRawProbe(raw) {
  if (!raw || !positive(raw.runId) || raw.attempt !== undefined && !positive(raw.attempt)
    || !iso(raw.deliveredAt)) return null;
  if (raw.sdkCompound) {
    const native = raw.sdkCompound, stdout = decode(native.stdoutBase64);
    const valid = native.toolName === "bash" && native.command === sdkCommand(raw.runId)
      && native.exitCode === 0 && stdout !== null;
    const matched = valid && /^---FILE---\nCopilot SDK smoke test passed at [^\r\n]+\n---CALC---\n42\n$/.test(stdout.toString("utf8"));
    return {
      deliveredAt: raw.deliveredAt, fileContentFacet: null, catReadback: Boolean(matched), bashCalculation: Boolean(matched),
      fileCatBytesAgree: null, currentDateTimeCorrect: null, fullFileWritingTask: null, fullSourceConjunction: null,
      interpretation: "Actual protected compound bash command and its native shell_exit stdout; successful && chain and unambiguous exact separators establish cat and arithmetic result segments. No synthetic standalone argv/process was constructed; file-state/clock proof remains separate.",
    };
  }
  const filePath = `/tmp/gh-aw/agent/smoke-copilot-sdk-${raw.runId}.txt`;
  const before = raw.fileBefore, after = raw.fileAfter;
  const bytes = after ? decode(after.bytesBase64) : null;
  const text = bytes?.toString("utf8");
  const validText = bytes && Buffer.from(text, "utf8").equals(bytes)
    && /^Copilot SDK smoke test passed at [^\r\n]+(?:\r?\n)?$/.test(text);
  const file = !before || !after ? null
    : before.path !== filePath || after.path !== filePath || typeof before.exists !== "boolean"
      || !bytes || !["regular", "symlink", "directory"].includes(after.kind) ? null
      : before.exists === false && after.kind === "regular" && Boolean(validText);
  const cat = raw.cat;
  const catBytes = cat ? decode(cat.stdoutBase64) : null;
  const readback = !cat ? null : !Array.isArray(cat.argv) || !Number.isInteger(cat.exitCode) || !catBytes ? null
    : cat.exitCode === 0 && JSON.stringify(cat.argv) === JSON.stringify(["cat", filePath])
      && catBytes.includes(Buffer.from("smoke test passed"));
  const calculation = raw.bash;
  const output = calculation ? decode(calculation.stdoutBase64) : null;
  const arithmetic = !calculation ? null
    : !Array.isArray(calculation.argv) || !Number.isInteger(calculation.exitCode) || !output ? null
      : calculation.program === "/bin/bash"
        && JSON.stringify(calculation.argv) === JSON.stringify(["-c", "echo $((6 * 7))"])
        && calculation.exitCode === 0 && output.equals(Buffer.from("42\n"));
  return {
    deliveredAt: raw.deliveredAt,
    fileContentFacet: file,
    catReadback: readback,
    bashCalculation: arithmetic,
    fileCatBytesAgree: bytes && catBytes ? bytes.equals(catBytes) : null,
    currentDateTimeCorrect: null,
    fullFileWritingTask: file === false ? false : null,
    fullSourceConjunction: [file, readback, arithmetic].includes(false) ? false : null,
    interpretation: "Native byte/operation predicates only. This pure interpretation supplies neither custody nor SDK attribution; unspecified date/time spelling needs an independently reviewed clock witness.",
  };
}

export function validateSourceArchive(value) {
  if (value.repository !== "github/gh-aw" || value.repositoryId !== 1036865607
    || value.revision !== sourceRevision || value.cutoff !== "2026-10-18T15:00:12Z"
    || !Array.isArray(value.sources) || !Array.isArray(value.missing) || !Array.isArray(value.responses)) {
    throw new Error("Source archive scope mismatch");
  }
  const seen = new Set();
  for (const row of value.sources) {
    const bytes = decode(row.contentBase64), key = `${row.commit}:${row.path}`;
    if (!bytes || seen.has(key) || !/^[a-f0-9]{40}$/.test(row.commit)
      || !/^[\w./-]+$/.test(row.path) || row.path.split("/").some(part => part === "..")
      || digest(bytes) !== row.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== row.gitBlob) {
      throw new Error("Source archive byte/Git identity mismatch");
    }
    seen.add(key);
  }
  const main = value.sources.find(row => row.commit === sourceRevision && row.path === workflowPath);
  if (main?.gitBlob !== workflowBlob) throw new Error("Missing frozen SDK workflow original");
  for (const name of ["shared/smoke-test-brevity.md", "shared/reporting.md"]) {
    if (!seen.has(`${sourceRevision}:.github/workflows/${name}`)) throw new Error("Missing direct source import");
  }
  return value;
}

export function readBundle() {
  const options = { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 };
  const source = validateSourceArchive(readJsonArchive(path.join(proofDirectory, "source.json.gz"), options));
  const discovery = readJsonArchive(path.join(proofDirectory, "discovery.json.gz"), options);
  if (discovery.index.repository !== "github/gh-aw" || discovery.index.repositoryId !== 1036865607
    || discovery.index.sourceRevision !== sourceRevision || discovery.index.until !== source.cutoff
    || discovery.index.complete !== true || discovery.index.partitions.length !== 346
    || discovery.index.totalEntities !== 58048 || !Array.isArray(discovery.entities)
    || !Array.isArray(discovery.directNumbers) || !Array.isArray(discovery.absentReferences)) {
    throw new Error("Discovery archive scope mismatch");
  }
  const numbers = new Set(), ids = new Set();
  for (const row of discovery.entities) {
    if (!positive(row.number) || typeof row.id !== "string" || ids.has(row.id) || numbers.has(row.number)
      || row.repository !== "github/gh-aw" || !Array.isArray(row.relatedCandidates)) {
      throw new Error("Discovery archive identity mismatch");
    }
    numbers.add(row.number); ids.add(row.id);
  }
  const absent = new Set(discovery.absentReferences);
  if (absent.size !== discovery.absentReferences.length
    || discovery.absentReferences.some(number => !positive(number) || numbers.has(number))
    || discovery.directNumbers.some(number => !numbers.has(number))) throw new Error("Discovery closure mismatch");
  for (const row of discovery.entities) for (const target of row.relatedCandidates) {
    if (!numbers.has(target) && !absent.has(target)) throw new Error("Truncated forward discovery closure");
  }
  const compiled = readJsonArchive(path.join(proofDirectory, "compiled-source.json.gz"), options);
  const compiledBytes = decode(compiled.contentBase64), responseBytes = decode(compiled.responseBase64);
  if (!compiledBytes || !responseBytes || compiled.repository !== source.repository
    || compiled.repositoryId !== source.repositoryId || compiled.revision !== sourceRevision
    || compiled.path !== workflowPath.replace(/\.md$/, ".lock.yml")
    || compiled.gitBlob !== "d7144cb8e1a7a8fe52b8548bd7b290f95bc5b677"
    || digest(compiledBytes) !== compiled.sha256
    || createHash("sha1").update(`blob ${compiledBytes.length}\0`).update(compiledBytes).digest("hex") !== compiled.gitBlob
    || digest(responseBytes) !== compiled.receipt.bodySha256 || compiled.receipt.status !== 200
    || compiled.receipt.endpoint !== `repos/github/gh-aw/git/blobs/${compiled.gitBlob}`) {
    throw new Error("Compiled source original/custody mismatch");
  }
  const response = JSON.parse(responseBytes);
  if (response.sha !== compiled.gitBlob || response.encoding !== "base64" || response.size !== compiledBytes.length
    || !Buffer.from(response.content, "base64").equals(compiledBytes)) throw new Error("Compiled original response mismatch");
  return { source, discovery, compiled };
}

export function verifyHistoricalAdoption(source = readBundle().source) {
  const archive = readJsonArchive(path.join(proofDirectory, "adoption-originals.json.gz"));
  const expected = ["60c72bd3c202e9ae9d1af3363aca0919adafb0d6", "55ad98f2bdc6a6f1c0538383f58fa92b2f0ec9af"];
  if (archive.repository !== "github/gh-aw" || archive.repositoryId !== 1036865607
    || archive.parentManifestSha256 !== "610f47d3279fb279cff0017301864c6e0ca72fa70c6bc5f41a528fef5a23e101"
    || archive.originals.length !== 2) throw new Error("Adoption source scope mismatch");
  for (const [index, row] of archive.originals.entries()) {
    const bytes = decode(row.contentBase64), response = decode(row.responseBase64);
    if (!bytes || !response || row.receipt.sha !== expected[index] || row.receipt.status !== 200
      || row.receipt.endpoint !== `repos/github/gh-aw/git/blobs/${expected[index]}`
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expected[index]
      || digest(bytes) !== row.receipt.blobSha256 || digest(response) !== row.receipt.bodySha256
      || !Buffer.from(JSON.parse(response).content, "base64").equals(bytes)) throw new Error("Adoption original identity mismatch");
  }
  const commit = "bb8c9da4da014da05cecdea2e148eb596b50b7b2", parent = "f7fbd651e3e4ebf69a9cddcfda267fc87134cb27";
  const log = source.responses.find(row => row.args[0] === "log");
  if (log?.status !== 0 || !decode(log.stdoutBase64)?.toString().split("\n")
    .includes(`${commit} ${parent} 2026-02-14T09:16:36-08:00`)) throw new Error("Adoption real-parent metadata missing");
  for (const [index, name] of [workflowPath, workflowPath.replace(/\.md$/, ".lock.yml")].entries()) {
    for (const ref of [commit, parent]) {
      const row = source.responses.find(item => JSON.stringify(item.args) === JSON.stringify(["ls-tree", ref, "--", name]));
      const actual = row && decode(row.stdoutBase64)?.toString();
      const expectedTree = ref === parent ? "" : `100644 blob ${expected[index]}\t${name}\n`;
      if (row?.status !== 0 || actual !== expectedTree) throw new Error("Adoption real-parent addition mismatch");
    }
  }
  const text = decode(archive.originals[0].contentBase64).toString();
  if (!text.includes("engine: copilot-sdk") || !text.includes("Smoke Test for Copilot SDK Engine")) {
    throw new Error("Introduction content is not the SDK workflow");
  }
  return { commit, adoptedAt: "2026-02-14T17:16:36Z", baselineCommit: null, baselineAt: null,
    sourceEra: "Introduction goal was repository analysis/issue/label/comment smoke work, NOT the later file/readback/arithmetic goal. All unverified intervening eras remain null." };
}

export function inspectProtectedOriginals() {
  const candidate = inspectCandidateOriginals(), { source } = readBundle();
  const profile = readJsonArchive(path.join(proofDirectory, "run-compiled-source.json.gz"));
  const compiled = decode(profile.contentBase64), response = decode(profile.responseBase64);
  if (!compiled || !response || profile.revision !== candidate.headSha
    || profile.gitBlob !== "d3868b2f9d1c637afbdf6895ad8b33ae0db88f3e"
    || digest(compiled) !== "60df3593c4b5021e6b6fc2772d8fd1578c3b573bbf00d602319408e3b88f6472"
    || digest(response) !== "ff7785148aa872c69e226e9ab8de900d0468245ec7847478c79af63f91a9b80b"
    || createHash("sha1").update(`blob ${compiled.length}\0`).update(compiled).digest("hex") !== profile.gitBlob
    || !Buffer.from(JSON.parse(response).content, "base64").equals(compiled)
    || profile.receipt.status !== 200 || profile.receipt.endpoint !== `repos/github/gh-aw/git/blobs/${profile.gitBlob}`) {
    throw new Error("Contemporaneous compiled source mismatch");
  }
  const host = readJsonArchive(path.join(proofDirectory, "protected-host-originals.json.gz"));
  const zip = decode(host.contentBase64);
  if (!zip || digest(zip) !== "71a55adf3296c216aa2ff9699aca6f8f10373e8eaebcbccda7d57c4086f58847"
    || host.runId !== candidate.runId || host.attempt !== candidate.attempt || host.headSha !== candidate.headSha
    || host.repository !== "github/gh-aw" || host.repositoryId !== 1036865607 || host.receipt.status !== 200
    || host.receipt.endpoint !== "repos/github/gh-aw/actions/runs/38984382289/attempts/1/logs"
    || host.parentManifestSha256 !== "de5bc11972995560907ecb455a734dbd8a715b8805c1e3554195995370e9d986") {
    throw new Error("Protected original attempt custody mismatch");
  }
  const bindings = new Map(decode(host.sourceBindings.stdoutBase64).toString().trim().split("\n").map(line => {
    const match = line.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("Malformed run source binding");
    return [match[2], match[1]];
  }));
  if (host.sourceBindings.status !== 0 || host.sourceBindings.args[1] !== candidate.headSha
    || bindings.get(workflowPath) !== workflowBlob || bindings.get(workflowPath.replace(/\.md$/, ".lock.yml")) !== profile.gitBlob) {
    throw new Error("Run source scope mismatch");
  }
  for (const name of [workflowPath, ".github/workflows/shared/reporting.md", ".github/workflows/shared/smoke-test-brevity.md",
    "actions/setup/js/copilot_sdk_driver.cjs", "actions/setup/js/copilot_sdk_session.cjs"]) {
    if (!source.sources.some(row => row.path === name && row.gitBlob === bindings.get(name))) {
      throw new Error(`Missing contemporaneous source original: ${name}`);
    }
  }
  const projected = projectNativeZip("protected-host", zip, members => {
    const agentLog = members.find(row => row.path === "3_agent.txt");
    if (!agentLog) throw new Error("Protected agent log missing");
    const lines = agentLog.content.toString("utf8").split(/\r?\n/), events = [];
    for (const [index, line] of lines.entries()) {
      const separator = line.indexOf(" "), text = line.slice(separator + 1);
      if (separator < 0 || !text.startsWith('{"type":')) continue;
      const event = JSON.parse(text);
      if (["tool.execution_start", "tool.execution_complete"].includes(event.type)
        && event.data?.toolCallId === "call_9zs4nrJMKN2rlFd4EPNhZx2r") {
        events.push({ line: index + 1, hostTimestamp: line.slice(0, separator), event });
      }
    }
    return { events, driverSession: lines.some(line => line.includes("[copilot-sdk-driver] [sdk-driver] session created: sessionId=18c0f9eb-0d5e-4333-8179-5e430554033c")),
      members: members.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  });
  const originals = readJsonArchive(path.join(proofDirectory, "candidate-originals.json.gz"));
  const jobs = originals.requests.find(row => row.receipt.endpoint.split("?")[0].endsWith("/attempts/1/jobs"));
  const agent = JSON.parse(decode(jobs.contentBase64)).jobs.find(row => row.id === 117252704344);
  const step = agent?.steps.find(row => row.number === 30 && row.name === "Execute GitHub Copilot CLI");
  if (agent?.run_id !== candidate.runId || agent.run_attempt !== 1 || agent.head_sha !== candidate.headSha
    || !step || projected.events.length !== 2 || !projected.driverSession || !candidate.rawNativeCommandAndResultMatch) {
    throw new Error("Protected native SDK job/step identity mismatch");
  }
  const [start, end] = projected.events;
  for (const [hostRow, artifactRow] of [[start, candidate.nativeStart], [end, candidate.nativeCompletion]]) {
    if (hostRow.event.id !== artifactRow.id || hostRow.event.timestamp !== artifactRow.timestamp
      || hostRow.event.type !== artifactRow.type || hostRow.event.data.toolCallId !== artifactRow.data.toolCallId
      || Date.parse(hostRow.hostTimestamp) < Date.parse(step.started_at)
      || Date.parse(hostRow.hostTimestamp) > Date.parse(step.completed_at)) throw new Error("Protected step/native event mismatch");
  }
  if (start.event.data.arguments.command !== candidate.nativeStart.data.arguments.command
    || end.event.data.result.content !== candidate.nativeCompletion.data.result.content
    || end.event.data.shellExecution.exitCode !== 0 || end.event.data.success !== true
    || end.event.data.result.contents?.length !== 1
    || end.event.data.result.contents[0].type !== "shell_exit" || end.event.data.result.contents[0].exitCode !== 0
    || end.event.data.result.contents[0].outputPreview !== "---FILE---\nCopilot SDK smoke test passed at 2026-10-17T00:04:06Z\n---CALC---\n42\n") {
    throw new Error("Protected shell result is not the preserved native operation result");
  }
  const sessionSource = source.sources.find(row => row.path === "actions/setup/js/copilot_sdk_session.cjs");
  const sessionText = decode(sessionSource.contentBase64).toString(), compiledText = compiled.toString();
  if (!sessionText.includes("process.stderr.write") || !compiledText.includes('GH_AW_INFO_AWF_VERSION: "v0.28.59"')
    || !compiledText.includes('"copilot-sdk":"1.0.16"') || !compiledText.includes("copilot_sdk_driver.cjs")) {
    throw new Error("Native SDK capture/producer profile mismatch");
  }
  return { admitted: true, runId: candidate.runId, attempt: 1, headSha: candidate.headSha,
    jobId: agent.id, step: step.number, protectedMembers: projected.members,
    hostEventLines: [start.line, end.line], sdkVersion: "1.0.16", awfVersion: "v0.28.59", cliVersion: "1.0.98",
    deliveredAt: candidate.nativeCompletion.timestamp, catReadbacks: 1, bashCalculations: 1,
    fileEffects: null, fullSourceConjunction: null,
    rawCompound: { toolName: start.event.data.toolName, command: start.event.data.arguments.command,
      exitCode: end.event.data.shellExecution.exitCode,
      stdoutBase64: Buffer.from(end.event.data.result.contents[0].outputPreview).toString("base64") },
    interpretation: "Protected source-owned SDK native event stream, not assistant prose or artifact-only telemetry. Exact successful chained command and shell result establish cat/path/phrase and arithmetic bytes. Absent-before file state and full file-writing/clock proof remain unavailable." };
}

export function readAdmittedNativeReceipts() {
  const proof = inspectProtectedOriginals();
  return [{
    id: "github/gh-aw:38984382289:attempt1:call_9zs4nrJMKN2rlFd4EPNhZx2r",
    sourceRevision: proof.headSha, workflowContribution: { nativeOperations: 2, sdkVersion: proof.sdkVersion },
    raw: {
      runId: proof.runId, attempt: proof.attempt, deliveredAt: proof.deliveredAt,
      sdkCompound: proof.rawCompound,
    },
  }];
}

export function inspectCandidateOriginals() {
  const original = readJsonArchive(path.join(proofDirectory, "candidate-originals.json.gz"),
    { maxDecodedBytes: 16 * 1024 * 1024, maxParts: 128 });
  if (original.repository !== "github/gh-aw" || original.repositoryId !== 1036865607
    || original.runId !== 38984382289 || original.attempt !== 1
    || original.headSha !== "354b5c3423ea95046f4db235f9fea7bb2885aaa8"
    || original.parentManifestSha256 !== "c89c134d65b70d8bf9c603cd85cc731b1e53088282b5470771d852a8105abeed"
    || !Array.isArray(original.requests) || original.requests.length !== 4) throw new Error("Candidate originals scope mismatch");
  for (const row of original.requests) {
    const bytes = Buffer.from(row.contentBase64, "base64");
    if (bytes.toString("base64") !== row.contentBase64 || digest(bytes) !== row.receipt.sha256
      || bytes.length !== row.receipt.bytes || row.receipt.status !== 200) throw new Error("Candidate original byte mismatch");
  }
  const zip = original.requests.find(row => row.receipt.endpoint === "repos/github/gh-aw/actions/artifacts/12081509894/zip");
  const zipBytes = Buffer.from(zip?.contentBase64 ?? "", "base64");
  if (digest(zipBytes) !== "5f0ef590e353a92100110e24de01375dee177e74a1f06cf067d5a7c0e17d1596") {
    throw new Error("Native original ZIP identity mismatch");
  }
  const projection = projectNativeZip("artifact", zipBytes, members => {
    const native = members.filter(row => row.path.startsWith("sandbox/agent/logs/copilot-session-state/") && row.path.endsWith("/events.jsonl"));
    if (native.length !== 1) throw new Error("Ambiguous native SDK session");
    const rows = native[0].content.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return { nativeFile: native[0].path, nativeSha256: native[0].sha256, nativeEvents: rows.length,
      events: rows.filter(row => ["session.start", "session.shutdown", "tool.execution_start", "tool.execution_complete"].includes(row.type)),
      members: members.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  });
  const starts = projection.events.filter(row => row.type === "tool.execution_start" && row.data?.toolName === "bash");
  if (starts.length !== 1) throw new Error("Ambiguous native SDK bash execution");
  const start = starts[0];
  const ends = projection.events.filter(row => row.type === "tool.execution_complete" && row.data?.toolCallId === start.data.toolCallId);
  if (ends.length !== 1) throw new Error("Missing or repeated native SDK completion");
  const complete = ends[0], command = sdkCommand(original.runId);
  const content = complete.data?.result?.content;
  const match = typeof content === "string"
    && content.match(/^---FILE---\n(Copilot SDK smoke test passed at [^\r\n]+\n)---CALC---\n(42\n)<shellId: 0 completed with exit code 0>$/);
  const shapeMatches = start.data.arguments?.command === command && complete.data.shellExecution?.exitCode === 0
    && complete.data.success === true && Boolean(match) && Date.parse(start.timestamp) < Date.parse(complete.timestamp);
  return {
    runId: original.runId, attempt: original.attempt, headSha: original.headSha,
    artifactId: 12081509894, providerZipSha256: digest(zipBytes),
    nativeFile: projection.nativeFile, nativeSha256: projection.nativeSha256,
    nativeEvents: projection.nativeEvents, members: projection.members,
    nativeStart: start, nativeCompletion: complete,
    rawNativeCommandAndResultMatch: shapeMatches,
    nativeObservedFacets: shapeMatches ? { catPhraseReadback: true, arithmeticStdout42: true } : null,
    nativeFileCreation: null, fullSourceConjunction: null, admitted: false,
    missingReason: "Actual SDK start/completion and byte results are retained, but this artifact's event file is in agent-writable /tmp storage. Independent protected capture and contemporaneous driver/profile originals are still required before production admission.",
  };
}

export function measureNativeReceipts(receipts, windowStart, windowEnd) {
  if (!Array.isArray(receipts) || !iso(windowStart) || !iso(windowEnd) || windowStart >= windowEnd) {
    throw new Error("Invalid native delivery period");
  }
  const ids = new Set(), deliveries = new Map();
  for (const receipt of receipts) {
    const fact = interpretRawProbe(receipt.raw);
    if (!fact || typeof receipt.id !== "string" || !receipt.id || ids.has(receipt.id)) {
      throw new Error("Invalid or repeated native delivery identity");
    }
    ids.add(receipt.id);
    const challenge = `${receipt.raw.runId}:${receipt.raw.attempt ?? 1}`;
    for (const facet of ["fileContentFacet", "catReadback", "bashCalculation"]) {
      if (fact[facet] !== true) continue;
      const key = `${challenge}:${facet}`, prior = deliveries.get(key);
      if (!prior || Date.parse(fact.deliveredAt) < Date.parse(prior.deliveredAt)) {
        deliveries.set(key, { facet, deliveredAt: fact.deliveredAt, receiptId: receipt.id });
      }
    }
  }
  const count = key => {
    const verified = [...deliveries.values()].filter(row => row.facet === key
      && Date.parse(row.deliveredAt) >= Date.parse(windowStart)
      && Date.parse(row.deliveredAt) < Date.parse(windowEnd)).length;
    return verified > 0 ? verified : null;
  };
  const fileEffects = count("fileContentFacet"), catReadbacks = count("catReadback"), bashCalculations = count("bashCalculation");
  const values = [fileEffects, catReadbacks, bashCalculations].filter(value => value !== null);
  return { nativeCapabilityFacets: values.length ? values.reduce((a, b) => a + b, 0) : null,
    fileEffects, catReadbacks, bashCalculations, fullSourceConjunction: null,
    acceptedReceiptIds: [...new Set([...deliveries.values()].filter(row => Date.parse(row.deliveredAt) >= Date.parse(windowStart)
      && Date.parse(row.deliveredAt) < Date.parse(windowEnd)).map(row => row.receiptId))] };
}

export function productionAssessment() {
  const { source, discovery, compiled } = readBundle();
  const candidate = inspectCandidateOriginals(), nativeProof = inspectProtectedOriginals();
  const adoption = verifyHistoricalAdoption(source);
  const receipts = readAdmittedNativeReceipts();
  const measurement = measureNativeReceipts(receipts, adoption.adoptedAt, source.cutoff);
  return {
    schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607, revision: sourceRevision,
    cutoff: source.cutoff, interpreterSha256,
    sourceOriginals: source.sources.length + 4,
    absentSourcePaths: source.missing.filter(row => row.gitBlob === null),
    missingSources: source.missing.filter(row => row.gitBlob && ![compiled.gitBlob, "60c72bd3c202e9ae9d1af3363aca0919adafb0d6",
      "55ad98f2bdc6a6f1c0538383f58fa92b2f0ec9af"].includes(row.gitBlob)),
    compiledSource: { gitBlob: compiled.gitBlob, sha256: compiled.sha256, sdkVersion: "1.0.16",
      nativeChecker: "No independent smoke-task assertion established. Generated execution, log parsing, detection and safe-output steps do not themselves verify the three native effects." },
    directCandidates: discovery.directNumbers.length, closureCandidates: discovery.entities.length,
    absentReferences: discovery.absentReferences,
    acceptedNativeReceipts: receipts.length,
    retainedNativeCandidate: { runId: candidate.runId, attempt: candidate.attempt,
      nativeEvents: candidate.nativeEvents, rawNativeCommandAndResultMatch: candidate.rawNativeCommandAndResultMatch,
      nativeObservedFacets: candidate.nativeObservedFacets, admitted: candidate.admitted, missingReason: candidate.missingReason },
    nativeProof, ...measurement,
    repositoryOutcome: { nativeOperations: measurement.nativeCapabilityFacets, unit: "operations", fullGoal: null },
    workflowContribution: { nativeOperations: 2, runId: nativeProof.runId, attempt: 1, sourceRevision: nativeProof.headSha },
    costs: null, decision: "not-rated", historicalAdoption: adoption,
    missingReason: "Two native operations are independently established for this exact contemporaneous run/source profile only; all other source/runtime eras and opportunities remain unknown. File state/clock correctness and independent reporting completeness are unresolved. No full-goal, baseline improvement or cost claim.",
    requestedEvidence: [
      "Complete missing immutable source originals listed by path, commit and Git blob.",
      "Original protected host before/after file bytes tied to run ID, attempt, source revision and delivery timestamp.",
      "Independent current-date/time witness with its exact source-defined formatting/clock context, not an invented timestamp tolerance.",
      "Independent required issue identity/reporting for full workflow acceptance; SDK producer/session linkage is already established for the measured run.",
      "Historical coherent source profiles and contemporaneous protected receipts; acquisition incompleteness is not proof that historical evidence never existed.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("usage: native-smoke-copilot-sdk.mjs");
  console.log(JSON.stringify(productionAssessment(), null, 2));
}
