import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = fileURLToPath(new URL("../docs/operational-value/proof/durable-metrics/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function collect() {
  const contract = JSON.parse(readFileSync(path.join(directory, "frozen-contract-v1.json")));
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const receipts = {};
  let requests = 0;
  const request = (label, endpoint) => {
    assert.match(label, /^[a-z0-9-]+$/);
    const file = `originals/${label}.json.gz`, destination = path.join(directory, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      assert.ok(++requests <= 110, "Durable metrics acquisition budget exceeded");
      const body = execFileSync("gh", ["api", endpoint],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
      packet = { endpoint, observedAt: new Date().toISOString(), body, sha256: hash(body) };
      writeJsonArchive(destination, packet);
    }
    assert.equal(packet.endpoint, endpoint);
    assert.equal(hash(packet.body), packet.sha256, `Original changed: ${label}`);
    receipts[label] = { file, archiveSha256: hash(readFileSync(destination)), bodySha256: packet.sha256 };
    return JSON.parse(packet.body);
  };
  const repository = request("repository", `repos/${contract.repository}`);
  assert.equal(repository.id, contract.repositoryId);
  assert.equal(repository.full_name, contract.repository);
  assert.equal(repository.private, false);
  assert.equal(repository.visibility, "public");
  const ref = request("backing-ref", `repos/${contract.repository}/git/ref/heads/${contract.storage.branch}`);
  assert.equal(ref.ref, `refs/heads/${contract.storage.branch}`);
  assert.equal(ref.object.type, "commit");
  assert.match(ref.object.sha, /^[a-f0-9]{40}$/);
  const files = request("daily-directory",
    `repos/${contract.repository}/contents/${contract.storage.dailyPath}?ref=${ref.object.sha}`);
  assert.ok(Array.isArray(files) && files.length < 1000, "Daily directory listing may be truncated");
  const selected = files.filter(row => row.type === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(row.name)
    && row.name.slice(0, 10) <= contract.cutoff.slice(0, 10))
    .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 3);
  const records = selected.map(row => {
    assert.equal(row.path, `${contract.storage.dailyPath}/${row.name}`);
    assert.match(row.sha, /^[a-f0-9]{40}$/);
    const blob = request(`snapshot-${row.name.slice(0, 10)}`, `repos/${contract.repository}/git/blobs/${row.sha}`);
    assert.equal(blob.sha, row.sha);
    assert.equal(blob.encoding, "base64");
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(bytes.length, blob.size);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), row.sha);
    const snapshot = JSON.parse(bytes.toString("utf8"));
    return { path: row.path, gitBlob: row.sha, timestamp: snapshot.timestamp,
      window: snapshot.collection_window ?? null, workflowNames: Object.keys(snapshot.workflows ?? {}) };
  });
  const workflows = {};
  for (const slug of contract.selection.workflows) {
    const workflow = request(`workflow-${slug}`, `repos/${contract.repository}/actions/workflows/${slug}.lock.yml`);
    assert.equal(workflow.path, `.github/workflows/${slug}.lock.yml`);
    assert.ok(Number.isSafeInteger(workflow.id) && workflow.id > 0);
    workflows[slug] = { id: workflow.id, path: workflow.path };
  }
  for (const record of records) {
    record.runPages = {};
    const { start, end } = record.window ?? {};
    const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
      && Number.isFinite(Date.parse(value));
    if (!utc(start) || !utc(end) || start >= end || end > contract.cutoff) {
      record.windowDisposition = "No valid mature explicit collection window; native run reconciliation is unavailable.";
      continue;
    }
    for (const [slug, workflow] of Object.entries(workflows)) {
      const labels = [];
      let retrieved = 0, total = null;
      for (let page = 1; page <= 10; page++) {
        const label = `runs-${record.path.split("/").at(-1).slice(0, 10)}-${slug}-${page}`;
        const runs = request(label, `repos/${contract.repository}/actions/workflows/${workflow.id}/runs?created=${encodeURIComponent(`${start}..${end}`)}&per_page=100&page=${page}`);
        assert.ok(Number.isSafeInteger(runs.total_count) && runs.total_count >= 0 && Array.isArray(runs.workflow_runs));
        if (total === null) total = runs.total_count;
        assert.equal(runs.total_count, total, "Run pagination population changed");
        retrieved += runs.workflow_runs.length;
        labels.push(label);
        if (retrieved >= total) break;
        assert.equal(runs.workflow_runs.length, 100, "Run pagination ended before its declared population");
      }
      record.runPages[slug] = { labels, declaredTotal: total, retrieved, complete: retrieved === total };
    }
  }
  request("adoption", `repos/${contract.repository}/commits/${contract.adoption.commit}`);
  request("baseline", `repos/${contract.repository}/commits/${contract.adoption.parent}`);
  request("frozen-source", `repos/${contract.repository}/contents/.github/workflows/metrics-collector.md?ref=${contract.revision}`);
  request("frozen-runtime", `repos/${contract.repository}/contents/.github/workflows/metrics-collector.lock.yml?ref=${contract.revision}`);
  const index = { schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    revision: contract.revision, cutoff: contract.cutoff, backingCommit: ref.object.sha,
    contractSha256: hash(readFileSync(path.join(directory, "frozen-contract-v1.json"))),
    records, workflows, receipts, nativeEvaluationComplete: false,
    limitation: "Original backing-branch bytes are retained; run-population reconciliation is not yet complete. Timestamp claims and structurally valid snapshots are not accepted value." };
  writeJsonArchive(path.join(directory, "index.json.gz"), index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = collect();
  console.log(JSON.stringify({ backingCommit: index.backingCommit, snapshots: index.records.map(row => ({
    path: row.path, timestamp: row.timestamp, window: row.window, workflows: row.workflowNames.length,
    runPages: row.runPages,
  })), originals: Object.keys(index.receipts).length }));
}
