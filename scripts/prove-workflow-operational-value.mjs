import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import { historicalRevisions } from "./collect-gh-aw-operational-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { validateRunReference } from "./trace-operational-outcomes.mjs";
import { collectProof, definition, study } from "../tests/fixtures/operational-value-proof/rendering.mjs";

const root = path.resolve(import.meta.dirname, "..");
const modulePath = path.join(root, "tests/fixtures/operational-value-proof/rendering.mjs");
const instrumentPath = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");
const codeRoot = "actions/setup/js/";
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const apiLimit = 160;
const nodeRequire = createRequire(import.meta.url);
class MissingReplaySource extends Error {
  constructor(file) {
    super(`Missing pinned source ${file}`);
    this.file = file;
  }
}

export function projectInput(content) {
  const events = content.split("\n").filter(line => line.trim().startsWith("{")).map(line => JSON.parse(line));
  const failures = events.filter(item => item.type === "turn_end" && item.message?.errorMessage);
  assert.equal(failures.length, 1, "The frozen case requires exactly one observed provider failure");
  const message = failures[0].message;
  assert.deepEqual(message.content, []);
  const error = JSON.parse(message.errorMessage.replace(/^400: /, ""));
  assert.deepEqual(error, {
    message: "The requested model is not supported.", code: "model_not_supported",
    param: "model", type: "invalid_request_error",
  }, "Retain only the known, non-sensitive provider diagnostic");
  assert.equal(message.role, "assistant");
  assert.equal(message.stopReason, "error");
  return JSON.stringify({
    type: "turn_end", message: {
      role: message.role, content: [], stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    }, toolResults: [],
  });
}

export function replayParser(proof, state) {
  const cache = new Map();
  const context = vm.createContext({
    Buffer, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder,
    process: { env: {}, platform: "linux", cwd: () => "/replay" },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  });
  function source(name) {
    const blob = proof.sources[state.files[name]];
    if (!blob) throw new MissingReplaySource(name);
    assert.equal(blob.path, name);
    assert.equal(sha256(blob.content), blob.sha256, `Source digest mismatch: ${name}`);
    assert.equal(gitBlob(blob.content), state.files[name], `Git blob mismatch: ${name}`);
    return blob.content;
  }
  const resource = file => {
    assert.equal(path.dirname(file), "/replay", "Only pinned parser resources may be read");
    return source(path.basename(file));
  };
  const builtins = {
    ...Object.fromEntries(["assert", "buffer", "events", "stream", "string_decoder", "url", "zlib"]
      .map(name => [name, nodeRequire(`node:${name}`)])),
    fs: { existsSync: file => { resource(file); return true; },
      readFileSync: (file, encoding) => encoding ? resource(file) : Buffer.from(resource(file)) },
    path, os: { homedir: () => "/replay" },
    util: { isDeepStrictEqual }, crypto: { createHash }, async_hooks: { AsyncLocalStorage },
  };
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const content = source(name);
    if (name.endsWith(".json")) {
      const exports = JSON.parse(content);
      cache.set(name, { exports });
      return exports;
    }
    const module = { exports: {} };
    cache.set(name, module);
    const require = specifier => {
      const builtin = specifier.replace(/^node:/, "");
      if (Object.hasOwn(builtins, builtin)) return builtins[builtin];
      assert.match(specifier, /^\.\/[a-zA-Z0-9_-]+\.(?:cjs|json)$/, `Unexpected parser dependency ${specifier}`);
      return load(specifier.slice(2));
    };
    const previous = context.loader;
    context.loader = { require, module, filename: `/replay/${name}` };
    try {
      vm.runInContext(`(function(require,module,exports,__filename,__dirname) {\n${content}\n})(loader.require,loader.module,loader.module.exports,loader.filename,"/replay")`,
        context, { timeout: 3000, filename: name });
    } finally {
      context.loader = previous;
    }
    if (name === "log_parser_shared.cjs") {
      module.exports.createEngineLogParser = () => () => { throw new Error("Actions I/O is outside this pure-parser replay"); };
    }
    return module.exports;
  }
  context.parser = load("parse_pi_log.cjs");
  context.input = proof.input.projected;
  const result = JSON.parse(vm.runInContext("JSON.stringify(parser.parsePiLog(input))", context, { timeout: 3000 }));
  return {
    rendered: result.markdown.includes("model_not_supported"),
    normalized: result.logEntries.some(item => {
      const errors = item.type === "result" ? item.errors
        : item.type === "session.result" ? item.data?.errors
          : item.type === "session.error" ? [item.data?.error] : [];
      return Array.isArray(errors) && errors.some(error => typeof error === "string" && error.includes("model_not_supported"));
    }),
    resultSha256: censusDigest(result),
  };
}

