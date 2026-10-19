import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = fileURLToPath(new URL("../docs/operational-value/proof/native-ci/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function collect() {
  const contractFile = path.join(directory, "frozen-contract-v1.json");
  const contract = JSON.parse(readFileSync(contractFile));
  const receipts = {};
  let requests = 0;
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const request = (label, endpoint, query = null) => {
    assert.match(label, /^[a-z0-9-]+$/);
    const file = `originals/${label}.json.gz`, destination = path.join(directory, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      assert.ok(++requests <= contract.acquisition.requestBudget, "CI acquisition budget exceeded");
      const body = execFileSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
      JSON.parse(body);
      packet = { endpoint, query, observedAt: new Date().toISOString(), body, sha256: hash(body) };
      writeJsonArchive(destination, packet);
    }
    assert.equal(packet.endpoint, endpoint);
    assert.equal(packet.query, query);
    assert.equal(hash(packet.body), packet.sha256, `Original changed: ${label}`);
    const value = JSON.parse(packet.body);
    assert.ok(!value.errors, `GitHub acquisition errors: ${JSON.stringify(value.errors)}`);
    receipts[label] = { file, archiveSha256: hash(readFileSync(destination)), bodySha256: packet.sha256 };
    return value;
  };
  const prefix = `repos/${contract.repository}`;
  const metadata = request("repository", prefix);
  assert.equal(metadata.id, contract.repositoryId);
  assert.equal(metadata.full_name, contract.repository);
  assert.equal(metadata.private, false);
  assert.equal(metadata.visibility, "public");
  const adoption = request("adoption", `${prefix}/commits/${contract.adoption.commit}`);
  assert.equal(adoption.parents[0].sha, contract.adoption.parent);
  assert.equal(adoption.commit.committer.date, contract.adoption.adoptedAt);
  assert.equal(adoption.files.find(file => file.filename === contract.adoption.sourcePath)?.status, "added");
  request("baseline", `${prefix}/commits/${contract.adoption.parent}`);
  for (const [label, file, revision] of [
    ["source", contract.adoption.sourcePath, contract.revision],
    ["runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.revision],
    ["initial-source", contract.adoption.sourcePath, contract.adoption.commit],
    ["initial-runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.adoption.commit],
    ["analysis-import", ".github/workflows/shared/ci-data-analysis.md", contract.revision],
    ["strategy-import", ".github/workflows/shared/ci-optimization-strategies.md", contract.revision],
  ]) {
    const blob = request(label, `${prefix}/contents/${file}?ref=${revision}`);
    assert.equal(blob.path, file);
    assert.equal(blob.encoding, "base64");
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    if (label === "source") assert.equal(blob.sha, contract.sourceBlob);
  }
  const history = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
  assert.equal(history.index.repository, contract.repository);
  assert.equal(history.index.repositoryId, contract.repositoryId);
  assert.equal(history.index.sourceRevision, contract.revision);
  assert.equal(history.index.until, contract.cutoff);
  const roots = contract.selection.roots.map(number => {
    const row = history.entities.find(entity => entity.number === number);
    assert.ok(row, `Missing frozen root ${number}`);
    assert.equal(row.workflowReference?.workflowId, contract.workflow);
    return row;
  });
  const candidates = new Set(contract.selection.pulls), graphs = [];
  const pullFields = "number url createdAt mergedAt mergeCommit{oid}";
  for (let start = 0; start < roots.length; start += 10) {
    const batch = roots.slice(start, start + 10);
    const fields = batch.map(row => row.kind === "PullRequest"
      ? `n${row.number}:pullRequest(number:${row.number}){${pullFields}}`
      : `n${row.number}:issue(number:${row.number}){number url createdAt timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){
        pageInfo{hasNextPage} nodes{__typename
        ... on CrossReferencedEvent{createdAt source{__typename ... on PullRequest{${pullFields} repository{databaseId}}}}
        ... on ConnectedEvent{createdAt subject{__typename ... on PullRequest{${pullFields} repository{databaseId}}}}}}}`).join("\n");
    const query = `query{repository(owner:"github",name:"gh-aw"){databaseId ${fields}}}`;
    const label = `roots-${String(start).padStart(3, "0")}`;
    const response = request(label, "graphql", query).data.repository;
    assert.equal(response.databaseId, contract.repositoryId);
    for (const row of batch) {
      const original = response[`n${row.number}`];
      assert.equal(original?.number, row.number);
      assert.ok(original.createdAt < contract.cutoff);
      if (row.kind === "PullRequest") candidates.add(row.number);
      for (const event of original.timelineItems?.nodes ?? []) {
        const pull = event.source ?? event.subject;
        if (pull?.__typename === "PullRequest" && pull.repository.databaseId === contract.repositoryId
          && pull.createdAt < contract.cutoff && event.createdAt < contract.cutoff) candidates.add(pull.number);
      }
      graphs.push({ number: row.number, label,
        complete: row.kind === "PullRequest" ? null : !original.timelineItems.pageInfo.hasNextPage });
    }
  }
  assert.ok(candidates.size <= 60, "CI candidate scope exceeded");
  const pulls = [];
  for (const number of [...candidates].sort((a, b) => a - b)) {
    const pull = request(`pull-${number}`, `${prefix}/pulls/${number}`);
    assert.equal(pull.number, number);
    assert.equal(pull.base.repo.id, contract.repositoryId);
    const files = [], labels = [];
    let complete = false;
    for (let page = 1; page <= 3; page++) {
      const label = `files-${number}-${page}`;
      const rows = request(label, `${prefix}/pulls/${number}/files?per_page=100&page=${page}`);
      assert.ok(Array.isArray(rows));
      files.push(...rows);
      labels.push(label);
      if (rows.length < 100) { complete = true; break; }
    }
    assert.equal(new Set(files.map(file => file.filename)).size, files.length);
    if (complete) assert.equal(files.length, pull.changed_files);
    if (pull.merged_at && pull.merged_at < contract.cutoff) {
      const commit = request(`merge-${number}`, `${prefix}/commits/${pull.merge_commit_sha}`);
      assert.equal(commit.sha, pull.merge_commit_sha);
    }
    pulls.push({ number, mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha,
      filesComplete: complete, fileLabels: labels, paths: files.map(file => file.filename) });
  }
  const fuzz = pulls.find(row => row.number === 18158);
  assert.ok(fuzz?.mergedAt);
  request("fuzz-repair-to-bound", `${prefix}/compare/${fuzz.mergeCommit}...${contract.revision}?per_page=1`);
  request("fuzz-repaired-ci", `${prefix}/contents/.github/workflows/ci.yml?ref=${fuzz.mergeCommit}`);
  const run = request("fuzz-reporting-run", `${prefix}/actions/runs/22352959496`);
  assert.equal(run.id, 22352959496);
  assert.equal(run.repository.id, contract.repositoryId);
  assert.equal(run.path, ".github/workflows/ci-coach.lock.yml");
  request("fuzz-reporting-source", `${prefix}/contents/.github/workflows/ci-coach.md?ref=${run.head_sha}`);
  request("fuzz-reporting-runtime", `${prefix}/contents/.github/workflows/ci-coach.lock.yml?ref=${run.head_sha}`);
  const index = { schemaVersion: 1, contractSha256: hash(readFileSync(contractFile)),
    repository: contract.repository, revision: contract.revision, cutoff: contract.cutoff, graphs, pulls, receipts };
  writeJsonArchive(path.join(directory, "index.json.gz"), index);
  return { roots: roots.length, candidatePulls: pulls.length, retainedOriginals: Object.keys(receipts).length,
    incompleteGraphs: graphs.filter(row => row.complete === false).length, status: "acquisition only, no native qualification" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(collect()));
}
