import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gunzipSync, gzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const output = "docs/operational-value/proof/smoke-ci";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const addition = "42fe9bee6733515d6e875be9e929d3b9b11126db";
const parent = "a7e0dfb04765978f1048e37339e50462cb1fa612";

export function discover(history) {
  const { index, entities } = readOutputHistory(history);
  if (!index.complete || index.repositoryId !== 1036865607
    || index.sourceRevision !== revision || index.until !== "2026-10-18T15:00:12Z") {
    throw new Error("Incomplete or wrong frozen discovery");
  }
  const roots = entities.filter(row => row.workflowReference?.workflowId === "smoke-ci"
    || row.unverifiedWorkflowId === "smoke-ci");
  const reached = new Set(roots.map(row => row.number));
  const adjacency = new Map();
  for (const row of entities) {
    for (const number of row.relatedCandidates) {
      if (!adjacency.has(row.number)) adjacency.set(row.number, new Set());
      if (!adjacency.has(number)) adjacency.set(number, new Set());
      adjacency.get(row.number).add(number);
      adjacency.get(number).add(row.number);
    }
  }
  const queue = [...reached];
  for (let i = 0; i < queue.length; i++) {
    for (const n of adjacency.get(queue[i]) ?? []) {
      if (!reached.has(n)) { reached.add(n); queue.push(n); }
    }
  }
  const present = new Set(entities.map(row => row.number));
  return {
    schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
    revision, cutoff: index.until, indexSha256: sha(readFileSync(path.join(history, "history.json.gz"))),
    reader: ".github/skills/add-operational-value/scripts/collect-output-history.mjs#readOutputHistory",
    completeConnections: index.connections, partitions: index.partitions.length,
    checkedEntities: entities.length, roots: roots.map(row => ({
      number: row.number, createdAt: row.createdAt, workflowReference: row.workflowReference,
      unverifiedWorkflowId: row.unverifiedWorkflowId,
    })),
    closure: {
      kind: "transitive forward and reverse body-reference discovery; not accepted graph edges",
      reachedCount: reached.size,
      presentCount: [...reached].filter(n => present.has(n)).length,
      absentReferences: [...reached].filter(n => !present.has(n)).sort((a, b) => a - b),
      reachedNumbersSha256: sha(JSON.stringify([...reached].sort((a, b) => a - b))),
    },
    limitations: index.limitations,
    acceptance: "None: inventory counts, mutable markers and closure are discovery only.",
  };
}

export function captureSources(gitDirectory) {
  const git = args => execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 16 * 1024 * 1024,
  });
  const records = [];
  const capture = (type, id, label) => {
    const bytes = git(["cat-file", type, id]);
    const actual = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== id) throw new Error("Git object identity mismatch");
    const file = `sources/${id}.${type}.gz`;
    writeFileSync(path.join(output, file), gzipSync(bytes, { level: 9 }));
    records.push({ label, type, gitObject: id, bytes: bytes.length, sha256: sha(bytes), file });
    return bytes;
  };
  mkdirSync(`${output}/sources`, { recursive: true });
  for (const commit of [addition, parent]) {
    const bytes = capture("commit", commit, commit === addition ? "actual addition" : "actual first parent");
    if (commit === addition && !bytes.toString().includes(`parent ${parent}\n`)) throw new Error("Wrong parent");
    const tree = bytes.toString().match(/^tree ([0-9a-f]{40})/)[1];
    capture("tree", tree, `${commit}:root`);
    for (const directory of [".github", ".github/workflows"]) {
      const row = git(["ls-tree", commit, directory]).toString().trim();
      const id = row.match(/^040000 tree ([0-9a-f]{40})\t/)[1];
      capture("tree", id, `${commit}:${directory}`);
    }
  }
  const added = git(["ls-tree", addition, ".github/workflows/smoke-ci.md"]).toString();
  const absent = git(["ls-tree", parent, ".github/workflows/smoke-ci.md"]).toString();
  if (!added.includes("10911c56fd7f0d10b7f888867a0677f2f4693de1") || absent !== "") {
    throw new Error("Actual source introduction not established");
  }
  capture("blob", "435a00b593ced2327e01fd84c7cc93fdb45f8fae", `${revision}:.github/workflows/smoke-ci.md`);
  capture("blob", "9f4219f69b3c4b580f6cfe09c7d8d12ba0e1800c", "9ecb2ebf6b7518ca5eb32f0f248279b51c81f6b4:.github/workflows/smoke-ci.md");
  const goId = git(["rev-parse", `${revision}:pkg/workflow/samples_replay.go`]).toString().trim();
  capture("blob", goId, `${revision}:pkg/workflow/samples_replay.go`);
  return { schemaVersion: 1, records, adoption: {
    commit: addition, parent, adoptedAt: "2026-04-18T11:23:19Z",
    parentAt: "2026-04-18T11:12:12Z", sourceAdded: true,
    caveat: "Workflow introduction is independently established; original agent era is not the later samples era.",
  } };
}