export function verifyProof(proof) {
  assert.equal(proof.schemaVersion, 1);
  assert.deepEqual(proof.study, study);
  assert.ok(instant(proof.observedAt));
  assert.equal(proof.instrumentSha256, sha256(readFileSync(instrumentPath)), "Proof instrument changed; explicitly reevaluate the preserved evidence");
  assert.equal(proof.functionSha256, sha256(readFileSync(modulePath)), "Proof function changed; explicitly reevaluate the preserved evidence");
  assert.equal(proof.input.projectedSha256, sha256(proof.input.projected));
  assert.equal(projectInput(proof.input.projected), proof.input.projected);
  assert.equal(proof.input.artifact.id, study.inputArtifact);
  assert.equal(String(proof.input.artifact.runId), study.inputRun);
  assert.equal(proof.input.artifact.archiveSha256, proof.input.artifact.digest.replace(/^sha256:/, ""));
  assert.equal(proof.intent.sha256, study.sourceSha256);
  assert.equal(sha256(proof.intent.content), study.sourceSha256);
  assert.match(proof.license, /MIT License/);
  const run = proof.producer;
  validateRunReference({ runId: study.producerRun, attempt: 1 }, run, study.sourcePath, study.repository);
  const artifact = proof.receipt.artifact;
  assert.equal(artifact.id, study.receiptArtifact);
  assert.equal(String(artifact.runId), study.producerRun);
  assert.equal(artifact.headSha, run.head_sha);
  assert.equal(artifact.archiveSha256, artifact.digest.replace(/^sha256:/, ""));
  assert.equal(sha256(proof.receipt.content), proof.receipt.entrySha256);
  const items = proof.receipt.content.trim().split("\n").map(line => JSON.parse(line));
  const receipt = items.find(item => item.type === "create_pull_request" && item.number === study.pullRequest);
  assert.ok(receipt, "No safe-output creation result for this PR");
  assert.equal(receipt.repo, study.repository);
  assert.equal(receipt.metadata.node_id, proof.pullRequest.nodeId);
  assert.equal(receipt.url, `https://github.com/${study.repository}/pull/${study.pullRequest}`);
  assert.ok(instant(receipt.timestamp));
  assert.ok(Date.parse(receipt.timestamp) >= Date.parse(proof.pullRequest.createdAt));
  assert.ok(Date.parse(receipt.timestamp) >= Date.parse(run.created_at));
  assert.ok(Date.parse(receipt.timestamp) <= Date.parse(proof.pullRequest.mergedAt));
  assert.equal(proof.pullRequest.number, study.pullRequest);
  assert.equal(proof.pullRequest.state, "closed");
  assert.equal(proof.repair.merged.commit, proof.pullRequest.mergeCommit);
  assert.equal(proof.repair.original.commit, proof.pullRequest.originalCommit);
  assert.equal(proof.repair.before.commit, proof.pullRequest.originalParent);
  assert.equal(proof.pullRequest.originalParent, run.head_sha, "Original repair must start from the creating run's source revision");
  for (const state of [...Object.values(proof.repair), ...proof.snapshots]) {
    assert.deepEqual(replayParser(proof, state), state.result, `Replay differs at ${state.commit}`);
  }
  assert.equal(proof.repair.before.result.rendered && proof.repair.before.result.normalized, false);
  for (const state of [proof.repair.original, proof.repair.merged]) {
    assert.equal(state.result.rendered && state.result.normalized, true, "Both preservation checks must pass");
  }
  assert.equal(proof.snapshots.length, historicalRevisions.length);
  proof.snapshots.forEach((snapshot, index) => {
    assert.deepEqual([snapshot.endAt, snapshot.commit], historicalRevisions[index]);
    assert.equal(snapshot.rendered, snapshot.result.rendered);
    assert.equal(snapshot.normalized, snapshot.result.normalized);
  });
  assert.deepEqual(proof.connection, {
    producerRun: study.producerRun, pullRequest: study.pullRequest,
    mergedAt: proof.pullRequest.mergedAt,
    creatorVerified: true, originalPatchRepairs: true, mergedRevisionPasses: true,
    limitation: "Creation receipt and controlled code replay establish this repair; later contributors, full workflow coverage, deployment effects and economic benefit are not inferred.",
  });
  return proof;
}

