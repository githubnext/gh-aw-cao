import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { historicalRevisions } from "./collect-gh-aw-operational-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { graphQuery, normalizeGraphEntity, parseWorkflowReference, validateRunReference } from "./trace-operational-outcomes.mjs";
import { collectProof, definition, eligiblePath, scoreMetric, study } from "../tests/fixtures/operational-value-proof/file-diet.mjs";

const root = path.resolve(import.meta.dirname, "..");
const instrument = fileURLToPath(import.meta.url);
const modulePath = path.join(root, "tests/fixtures/operational-value-proof/file-diet.mjs");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const maxRequests = 120;

export const newlineCount = bytes => bytes.reduce((count, byte) => count + Number(byte === 10), 0);

export function verifyReceipt(candidate) {
  const receipt = candidate.receipt;
  if (receipt.status !== "available") return false;
  assert.equal(String(receipt.runId), candidate.runId);
  assert.equal(receipt.headSha, candidate.headSha);
  assert.equal(receipt.archiveSha256, receipt.digest.replace(/^sha256:/, ""));
  assert.equal(hash(receipt.content), receipt.entrySha256);
  const item = receipt.content.trim().split("\n").map(line => JSON.parse(line))
    .find(row => row.type === "create_issue" && row.number === candidate.number);
  assert.ok(item, "No create_issue result for the selected File Diet issue");
  assert.equal(item.repo, study.repository);
  assert.equal(item.metadata.node_id, candidate.id);
  assert.equal(item.url, `https://github.com/${study.repository}/issues/${candidate.number}`);
  return true;
}

export function verifyProof(proof) {
  assert.equal(proof.schemaVersion, 1);
  assert.deepEqual(proof.study, study);
  assert.equal(proof.instrumentSha256, hash(readFileSync(instrument)), "File Diet instrument changed");
  assert.equal(proof.functionSha256, hash(readFileSync(modulePath)), "File Diet function changed");
  assert.equal(hash(proof.intent.content), study.sourceSha256);
  assert.ok(Number.isFinite(Date.parse(proof.observedAt)));
  for (const inventory of Object.values(proof.inventories)) {
    assert.equal(inventory.inventoryDigest, censusDigest(inventory.files));
    const paths = inventory.files.map(item => item.path);
    assert.equal(paths.length, new Set(paths).size);
    assert.ok(inventory.files.every(item => eligiblePath(item.path) && /^[a-f0-9]{40}$/.test(item.blob)
      && Number.isSafeInteger(item.lines) && item.lines >= 0
      && Number.isSafeInteger(item.bytes) && item.bytes >= item.lines));
    assert.equal(inventory.coverageStatus, "complete");
  }
  assert.equal(proof.snapshots.length, historicalRevisions.length);
  proof.snapshots.forEach((snapshot, index) => {
    assert.deepEqual([snapshot.endAt, snapshot.commit], historicalRevisions[index]);
    assert.equal(snapshot.inventoryDigest, proof.inventories[snapshot.commit].inventoryDigest);
    assert.deepEqual(snapshot.files, proof.inventories[snapshot.commit].files);
    assert.equal(snapshot.oversized, snapshot.files.filter(item => item.lines >= study.threshold).length);
  });
  for (const candidate of proof.candidates) {
    assert.equal(candidate.creatorVerified, verifyReceipt(candidate));
    assert.equal(candidate.historyComplete, candidate.graph.historyComplete);
    assert.equal(candidate.id, candidate.graph.id);
    assert.equal(candidate.number, candidate.graph.number);
    assert.equal(candidate.createdAt, candidate.graph.createdAt);
    assert.equal(candidate.graph.repository, study.repository);
    assert.equal(candidate.graph.url, `https://github.com/${study.repository}/issues/${candidate.number}`);
    assert.equal(candidate.runValidation.status, "verified-run-reference");
    assert.equal(candidate.runValidation.sourcePath, study.sourcePath);
    assert.equal(candidate.runValidation.executionPath, study.sourcePath.replace(/\.md$/, ".lock.yml"));
    assert.equal(candidate.runValidation.headSha, candidate.headSha);
    assert.equal(candidate.runValidation.url,
      new URL(`/${study.repository}/actions/runs/${candidate.runId}`, candidate.graph.url).href);
    const inventory = proof.inventories[candidate.headSha];
    assert.ok(inventory, "Missing producer-revision file inventory");
    const target = inventory.files.find(item => item.path === candidate.targetPath);
    const maximum = Math.max(...inventory.files.map(item => item.lines));
    assert.equal(candidate.correctTarget, Boolean(target && target.lines >= study.threshold && target.lines === maximum));
    assert.equal(candidate.targetLines, target?.lines ?? null);
    assert.equal(candidate.largestLines, maximum);
    const closers = candidate.graph.edges.filter(edge => edge.relation === "closed-by").map(edge => edge.target.id);
    assert.deepEqual(candidate.closingPullRequests.map(item => item.id), closers);
    const related = candidate.graph.edges.filter(edge => edge.relation === "referenced-by"
      && edge.target.url.startsWith(`https://github.com/${study.repository}/pull/`)).map(edge => edge.target.id);
    assert.deepEqual(candidate.relatedPullRequests.map(item => item.id), related);
    for (const pull of candidate.relatedPullRequests) {
      const files = proof.inventories[pull.headSha].files;
      assert.equal(pull.targetLinesAfter, files.find(item => item.path === candidate.targetPath)?.lines ?? null);
      assert.deepEqual(pull.newGoFiles, pull.files.filter(item => item.status === "added" && eligiblePath(item.filename))
        .map(item => ({ path: item.filename, lines: files.find(file => file.path === item.filename)?.lines ?? null })));
    }
    assert.equal(candidate.gates, null, "This instrument does not fabricate refactor safeguards");
  }
  return proof;
}

