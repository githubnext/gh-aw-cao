import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import {
  acceptance, cutoff, discoveryClosure, hash, jsonHash, repository, repositoryId,
  revision, sourcePath, sourceBlob, verifyBlob, workflow, parsePiTranscript, verifyProtectedRedis,
} from "./native-smoke-service-ports.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs/operational-value/proof/smoke-service-ports");
const write = (name, value) => writeJsonArchive(path.join(output, name), value, {
  spacing: 0, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
});
const sourcePaths = [
  sourcePath, sourcePath.replace(".md", ".lock.yml"),
  ".github/workflows/shared/otlp.md",
  ".github/workflows/shared/token-telemetry-check.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/session-artifact-check.md",
  "pkg/workflow/service_ports.go", "pkg/workflow/service_ports_test.go",
  "pkg/cli/compile_service_ports_integration_test.go", "pkg/cli/workflows/test-service-ports.md",
];

export function collectLocalSources(gitDirectory, compiledPacket) {
  const git = args => spawnSync("git", [`--git-dir=${gitDirectory}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  const required = args => {
    const result = git(args);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  if (required(["remote", "get-url", "origin"]) !== `https://github.com/${repository}.git`) {
    throw new Error("Source cache repository mismatch");
  }
  const blobs = new Map(), missing = [], originalReceipts = [];
  if (compiledPacket) {
    const manifestBytes = readFileSync(path.join(compiledPacket, "manifest.json"));
    if (hash(manifestBytes) !== "efa9349fc0c7caebdc006f42eb0c4576abef8a9ff5f3eb1d99707b128445c27a") {
      throw new Error("Centrally acquired compiled-source manifest mismatch");
    }
    const manifest = JSON.parse(manifestBytes);
    const receipt = manifest.receipts.find(row => row.workflow === workflow);
    if (manifest.repositoryId !== repositoryId || receipt?.sha !== "4f0217d28e8e17e7d015e08921d1db5ca4696cf8") {
      throw new Error("Compiled-source receipt scope mismatch");
    }
    const bytes = readFileSync(path.join(compiledPacket, receipt.blob));
    const responseBytes = readFileSync(path.join(compiledPacket, receipt.response));
    if (hash(bytes) !== receipt.blobSha256 || bytes.length !== receipt.blobBytes
      || hash(responseBytes) !== receipt.bodySha256 || responseBytes.length !== receipt.bodyBytes) {
      throw new Error("Original compiled-source receipt mismatch");
    }
    const response = JSON.parse(responseBytes);
    if (response.sha !== receipt.sha || response.encoding !== "base64"
      || !Buffer.from(response.content, "base64").equals(bytes)) throw new Error("Compiled-source response mismatch");
    verifyBlob(bytes, receipt.sha);
    blobs.set(receipt.sha, { blob: receipt.sha, sha256: hash(bytes), content: bytes.toString("base64") });
    originalReceipts.push({ receipt, response: responseBytes.toString("base64"),
      manifestSha256: hash(manifestBytes), scope: "Only smoke-service-ports receipt; unrelated SDK source excluded." });
  }
  const missingObject = result => result.status === 128
    && /Not a valid object name|could not get object info|bad file|bad object|lazy fetching disabled|could not fetch/i.test(result.stderr);
  const readSource = (commit, file) => {
    const treeResult = git(["ls-tree", commit, "--", file]);
    if (treeResult.error) throw treeResult.error;
    if (treeResult.status !== 0) {
      if (!missingObject(treeResult)) throw new Error(treeResult.stderr);
      const gap = { commit, path: file, state: "tree-unavailable", stderr: treeResult.stderr.trim() };
      missing.push(gap);
      return gap;
    }
    const entry = treeResult.stdout.trim();
    if (!entry) return { commit, path: file, state: "absent" };
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error("Unsupported source tree entry");
    const blob = match[1];
    if (!blobs.has(blob)) {
      const result = git(["cat-file", "blob", blob]);
      if (result.error) throw result.error;
      if (result.status !== 0) {
        if (!missingObject(result)) throw new Error(result.stderr);
        const gap = { commit, path: file, blob, state: "content-unavailable", stderr: result.stderr.trim() };
        missing.push(gap);
        return gap;
      }
      const bytes = Buffer.from(result.stdout);
      verifyBlob(bytes, blob);
      blobs.set(blob, { blob, sha256: hash(bytes), content: bytes.toString("base64") });
    }
    return { commit, path: file, blob, sha256: blobs.get(blob).sha256, state: "available" };
  };
  const current = sourcePaths.map(file => readSource(revision, file));
  if (current[0].blob !== sourceBlob || current[0].state !== "available") throw new Error("Frozen workflow unavailable or changed");
  const history = required(["log", "--format=%H", revision, "--", sourcePath]).split("\n");
  const eras = history.map(commit => {
    const raw = required(["cat-file", "commit", commit]);
    const parent = raw.match(/^parent ([a-f0-9]{40})$/m)?.[1] ?? null;
    const timestamp = raw.match(/^committer .+ (\d+) [+-]\d{4}$/m)?.[1];
    if (!timestamp) throw new Error("Malformed immutable commit clock");
    return { commit, parent, committedAt: new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z"),
      rawCommit: `${raw}\n`, source: readSource(commit, sourcePath),
      parentSource: parent ? readSource(parent, sourcePath) : null };
  });
  return { repository, repositoryId, revision, current, eras, blobs: [...blobs.values()], missing, originalReceipts,
    historicalLimitation: "Shallow/partial Git cache: missing contents are not readable metadata; source history is not assumed exhausted.",
    nativeCheckerDisposition: "Compiler tests check argument generation, port parsing and runtime rejection, not observed Redis protocol responses.",
  };
}

export function readCandidatePacket(receiptDirectory) {
  const manifestBytes = readFileSync(path.join(receiptDirectory, "manifest.json"));
  if (hash(manifestBytes) !== "c89c134d65b70d8bf9c603cd85cc731b1e53088282b5470771d852a8105abeed") {
    throw new Error("Candidate acquisition manifest changed");
  }
  const manifest = JSON.parse(manifestBytes);
  const inputs = manifest.requests.filter(row => row.workflow === workflow).map(receipt => {
    const bytes = readFileSync(path.join(receiptDirectory, receipt.file));
    if (bytes.length !== receipt.bytes || hash(bytes) !== receipt.sha256) throw new Error("Original candidate receipt changed");
    return { receipt, content: bytes.toString("base64") };
  });
  const response = suffix => JSON.parse(Buffer.from(inputs.find(row => row.receipt.endpoint.endsWith(suffix)).content, "base64"));
  const run = response("/38987730359");
  const artifacts = response("/38987730359/artifacts?per_page=100");
  const artifact = artifacts.artifacts.find(row => row.id === 12084001298);
  const zip = inputs.find(row => row.receipt.endpoint.endsWith("/12084001298/zip"));
  if (manifest.repositoryId !== repositoryId || run.id !== 38987730359 || run.run_attempt !== 1
    || run.head_sha !== "7597eb9ca2da8362f551d4bc74cb9113835b16f8"
    || run.repository.id !== repositoryId || run.path !== ".github/workflows/smoke-service-ports.lock.yml"
    || artifacts.total_count !== artifacts.artifacts.length || artifact.name !== "agent"
    || artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
    || artifact.digest !== `sha256:${zip.receipt.sha256}`) throw new Error("Original run/artifact custody mismatch");
  const members = extractZip(zip.content);
  const streaming = members.find(row => row.file === "pi-streaming.jsonl");
  const parsed = parsePiTranscript(Buffer.from(streaming.content, "base64").toString("utf8"));
  return { manifestSha256: hash(manifestBytes), inputs, members, parsed,
    run: { id: run.id, attempt: run.run_attempt, head: run.head_sha, createdAt: run.created_at },
    artifact: { id: artifact.id, digest: artifact.digest },
    admission: "Uploaded transcript requires separate protected original producer corroboration." };
}

function extractZip(content) {
  return JSON.parse(execFileSync("python", ["-c", `
import sys,json,zipfile,io,base64,hashlib,re
data=base64.b64decode(sys.stdin.read(),validate=True)
out=[]
with zipfile.ZipFile(io.BytesIO(data)) as z:
 entries=z.infolist()
 if len(entries)>256 or sum(x.file_size for x in entries)>16000000: raise ValueError("ZIP budget exceeded")
 names=set()
 for entry in entries:
  if entry.filename in names or entry.filename.startswith("/") or ".." in entry.filename.split("/") or (entry.external_attr>>16)&0o170000==0o120000: raise ValueError("Unsafe ZIP member")
  names.add(entry.filename)
  b=z.read(entry)
  if re.search(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|npm_[A-Za-z0-9]{30,})",b): raise ValueError("Credential-shaped data cannot be retained")
  out.append({"file":entry.filename,"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest(),"content":base64.b64encode(b).decode()})
print(json.dumps(out))
`], { input: content, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

export function readProtectedPackets(directory) {
  const specs = [
    ["native-sdk-redis-run-source-20261019", "f149203e66f2ec72111f3ff55ee8a57cb73b560c3b92312a2f1b655fed0baa0c", "receipts"],
    ["native-redis-run-jobs-20261019", "87b37982d4c9d34669cc5f88b16bb99a175a36af2bfda89694a679c6c7e893a7", "requests"],
    ["native-sdk-redis-attempt-logs-20261019", "de5bc11972995560907ecb455a734dbd8a715b8805c1e3554195995370e9d986", "requests"],
  ];
  const inputs = specs.flatMap(([name, digest, field]) => {
    const manifest = readFileSync(path.join(directory, name, "manifest.json"));
    if (hash(manifest) !== digest) throw new Error("Protected original acquisition manifest changed");
    const parsed = JSON.parse(manifest);
    if (parsed.repositoryId !== repositoryId) throw new Error("Protected acquisition repository mismatch");
    return parsed[field].filter(row => row.workflow === workflow).map(receipt => {
      const bytes = readFileSync(path.join(directory, name, receipt.file ?? receipt.response));
      if (bytes.length !== (receipt.bytes ?? receipt.bodyBytes)
        || hash(bytes) !== (receipt.sha256 ?? receipt.bodySha256)) throw new Error("Protected original input changed");
      return { manifestSha256: digest, receipt, content: bytes.toString("base64") };
    });
  });
  const sourceInput = inputs.find(row => row.receipt.endpoint.includes("/git/blobs/"));
  const sourceResponse = JSON.parse(Buffer.from(sourceInput.content, "base64"));
  const sourceBytes = readFileSync(path.join(directory, specs[0][0], sourceInput.receipt.blob));
  if (sourceBytes.length !== sourceInput.receipt.blobBytes || hash(sourceBytes) !== sourceInput.receipt.blobSha256
    || sourceResponse.sha !== sourceInput.receipt.sha || sourceResponse.encoding !== "base64"
    || !sourceBytes.equals(Buffer.from(sourceResponse.content, "base64"))) {
    throw new Error("Original actual-head compiled blob differs from its provider response");
  }
  verifyBlob(sourceBytes, "47ce50ac9931c8d9960f2fae8b88dae6e00c2ecf");
  const logs = inputs.find(row => row.receipt.endpoint.endsWith("/attempts/1/logs"));
  return { inputs, sourceBytes: sourceBytes.toString("base64"), logMembers: extractZip(logs.content) };
}

export function produce(gitDirectory, historyDirectory, compiledPacket, receiptDirectory, protectedDirectory) {
  mkdirSync(output, { recursive: true });
  const frozen = { ...acceptance, frozenAt: new Date().toISOString(),
    designBasis: "Immutable source requirements only, before reading candidate outcomes." };
  const contractFile = path.join(output, "contract.json");
  if (existsSync(contractFile)) {
    const previous = readJsonArchive(contractFile);
    if (jsonHash({ ...previous, frozenAt: null }) !== jsonHash({ ...frozen, frozenAt: null })) {
      throw new Error("Refusing to replace an existing frozen acceptance contract");
    }
  } else write("contract.json", frozen);
  const sources = collectLocalSources(gitDirectory, compiledPacket);
  if (receiptDirectory) {
    sources.runHeadBindings = execFileSync("git", [`--git-dir=${gitDirectory}`, "ls-tree",
      "7597eb9ca2da8362f551d4bc74cb9113835b16f8", "--", ...sourcePaths], {
      encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    sources.runHeadCommit = execFileSync("git", [`--git-dir=${gitDirectory}`, "cat-file", "commit",
      "7597eb9ca2da8362f551d4bc74cb9113835b16f8"], {
      encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  }
  write("sources.json.gz", sources);
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== repository || index.repositoryId !== repositoryId
    || index.until !== cutoff || index.sourceRevision !== revision || index.partitions.length !== 346
    || entities.length !== 58048) throw new Error("Frozen history scope mismatch");
  const historyOutput = path.join(output, "history");
  mkdirSync(historyOutput, { recursive: true });
  const inputFiles = ["history.json.gz", ...index.partitions.map(row => row.file)];
  const members = inputFiles.map(file => {
    const bytes = readFileSync(path.join(historyDirectory, file));
    return { file, sha256: hash(bytes), bytes: bytes.length, content: bytes.toString("base64") };
  });
  writeJsonArchive(path.join(historyOutput, "inputs.json.gz"), members, {
    spacing: 0, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
  });
  const closure = discoveryClosure(entities);
  write("discovery.json.gz", { index, closure });
  const candidate = receiptDirectory ? readCandidatePacket(receiptDirectory) : null;
  if (candidate) write("candidate-receipts.json.gz", candidate);
  const protectedInputs = protectedDirectory ? readProtectedPackets(protectedDirectory) : null;
  if (protectedInputs) write("protected-receipts.json.gz", protectedInputs);
  const nativeReceipts = candidate && protectedInputs ? verifyProtectedRedis(candidate, protectedInputs) : [];
  const census = readJsonArchive(path.join(root, "docs/operational-value/gh-aw-census/evidence.json.gz"));
  const runMetadata = census.runInventory.filter(row => row.path === sourcePath);
  const packet = {
    schemaVersion: 1, repository, repositoryId, workflow, revision, cutoff,
    contractSha256: hash(readFileSync(contractFile)),
    sourcesSha256: hash(readFileSync(path.join(output, "sources.json.gz"))),
    discoverySha256: hash(readFileSync(path.join(output, "discovery.json.gz"))),
    checkerSha256: hash(readFileSync(path.join(root, "scripts/native-smoke-service-ports.mjs"))),
    candidateSha256: candidate ? hash(readFileSync(path.join(output, "candidate-receipts.json.gz"))) : null,
    protectedSha256: protectedInputs ? hash(readFileSync(path.join(output, "protected-receipts.json.gz"))) : null,
    directCandidates: closure.direct.length, relatedClosure: closure.entities.length,
    absentReferences: closure.absentReferences,
    runMetadata,
    nativeReceipts,
    nativeCoverage: nativeReceipts.length ? "partial" : "missing",
    endpointGaps: [
      nativeReceipts.length ? "One retained source-matched run has independently corroborated native operation receipts; other discovery candidates and actor-independent repository opportunities remain unassessed."
        : "No independently authenticated Redis client/server response payloads, socket receipts or sandbox host-route observations in the authorized retained input.",
      nativeReceipts.length ? "The original protected attempt1 run38987730359 is bound to job117263197566 and provider-verified agent artifact12084001298; this is not a complete run census."
        : "No retained run/attempt/head and protected client/service payload joining receipts for the 17 direct run references.",
      candidate ? "A provider-digest-verified agent ZIP contains parsed Redis tool responses; admission is recomputed from independent original protected execution logs."
        : "Census run/artifact metadata does not contain artifact payloads or raw protocol exchanges.",
    ],
    sourceGaps: sources.missing,
    adoption: { status: "unresolved", reason: "Introduction-era source content and complete history must be distinguished from the apparent path-addition metadata." },
    counts: { eligible: null,
      observedNativeCases: nativeReceipts.length ? nativeReceipts.reduce((sum, row) =>
        sum + Object.values(row.deliveredCases).filter(Boolean).length, 0) : null },
    costs: { status: "not-measured", value: null },
    keep: { status: "not-rated", reason: "No source-grounded keep bar." },
    custody: "Read-only immutable Git cache, digest-verified original production history and centrally acquired original provider receipts; no network, target execution or new endpoint acquisition.",
  };
  write("native-input.json.gz", packet);
  return { packetSha256: hash(readFileSync(path.join(output, "native-input.json.gz"))),
    sourceGaps: packet.sourceGaps.length, candidates: packet.directCandidates, closure: packet.relatedClosure };
}

export function replayInputs() {
  const members = readJsonArchive(path.join(output, "history/inputs.json.gz"), { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  if (members.length !== 347) throw new Error("Incomplete original history input");
  for (const member of members) {
    const bytes = Buffer.from(member.content, "base64");
    if (!/^(?:history|entities-\d{5})\.json\.gz$/.test(member.file)
      || bytes.length !== member.bytes || hash(bytes) !== member.sha256) throw new Error("Original input custody mismatch");
  }
  const sources = readJsonArchive(path.join(output, "sources.json.gz"));
  for (const row of sources.blobs) {
    const bytes = Buffer.from(row.content, "base64");
    verifyBlob(bytes, row.blob);
    if (hash(bytes) !== row.sha256) throw new Error("Source SHA-256 mismatch");
  }
  const packet = readJsonArchive(path.join(output, "native-input.json.gz"));
  for (const [file, expected] of [
    ["contract.json", packet.contractSha256], ["sources.json.gz", packet.sourcesSha256],
    ["discovery.json.gz", packet.discoverySha256],
  ]) if (hash(readFileSync(path.join(output, file))) !== expected) throw new Error("Packet member binding mismatch");
  if (hash(readFileSync(path.join(root, "scripts/native-smoke-service-ports.mjs"))) !== packet.checkerSha256) {
    throw new Error("Native checker identity mismatch");
  }
  const temporary = mkdtempSync(path.join(root, ".smoke-service-ports-history-"));
  let productionHistory;
  try {
    for (const member of members) writeFileSync(path.join(temporary, member.file), Buffer.from(member.content, "base64"));
    productionHistory = readOutputHistory(temporary);
    const discovery = readJsonArchive(path.join(output, "discovery.json.gz"));
    if (jsonHash(discoveryClosure(productionHistory.entities)) !== jsonHash(discovery.closure)) {
      throw new Error("Original production-history closure changed");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (packet.candidateSha256) {
    const candidateFile = path.join(output, "candidate-receipts.json.gz");
    if (hash(readFileSync(candidateFile)) !== packet.candidateSha256) throw new Error("Candidate packet binding changed");
    const candidate = readJsonArchive(candidateFile);
    for (const input of candidate.inputs) {
      if (hash(Buffer.from(input.content, "base64")) !== input.receipt.sha256) throw new Error("Candidate original input mismatch");
    }
    const artifactZip = candidate.inputs.find(row => row.receipt.endpoint.endsWith("/artifacts/12084001298/zip"));
    if (jsonHash(extractZip(artifactZip.content)) !== jsonHash(candidate.members)) {
      throw new Error("Original artifact ZIP extraction replay differs");
    }
    if (packet.protectedSha256) {
      const file = path.join(output, "protected-receipts.json.gz");
      if (hash(readFileSync(file)) !== packet.protectedSha256) throw new Error("Protected receipt packet changed");
      const candidate = readJsonArchive(path.join(output, "candidate-receipts.json.gz"));
      const protectedInputs = readJsonArchive(file);
      for (const input of protectedInputs.inputs) {
        if (hash(Buffer.from(input.content, "base64")) !== (input.receipt.sha256 ?? input.receipt.bodySha256)) {
          throw new Error("Protected original input mismatch");
        }
      }
      const logs = protectedInputs.inputs.find(row => row.receipt.endpoint.endsWith("/attempts/1/logs"));
      if (jsonHash(extractZip(logs.content)) !== jsonHash(protectedInputs.logMembers)) {
        throw new Error("Original protected log ZIP extraction replay differs");
      }
      if (jsonHash(verifyProtectedRedis(candidate, protectedInputs)) !== jsonHash(packet.nativeReceipts)) {
        throw new Error("Independent native observation replay changed");
      }
    }
    for (const member of candidate.members) {
      if (hash(Buffer.from(member.content, "base64")) !== member.sha256) throw new Error("Candidate ZIP member mismatch");
    }
    const streaming = candidate.members.find(row => row.file === "pi-streaming.jsonl");
    if (jsonHash(parsePiTranscript(Buffer.from(streaming.content, "base64").toString("utf8"))) !== jsonHash(candidate.parsed)) {
      throw new Error("Raw native parser replay differs");
    }
  }
  return { inputMembers: members.length, historyEntities: productionHistory.entities.length, sourceBlobs: sources.blobs.length,
    nativeReceipts: packet.nativeReceipts.length, status: "Original bytes, ZIP extractions, parser facts and independent protected native admission replayed; period coverage remains incomplete." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, gitDirectory, historyDirectory, compiledPacket, receiptDirectory, protectedDirectory] = process.argv.slice(2);
  if (command === "--replay") console.log(JSON.stringify(replayInputs()));
  else if (command === "--collect" && gitDirectory && historyDirectory) console.log(JSON.stringify(produce(gitDirectory, historyDirectory, compiledPacket, receiptDirectory, protectedDirectory)));
  else throw new Error("Use --collect GIT_DIRECTORY HISTORY_DIRECTORY or --replay; no acquisition endpoints exist.");
}