export function importSourceOriginals(manifestPath) {
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha = sha(manifestBytes);
  const profile = manifestSha === "ec8a45664f91e9a2c76c81f29ed48c4e5a44e7b48acb4915b1fc12f2fa642bf5";
  if (!profile && manifestSha !== "45f64fe571821233be90a2a912b7e3fcd0fb081af8c2b85bc303470ec7ea5bd4") {
    throw new Error("Coordinator source manifest integrity mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607) {
    throw new Error("Wrong coordinator source repository");
  }
  const expected = new Set(profile ? [
    "7078fc56482700e6e4fdd60ceb6055abbb1476eb", "dbbf0942dcc7a1558ddd7c868cc5d5ae28b8f41d",
  ] : [
    "6a947c51b5a786279cf8ebda6645db373301bebe", "10911c56fd7f0d10b7f888867a0677f2f4693de1",
    "f09e78eaaf65700ed224e80ca32d7a96bc21a8f9", "b985ab5c518a3d77076cd0962b63c7e62c186032",
  ]);
  const records = manifest.receipts.filter(record => record.workflow === "smoke-ci");
  if (records.length !== expected.size || records.some(record => !expected.has(record.sha))) {
    throw new Error("Wrong smoke-ci source originals scope");
  }
  const originals = records.map(record => {
    if (record.blob !== `${record.sha}.blob` || record.response !== `${record.sha}.response.json`
      || record.status !== 200 || record.method !== "GET"
      || record.endpoint !== `repos/github/gh-aw/git/blobs/${record.sha}`) throw new Error("Invalid provider source receipt");
    const bytes = readFileSync(path.join(path.dirname(manifestPath), record.blob));
    const response = readFileSync(path.join(path.dirname(manifestPath), record.response));
    if (bytes.length !== record.blobBytes || sha(bytes) !== record.blobSha256
      || response.length !== record.bodyBytes || sha(response) !== record.bodySha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== record.sha) {
      throw new Error("Provider/Git source original mismatch");
    }
    return { record, bytes };
  });
  const index = JSON.parse(readFileSync(`${output}/sources.json`));
  index.records = index.records.filter(record => !expected.has(record.gitObject));
  for (const { record, bytes } of originals) {
    const file = `sources/${record.sha}.blob.gz`;
    writeFileSync(path.join(output, file), gzipSync(bytes, { level: 9 }));
    index.records.push({
      label: profile ? "historical CLI reference source; not proof of selected host execution"
        : record.sha === "6a947c51b5a786279cf8ebda6645db373301bebe" ? "frozen samples compiled workflow"
        : record.sha === "b985ab5c518a3d77076cd0962b63c7e62c186032" ? "frozen deterministic replay driver"
          : record.sha === "10911c56fd7f0d10b7f888867a0677f2f4693de1" ? "actual adoption workflow source"
            : "actual adoption compiled workflow",
      type: "blob", gitObject: record.sha, bytes: bytes.length, sha256: sha(bytes), file,
      providerReceipt: {
        endpoint: record.endpoint, method: record.method, status: record.status,
        startedAt: record.startedAt, receivedAt: record.receivedAt,
        originalResponseBytes: record.bodyBytes, originalResponseSha256: record.bodySha256,
        manifestSha256: sha(manifestBytes),
        interpretation: "Complete Git-verified original blob retained; encoded provider envelope is not a replay dependency.",
      },
    });
  }
  writeFileSync(`${output}/sources.json`, `${JSON.stringify(index, null, 2)}\n`);
}

export function importNativeOriginals(manifestPaths) {
  const files = [];
  const roles = new Map([
    ["repos/github/gh-aw/actions/runs/29535137680", "run"],
    ["repos/github/gh-aw/actions/runs/29535137680/artifacts?per_page=100", "artifacts"],
    ["repos/github/gh-aw/actions/runs/29535137680/attempts/1/jobs?per_page=100", "jobs"],
    ["repos/github/gh-aw/actions/runs/29535137680/attempts/1/logs", "expired-logs"],
    ["repos/github/gh-aw/pulls/46077", "pr"],
    ["repos/github/gh-aw/issues/46077/comments?per_page=100", "comments"],
    ["repos/github/gh-aw/issues/46086", "discovery-issue"],
  ]);
  const originals = [];
  for (const manifestPath of manifestPaths) {
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607) {
      throw new Error("Wrong native originals repository");
    }
    for (const record of manifest.requests) {
      if (record.workflow !== "smoke-ci" || !roles.has(record.endpoint) || record.method !== "GET"
        || !/^[a-f0-9]{64}\.(?:json|zip)$/.test(record.file)) throw new Error("Unexpected native original scope");
      const bytes = readFileSync(path.join(path.dirname(manifestPath), record.file));
      if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error("Native original digest mismatch");
      originals.push({ record, bytes, manifestSha256: sha(manifestBytes) });
    }
  }
  if (originals.length !== roles.size || new Set(originals.map(({ record }) => record.endpoint)).size !== roles.size) {
    throw new Error("Incomplete or repeated native original endpoints");
  }
  mkdirSync(`${output}/native`, { recursive: true });
  for (const { record, bytes, manifestSha256 } of originals) {
    const file = `native/${record.sha256}.original.gz`;
    writeFileSync(path.join(output, file), gzipSync(bytes, { level: 9 }));
    files.push({ role: roles.get(record.endpoint), file, bytes: bytes.length, sha256: sha(bytes),
      endpoint: record.endpoint, status: record.status, headers: record.headers,
      receivedAt: record.receivedAt, manifestSha256 });
  }
  const index = JSON.parse(readFileSync(`${output}/native-index.json`));
  index.acquisitionStatus = "one-native-candidate-originals-preserved";
  index.missingReason = "Executed workflow revision and triggering PR are not independently bound; original attempt logs expired with HTTP410. Current target snapshots are not wholesale historical state.";
  index.attempts = [{ runId: 29535137680, attempt: 1, files }];
  writeFileSync(`${output}/native-index.json`, `${JSON.stringify(index, null, 2)}\n`);
}