export function readProof(file) {
  const proof = readCensusJson(file);
  proof.inventories = {};
  for (const part of proof.inventoryPartitions) {
    assert.equal(part.file, path.basename(part.file));
    assert.match(part.file, /^[a-zA-Z0-9_-]+\.json\.gz$/);
    const inventory = readCensusJson(path.join(path.dirname(file), part.file));
    assert.equal(censusDigest(inventory), part.sha256, "Inventory partition digest mismatch");
    assert.equal(inventory.commit, part.commit);
    assert.ok(!Object.hasOwn(proof.inventories, part.commit));
    proof.inventories[part.commit] = inventory;
  }
  proof.snapshots = proof.snapshots.map(item => ({ ...item, files: proof.inventories[item.commit].files }));
  return proof;
}

export function writeProof(file, proof) {
  const serialized = structuredClone(proof);
  const prefix = path.basename(file).replace(/\.json(?:\.gz)?$/, "");
  serialized.inventoryPartitions = [];
  for (const inventory of Object.values(proof.inventories)) {
    const name = `${prefix}-inventory-${inventory.commit}.json.gz`;
    writeCensusJson(path.join(path.dirname(file), name), inventory);
    assert.ok(readFileSync(path.join(path.dirname(file), name)).length < 256 * 1024);
    serialized.inventoryPartitions.push({ file: name, commit: inventory.commit, sha256: censusDigest(inventory) });
  }
  delete serialized.inventories;
  serialized.snapshots = serialized.snapshots.map(({ files: _files, ...item }) => item);
  writeCensusJson(file, serialized);
}