export function readProof(file) {
  const proof = readCensusJson(file);
  if (!proof.sourcePartitions) return proof;
  assert.ok(Array.isArray(proof.sourcePartitions) && proof.sourcePartitions.length <= 16);
  proof.sources = {};
  for (const part of proof.sourcePartitions) {
    assert.equal(part.file, path.basename(part.file), "Source partition must be adjacent to its index");
    assert.match(part.file, /^[a-zA-Z0-9_-]+\.json\.gz$/);
    const sources = readCensusJson(path.join(path.dirname(file), part.file));
    assert.equal(censusDigest(sources), part.sha256, "Source partition digest mismatch");
    for (const [id, value] of Object.entries(sources)) {
      assert.ok(!Object.hasOwn(proof.sources, id), "Duplicate source blob");
      proof.sources[id] = value;
    }
  }
  return proof;
}

export function writeProof(file, proof) {
  const serialized = structuredClone(proof);
  const entries = Object.entries(serialized.sources);
  const prefix = path.basename(file).replace(/\.json(?:\.gz)?$/, "");
  delete serialized.sources;
  serialized.sourcePartitions = [];
  for (let offset = 0; offset < entries.length; offset += 16) {
    const sources = Object.fromEntries(entries.slice(offset, offset + 16));
    const name = `${prefix}-sources-${String(serialized.sourcePartitions.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(path.join(path.dirname(file), name), sources);
    assert.ok(readFileSync(path.join(path.dirname(file), name)).length < 256 * 1024, "Source partition exceeds repository file budget");
    serialized.sourcePartitions.push({ file: name, sha256: censusDigest(sources) });
  }
  writeCensusJson(file, serialized);
}

export function acquireProof() {
  let requests = 0;
  const gh = (endpoint, binary = false) => {
    assert.ok(++requests <= apiLimit, "Read-only acquisition budget exceeded");
    return execFileSync("gh", ["api", endpoint], { encoding: binary ? "buffer" : "utf8", maxBuffer: 8 * 1024 * 1024 });
  };
  const json = endpoint => JSON.parse(gh(`repos/${study.repository}/${endpoint}`));
  const sources = {};
  const blobCache = new Map();
  const blob = id => {
    if (!blobCache.has(id)) {
      const value = json(`git/blobs/${id}`);
      assert.equal(value.encoding, "base64");
      const content = Buffer.from(value.content, "base64").toString("utf8");
      assert.equal(gitBlob(content), id);
      assert.ok(Buffer.byteLength(content) < 256 * 1024);
      blobCache.set(id, content);
    }
    return blobCache.get(id);
  };
  function artifact(id, expectedRun, entry) {
    const metadata = json(`actions/artifacts/${id}`);
    assert.equal(String(metadata.workflow_run.id), String(expectedRun.id));
    assert.equal(metadata.workflow_run.head_sha, expectedRun.head_sha);
    assert.equal(metadata.expired, false);
    assert.ok(metadata.size_in_bytes < 2 * 1024 * 1024);
    const bytes = gh(`repos/${study.repository}/actions/artifacts/${id}/zip`, true);
    assert.equal(`sha256:${sha256(bytes)}`, metadata.digest);
    const temporary = mkdtempSync(path.join(os.tmpdir(), "workflow-value-input-"));
    try {
      const zip = path.join(temporary, "artifact.zip");
      writeFileSync(zip, bytes);
      const content = execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      return {
        content, entrySha256: sha256(content),
        artifact: { id, runId: metadata.workflow_run.id, headSha: metadata.workflow_run.head_sha,
          digest: metadata.digest, archiveSha256: sha256(bytes), entry },
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const rawRun = json(`actions/runs/${study.producerRun}`);
  validateRunReference({ runId: study.producerRun, attempt: 1 }, rawRun, study.sourcePath, study.repository);
  const producer = Object.fromEntries(["id", "path", "head_sha", "run_attempt", "created_at", "html_url"].map(key => [key, rawRun[key]]));
  producer.repository = { full_name: rawRun.repository.full_name };
  const inputRun = json(`actions/runs/${study.inputRun}`);
  assert.equal(inputRun.repository.full_name, study.repository);
  const inputArtifact = artifact(study.inputArtifact, inputRun, "agent-stdio.log");
  const projected = projectInput(inputArtifact.content);
  const receipt = artifact(study.receiptArtifact, rawRun, "safe-output-items.jsonl");
  const pull = json(`pulls/${study.pullRequest}`);
  const commits = json(`pulls/${study.pullRequest}/commits?per_page=100`);
  assert.ok(commits.length > 0 && commits.length < 100, "PR commit inventory is missing or truncated");
  const original = json(`git/commits/${commits[0].sha}`);
  assert.ok(original.parents.length === 1, "Expected one original patch parent");
  const directoryCache = new Map();
  const treeCache = new Map();
  function tree(id) {
    if (!treeCache.has(id)) {
      const value = json(`git/trees/${id}`);
      assert.equal(value.truncated, false, "Truncated source tree");
      treeCache.set(id, value);
    }
    return treeCache.get(id);
  }
  const proof = {
    schemaVersion: 1, study, observedAt: new Date().toISOString(),
    instrumentSha256: sha256(readFileSync(instrumentPath)),
    functionSha256: sha256(readFileSync(modulePath)),
    license: Buffer.from(json(`contents/LICENSE?ref=${study.sourceRevision}`).content, "base64").toString("utf8"),
    intent: { sha256: study.sourceSha256,
      content: Buffer.from(json(`contents/${study.sourcePath}?ref=${study.sourceRevision}`).content, "base64").toString("utf8") },
    producer, receipt,
    input: { artifact: inputArtifact.artifact, rawTranscriptSha256: inputArtifact.entrySha256,
      projected, projectedSha256: sha256(projected),
      projection: "Only the observed empty-content turn and its allowlisted provider diagnostic; no prompts, model IDs, actors or other transcript content." },
    pullRequest: {
      number: pull.number, nodeId: pull.node_id, state: pull.state, createdAt: pull.created_at,
      mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha,
      originalCommit: commits[0].sha, originalParent: original.parents[0].sha,
    },
    sources, repair: {}, snapshots: [],
    connection: {
      producerRun: study.producerRun, pullRequest: study.pullRequest, mergedAt: pull.merged_at,
      creatorVerified: true, originalPatchRepairs: true, mergedRevisionPasses: true,
      limitation: "Creation receipt and controlled code replay establish this repair; later contributors, full workflow coverage, deployment effects and economic benefit are not inferred.",
    },
  };
  function state(commit) {
    if (!directoryCache.has(commit)) {
      let directory = tree(commit);
      for (const segment of codeRoot.split("/").filter(Boolean)) {
        const entry = directory.tree.find(item => item.path === segment && item.type === "tree");
        assert.ok(entry, `Missing source tree ${segment}`);
        directory = tree(entry.sha);
      }
      directoryCache.set(commit, new Map(directory.tree.filter(item => item.type === "blob").map(item => [item.path, item.sha])));
    }
    const directory = directoryCache.get(commit);
    const files = {};
    function visit(name) {
      assert.ok(!Object.hasOwn(files, name), `Unresolved dependency ${name}`);
      assert.ok(Object.keys(files).length < 64, "Parser dependency budget exceeded");
      const id = directory.get(name);
      assert.ok(id, `Missing dependency ${name} at ${commit}`);
      const content = blob(id);
      sources[id] = { path: name, content, sha256: sha256(content) };
      files[name] = id;
    }
    const value = { commit, files };
    while (true) {
      try {
        value.result = replayParser(proof, value);
        return value;
      } catch (error) {
        if (!(error instanceof MissingReplaySource)) throw error;
        visit(error.file);
      }
    }
  }
  proof.repair.before = state(proof.pullRequest.originalParent);
  proof.repair.original = state(proof.pullRequest.originalCommit);
  proof.repair.merged = state(proof.pullRequest.mergeCommit);
  for (const [endAt, commit] of historicalRevisions) {
    const snapshot = state(commit);
    proof.snapshots.push({ ...snapshot, endAt, ...snapshot.result });
  }
  proof.acquisition = { requests, limit: apiLimit, readOnly: true };
  return verifyProof(proof);
}

export function writeReports(proof, output) {
  verifyProof(proof);
  mkdirSync(output, { recursive: true });
  const windows = proof.snapshots.map(snapshot => ({
    windowStart: new Date(Date.parse(snapshot.endAt) - 7 * 86_400_000).toISOString().replace(".000Z", "Z"),
    windowEnd: snapshot.endAt, observedAt: proof.observedAt,
  }));
  const snapshots = collectProof(proof, windows).map((item, index) => ({
    ...item, observedAt: proof.observedAt,
    window: { startAt: windows[index].windowStart, endAt: windows[index].windowEnd },
  }));
  const observations = path.join(output, "observations.json");
  writeFileSync(observations, JSON.stringify({
    generatedAt: proof.observedAt, repository: study.repository, workflowName: definition.workflowName,
    adoptionAt: definition.adoption.adoptedAt, evaluationMode: "attainment-only",
    window: { startAt: windows[0].windowStart, endAt: proof.observedAt },
    evidenceCoverage: { scope: study.limitation, independentInput: true, creatorReceipt: true },
    snapshots, runs: [],
  }, null, 2));
  const scripts = path.join(root, ".github/skills/add-operational-value/scripts");
  const timeline = path.join(output, `${study.workflow}-timeline.json`);
  const markdown = path.join(output, `${study.workflow}-definitions.md`);
  for (const [script, args] of [
    ["build-timeline.mjs", [modulePath, observations, timeline]],
    ["render-definitions.mjs", [timeline, markdown]],
    ["validate-report-artifacts.mjs", [timeline, markdown]],
  ]) execFileSync(process.execPath, [path.join(scripts, script), ...args], { stdio: "pipe" });
  return { timeline, markdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === instrumentPath) {
  const [mode, input, ...args] = process.argv.slice(2);
  if (!["--acquire", "--replay"].includes(mode) || !input
    || (args.length && (args.length !== 2 || args[0] !== "--output-dir"))) {
    throw new Error("usage: prove-workflow-operational-value.mjs (--acquire NEW.json.gz | --replay PROOF.json.gz) [--output-dir DIR]");
  }
  if (mode === "--acquire" && existsSync(input)) throw new Error("Refusing to replace an immutable proof");
  const proof = mode === "--acquire" ? acquireProof() : verifyProof(readProof(input));
  if (mode === "--acquire") {
    mkdirSync(path.dirname(input), { recursive: true });
    writeProof(input, proof);
  }
  const reports = args.length ? writeReports(proof, args[1]) : null;
  console.log(JSON.stringify({
    workflow: study.workflow, scope: study.limitation,
    repair: Object.fromEntries(Object.entries(proof.repair).map(([key, value]) => [key, value.result])),
    snapshots: proof.snapshots.map(item => ({ endAt: item.endAt, ...item.result })),
    creatorReceipt: proof.connection.creatorVerified, reports,
  }, null, 2));
}