export function importSecondNativeOriginals(manifestPath) {
  const manifestBytes = readFileSync(manifestPath);
  if (sha(manifestBytes) !== "05e9794a0002980315638cca5a29062b7bc441f8cceb3d971bf73a8ca5244c22") {
    throw new Error("Wrong second native candidate manifest");
  }
  const manifest = JSON.parse(manifestBytes);
  const roles = new Map([
    ["repos/github/gh-aw/actions/runs/28377305309", "run"],
    ["repos/github/gh-aw/pulls/42250", "pr"],
    ["repos/github/gh-aw/issues/42250/comments?per_page=100", "comments"],
  ]);
  if (manifest.repositoryId !== 1036865607 || manifest.repository !== "github/gh-aw"
    || manifest.requests.length !== roles.size) throw new Error("Wrong second native candidate scope");
  const originals = manifest.requests.map(record => {
    if (!roles.has(record.endpoint) || record.status !== 200 || record.method !== "GET"
      || !/^[a-f0-9]{64}\.json$/.test(record.file)) throw new Error("Wrong second native receipt");
    const bytes = readFileSync(path.join(path.dirname(manifestPath), record.file));
    if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error("Second native original mismatch");
    return { record, bytes };
  });
  const files = originals.map(({ record, bytes }) => {
    const file = `native/${record.sha256}.original.gz`;
    writeFileSync(path.join(output, file), gzipSync(bytes, { level: 9 }));
    return { role: roles.get(record.endpoint), file, bytes: bytes.length, sha256: sha(bytes),
      endpoint: record.endpoint, status: record.status, headers: record.headers,
      receivedAt: record.receivedAt, manifestSha256: sha(manifestBytes) };
  });
  const index = JSON.parse(readFileSync(`${output}/native-index.json`));
  index.attempts = index.attempts.filter(attempt => attempt.runId !== 28377305309);
  index.attempts.push({ runId: 28377305309, attempt: 1, files });
  index.acquisitionStatus = "bounded-two-native-candidates-preserved";
  writeFileSync(`${output}/native-index.json`, `${JSON.stringify(index, null, 2)}\n`);
}