export async function acquireProof() {
  let requests = 0;
  const get = (endpoint, query = null, binary = false) => {
    assert.ok(++requests <= maxRequests, "File Diet API budget exceeded");
    const args = query ? ["api", "graphql", "-f", `query=${query}`] : ["api", endpoint];
    const result = execFileSync("gh", args, { encoding: binary ? "buffer" : "utf8",
      maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    return binary ? result : JSON.parse(result);
  };
  const query = `repo:${study.repository} "gh-aw-workflow-id: ${study.workflow}" in:body created:${study.since}..${study.until}`;
  const search = get(`search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=100`);
  assert.ok(Array.isArray(search.items) && search.total_count <= 100 && !search.incomplete_results, "Incomplete exact-workflow discovery");
  const selected = search.items.filter(item => Date.parse(item.created_at) >= Date.parse(study.since)
    && Date.parse(item.created_at) < Date.parse(study.until) && item.title.startsWith("[file-diet]") && !item.pull_request);
  const document = get("graphql", graphQuery(study.repository, selected.map(item => item.number)));
  assert.ok(!document.errors?.length, "Issue graph query failed");
  const candidates = [];
  for (const item of selected) {
    const raw = document.data.repository[`n${item.number}`];
    const graph = normalizeGraphEntity(raw, new Date().toISOString());
    const reference = parseWorkflowReference(raw.body, study.repository);
    assert.equal(reference?.workflowId, study.workflow);
    const run = get(`repos/${study.repository}/actions/runs/${reference.runId}`);
    const validation = validateRunReference(reference, run, study.sourcePath, study.repository);
    const artifacts = get(`repos/${study.repository}/actions/runs/${reference.runId}/artifacts?per_page=100`);
    assert.equal(artifacts.total_count, artifacts.artifacts.length, "Truncated artifact inventory");
    const artifact = artifacts.artifacts.find(value => value.name === "safe-outputs-items");
    let receipt = { status: "missing", reason: "No retained safe-output creation artifact" };
    if (artifact && !artifact.expired) {
      const metadata = get(`repos/${study.repository}/actions/artifacts/${artifact.id}`);
      assert.ok(metadata.size_in_bytes < 2 * 1024 * 1024);
      const zipBytes = get(`repos/${study.repository}/actions/artifacts/${artifact.id}/zip`, null, true);
      assert.equal(`sha256:${hash(zipBytes)}`, metadata.digest);
      assert.equal(metadata.workflow_run.head_sha, validation.headSha);
      const temporary = mkdtempSync(path.join(os.tmpdir(), "file-diet-receipt-"));
      try {
        const zip = path.join(temporary, "receipt.zip");
        writeFileSync(zip, zipBytes);
        const content = execFileSync("unzip", ["-p", zip, "safe-output-items.jsonl"], { encoding: "utf8", maxBuffer: 64 * 1024 });
        receipt = { status: "available", artifactId: artifact.id, runId: metadata.workflow_run.id,
          headSha: metadata.workflow_run.head_sha, digest: metadata.digest,
          archiveSha256: hash(zipBytes), entrySha256: hash(content), content };
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    const targetPath = raw.body.match(/pkg\/[a-zA-Z0-9_./-]+\.go\b/)?.[0] ?? null;
    const closingPullRequests = [];
    for (const edge of graph.edges.filter(edge => edge.relation === "closed-by")) {
      const pull = get(`repos/${study.repository}/pulls/${edge.target.number}`);
      assert.equal(pull.node_id, edge.target.id);
      closingPullRequests.push({ id: edge.target.id, number: pull.number, mergedAt: pull.merged_at,
        mergeCommit: pull.merge_commit_sha });
    }
    const relatedPullRequests = [];
    for (const edge of graph.edges.filter(edge => edge.relation === "referenced-by"
      && edge.target.url.startsWith(`https://github.com/${study.repository}/pull/`))) {
      assert.ok(relatedPullRequests.length < 20, "Cross-reference follow-up budget exceeded");
      const pull = get(`repos/${study.repository}/pulls/${edge.target.number}`);
      assert.equal(pull.node_id, edge.target.id);
      const files = get(`repos/${study.repository}/pulls/${edge.target.number}/files?per_page=100`);
      assert.equal(files.length, pull.changed_files, "Truncated related-PR change inventory");
      relatedPullRequests.push({ id: edge.target.id, number: pull.number, state: pull.state,
        mergedAt: pull.merged_at, headSha: pull.head.sha, observedAt: new Date().toISOString(),
        files: files.map(file => ({ filename: file.filename, status: file.status })) });
    }
    candidates.push({
      number: graph.number, id: graph.id, createdAt: graph.createdAt, graph,
      runId: reference.runId, headSha: validation.headSha, runValidation: validation,
      targetPath, receipt, creatorVerified: false, historyComplete: graph.historyComplete,
      closingPullRequests, relatedPullRequests, gates: null,
    });
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "file-diet-git-"));
  const git = (args, options = {}) => execFileSync("git", ["--git-dir", temporary, ...args],
    { encoding: "utf8", maxBuffer: 96 * 1024 * 1024, timeout: 180_000, ...options });
  let inventories;
  let intent;
  let uniqueBlobs;
  try {
    git(["init", "--bare", "--quiet"]);
    git(["remote", "add", "origin", `https://github.com/${study.repository}.git`]);
    git(["config", "remote.origin.promisor", "true"]);
    git(["config", "remote.origin.partialclonefilter", "blob:none"]);
    const revisions = [...new Set([...historicalRevisions.map(([, commit]) => commit), ...candidates.map(item => item.headSha),
      ...candidates.flatMap(item => item.relatedPullRequests.map(pull => pull.headSha))])];
    git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags", "origin", ...revisions]);
    const trees = Object.fromEntries(revisions.map(commit => [commit,
      git(["ls-tree", "-r", "-z", commit, "--", "pkg"]).split("\0").filter(Boolean).flatMap(entry => {
        const tab = entry.indexOf("\t");
        const [mode, type, blob] = entry.slice(0, tab).split(" ");
        const file = entry.slice(tab + 1);
        return type === "blob" && ["100644", "100755"].includes(mode) && eligiblePath(file) ? [{ path: file, blob }] : [];
      }),
    ]));
    const blobs = [...new Set(Object.values(trees).flatMap(files => files.map(item => item.blob)))];
    assert.ok(blobs.length < 20_000, "Go blob inventory budget exceeded");
    for (let offset = 0; offset < blobs.length; offset += 500) {
      git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "--stdin"],
        { input: `${blobs.slice(offset, offset + 500).join("\n")}\n` });
    }
    const output = git(["cat-file", "--batch"], { input: `${blobs.join("\n")}\n`, encoding: null });
    const counts = new Map();
    let offset = 0;
    for (const id of blobs) {
      const end = output.indexOf(10, offset);
      const [actual, type, size] = output.subarray(offset, end).toString("utf8").split(" ");
      assert.equal(actual, id);
      assert.equal(type, "blob");
      const bytes = output.subarray(end + 1, end + 1 + Number(size));
      assert.equal(blobHash(bytes), id);
      const lines = newlineCount(bytes);
      assert.equal(lines, Number(execFileSync("wc", ["-l"], { input: bytes, encoding: "utf8" }).trim()),
        "Independent wc -l disagrees with byte counting");
      counts.set(id, { lines, bytes: bytes.length });
      offset = end + 1 + Number(size) + 1;
    }
    assert.equal(offset, output.length);
    inventories = Object.fromEntries(Object.entries(trees).map(([commit, files]) => {
      const rows = files.map(item => ({ ...item, ...counts.get(item.blob) }));
      return [commit, { commit, coverageStatus: "complete", files: rows, inventoryDigest: censusDigest(rows) }];
    }));
    intent = { content: git(["show", `${study.sourceRevision}:${study.sourcePath}`]) };
    uniqueBlobs = blobs.length;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  for (const candidate of candidates) {
    const files = inventories[candidate.headSha].files;
    const target = files.find(item => item.path === candidate.targetPath);
    candidate.targetLines = target?.lines ?? null;
    candidate.largestLines = Math.max(...files.map(item => item.lines));
    candidate.correctTarget = Boolean(target && target.lines >= study.threshold && target.lines === candidate.largestLines);
    candidate.creatorVerified = verifyReceipt(candidate);
    for (const pull of candidate.relatedPullRequests) {
      const files = inventories[pull.headSha].files;
      pull.targetLinesAfter = files.find(item => item.path === candidate.targetPath)?.lines ?? null;
      pull.newGoFiles = pull.files.filter(item => item.status === "added" && eligiblePath(item.filename))
        .map(item => ({ path: item.filename, lines: files.find(file => file.path === item.filename)?.lines ?? null }));
    }
  }
  const proof = {
    schemaVersion: 1, study, observedAt: new Date().toISOString(),
    instrumentSha256: hash(readFileSync(instrument)), functionSha256: hash(readFileSync(modulePath)),
    intent, inventories, candidates,
    discovery: { query, complete: true, totalCount: search.total_count, selectedCount: selected.length,
      excluded: search.items.filter(item => !selected.some(row => row.number === item.number))
        .map(item => ({ number: item.number, reason: "Outside exact creation window or not the source-declared File Diet refactoring issue output" })) },
    snapshots: historicalRevisions.map(([endAt, commit]) => ({ endAt, ...inventories[commit],
      oversized: inventories[commit].files.filter(item => item.lines >= study.threshold).length })),
    acquisition: { requests, limit: maxRequests, uniqueBlobs, lineCountOracle: "Each distinct raw Go blob was checked against system wc -l.",
      replayLimitation: "Offline replay reaggregates preserved complete per-file counts. Raw source-byte reacquisition uses the immutable Git blob identities; full source text is not duplicated in the archive." },
  };
  return verifyProof(proof);
}

export function writeReports(proof, output) {
  verifyProof(proof);
  mkdirSync(output, { recursive: true });
  const requests = proof.snapshots.map(item => ({
    windowStart: new Date(Date.parse(item.endAt) - 7 * 86_400_000).toISOString().replace(".000Z", "Z"),
    windowEnd: item.endAt, observedAt: proof.observedAt,
  }));
  const results = collectProof(proof, requests);
  const observations = path.join(output, "file-diet-observations.json");
  writeFileSync(observations, JSON.stringify({
    generatedAt: proof.observedAt, repository: study.repository, workflowName: definition.workflowName,
    adoptionAt: definition.adoption.adoptedAt, evaluationMode: "attainment-only",
    window: { startAt: requests[0].windowStart, endAt: proof.observedAt },
    evidenceCoverage: { scope: study.limitation, fullGoInventories: true, discovery: proof.discovery },
    snapshots: results.map((item, index) => ({ ...item, observedAt: proof.observedAt,
      window: { startAt: requests[index].windowStart, endAt: requests[index].windowEnd } })), runs: [],
  }, null, 2));
  const timeline = path.join(output, `${study.workflow}-timeline.json`);
  const markdown = path.join(output, `${study.workflow}-definitions.md`);
  for (const [script, args] of [
    ["build-timeline.mjs", [modulePath, observations, timeline]],
    ["render-definitions.mjs", [timeline, markdown]],
    ["validate-report-artifacts.mjs", [timeline, markdown]],
  ]) execFileSync(process.execPath, [path.join(root, ".github/skills/add-operational-value/scripts", script), ...args], { stdio: "pipe" });
  return { timeline, markdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === instrument) {
  const [mode, file, ...args] = process.argv.slice(2);
  if (!["--acquire", "--replay"].includes(mode) || !file
    || (args.length && (args.length !== 2 || args[0] !== "--output-dir"))) throw new Error(
    "usage: prove-file-diet-operational-value.mjs (--acquire NEW.json.gz | --replay PROOF.json.gz) [--output-dir DIR]");
  if (mode === "--acquire" && existsSync(file)) throw new Error("Refusing to replace an existing File Diet proof");
  const proof = mode === "--acquire" ? await acquireProof() : verifyProof(readProof(file));
  if (mode === "--acquire") {
    mkdirSync(path.dirname(file), { recursive: true });
    writeProof(file, proof);
  }
  const requests = proof.snapshots.map(item => ({
    windowStart: new Date(Date.parse(item.endAt) - 7 * 86_400_000).toISOString(), windowEnd: item.endAt,
  }));
  console.log(JSON.stringify({
    snapshots: collectProof(proof, requests).map((item, index) => ({ endAt: proof.snapshots[index].endAt,
      metrics: Object.fromEntries(definition.metrics.map(metric => [metric.id, scoreMetric(metric.id, item.evidence)])) })),
    candidates: proof.candidates.map(item => ({ number: item.number, creatorVerified: item.creatorVerified,
      targetPath: item.targetPath, targetLines: item.targetLines, largestLines: item.largestLines,
      correctTarget: item.correctTarget, state: item.graph.state, reason: item.graph.stateReason,
      closingPullRequests: item.closingPullRequests, relatedPullRequests: item.relatedPullRequests })),
    acquisition: proof.acquisition, reports: args.length ? writeReports(proof, args[1]) : null,
  }, null, 2));
}