export function compactSources() {
  const index = JSON.parse(readFileSync(`${output}/sources.json`));
  if (index.records.some(record => record.member)) throw new Error("Source originals already compacted");
  const objects = {};
  for (const record of index.records) {
    const bytes = gunzipSync(readFileSync(path.join(output, record.file)));
    if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error("Source compaction input mismatch");
    const text = bytes.toString("utf8"), utf8 = Buffer.from(text).equals(bytes);
    objects[record.gitObject] = { encoding: utf8 ? "utf8" : "base64", data: utf8 ? text : bytes.toString("base64") };
  }
  const file = "sources/original-objects.json.br";
  writeFileSync(path.join(output, file), brotliCompressSync(Buffer.from(JSON.stringify({ schemaVersion: 1, objects })), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
  const oldFiles = new Set(index.records.map(record => record.file));
  index.records = index.records.map(record => ({ ...record, file, member: record.gitObject }));
  writeFileSync(`${output}/sources.json`, `${JSON.stringify(index, null, 2)}\n`);
  for (const oldFile of oldFiles) unlinkSync(path.join(output, oldFile));
}

export function importInventoryOriginals(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath));
  const records = manifest.requests.filter(record => record.workflow === "smoke-ci");
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607 || records.length !== 1) {
    throw new Error("Wrong bounded native discovery manifest");
  }
  const record = records[0];
  if (record.file !== "fc384dca0aca9ca59fe805cc0860c09a7fd46e58cbf76b8103325f8969b4f7cf.json"
    || record.sha256 !== "7e7962c3db2c03528603dffce2237b30e0e67c0859d4692641ad5197e84a7004"
    || record.status !== 200 || record.method !== "GET") throw new Error("Wrong bounded discovery original");
  const bytes = readFileSync(path.join(path.dirname(manifestPath), record.file));
  if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error("Discovery original integrity mismatch");
  const document = JSON.parse(bytes);
  if (document.workflow_runs.length !== 2
    || document.workflow_runs.some(run => run.repository.id !== 1036865607)) throw new Error("Discovery identity mismatch");
  mkdirSync(`${output}/native-discovery`, { recursive: true });
  const file = `native-discovery/${record.sha256}.json.gz`;
  writeFileSync(path.join(output, file), gzipSync(bytes, { level: 9 }));
  const index = JSON.parse(readFileSync(`${output}/native-index.json`));
  index.discoveryReceipts = [{
    file, bytes: bytes.length, sha256: sha(bytes), endpoint: record.endpoint,
    method: record.method, status: record.status, receivedAt: record.receivedAt,
    inventoryComplete: false,
    limitation: "Only first two workflow-run entries before cutoff. Pagination remains; not an execution census or proof that samples-era runs do not exist.",
  }];
  writeFileSync(`${output}/native-index.json`, `${JSON.stringify(index, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--source-originals") {
    importSourceOriginals(process.argv[3]);
    process.exit(0);
  }
  if (process.argv[2] === "--inventory-originals") {
    importInventoryOriginals(process.argv[3]);
    process.exit(0);
  }
  if (process.argv[2] === "--native-originals") {
    importNativeOriginals(process.argv.slice(3));
    process.exit(0);
  }
  if (process.argv[2] === "--second-native-originals") {
    importSecondNativeOriginals(process.argv[3]);
    process.exit(0);
  }
  if (process.argv[2] === "--compact-sources") {
    compactSources();
    process.exit(0);
  }
  const [history, gitDirectory] = process.argv.slice(2);
  if (!history || !gitDirectory) throw new Error("usage: node scripts/collect-smoke-ci.mjs HISTORY GIT_DIR");
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/discovery.json.gz`, gzipSync(`${JSON.stringify(discover(history))}\n`));
  writeFileSync(`${output}/sources.json`, `${JSON.stringify(captureSources(gitDirectory), null, 2)}\n`);
}
