import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDiscussionHistory } from "./collect-workflow-discussions.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = fileURLToPath(new URL("../docs/operational-value/proof/firewall-observability/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function collect(discoveryDirectory) {
  assert.ok(discoveryDirectory, "A retained complete Discussion inventory is required");
  const contract = JSON.parse(readFileSync(path.join(directory, "frozen-contract-v1.json")));
  const discovery = readDiscussionHistory(path.resolve(discoveryDirectory));
  assert.equal(discovery.index.complete, true);
  assert.equal(discovery.index.repository, contract.repository);
  assert.equal(discovery.index.repositoryId, contract.repositoryId);
  assert.equal(discovery.index.until, contract.cutoff);
  const candidates = discovery.discussions
    .filter(row => /daily[- ]firewall[- ]report\b/i.test(row.title) && row.createdAt < contract.cutoff)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
  const selected = candidates.slice(0, contract.selection.maximumReports);
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const receipts = {};
  let requests = 0;
  const request = (label, endpoint, query) => {
    assert.match(label, /^[a-z0-9-]+$/);
    const file = `originals/${label}.json.gz`, destination = path.join(directory, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      assert.ok(++requests <= 60, "Bounded firewall acquisition request budget exceeded");
      const body = execFileSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])],
        { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      packet = { endpoint, ...(query ? { query } : {}), observedAt: new Date().toISOString(), body, sha256: hash(body) };
      writeJsonArchive(destination, packet);
    }
    assert.equal(packet.endpoint, endpoint);
    assert.equal(packet.query, query);
    assert.equal(hash(packet.body), packet.sha256, `Original response changed: ${label}`);
    receipts[label] = { file, archiveSha256: hash(readFileSync(destination)), bodySha256: packet.sha256 };
    return JSON.parse(packet.body);
  };
  const repository = request("repository", `repos/${contract.repository}`);
  assert.equal(repository.id, contract.repositoryId);
  assert.equal(repository.full_name, contract.repository);
  assert.equal(repository.private, false);
  assert.equal(repository.visibility, "public");
  for (const [position, source] of [contract.source.workflow, ...contract.source.imports].entries()) {
    request(`frozen-source-${position + 1}`, `repos/${contract.repository}/contents/${source}?ref=${contract.revision}`);
  }
  request("adoption", `repos/${contract.repository}/commits/${contract.source.earliestKnownAdoption}`);
  request("reintroduction", `repos/${contract.repository}/commits/${contract.source.knownReintroduction}`);
  const records = selected.map(row => {
    const query = `query { repository(owner:"github",name:"gh-aw") { databaseId discussion(number:${row.number}) { id number url title body createdAt updatedAt } } }`;
    const original = request(`discussion-${row.number}`, "graphql", query);
    assert.equal(original.errors, undefined);
    assert.equal(original.data?.repository?.databaseId, contract.repositoryId);
    const discussion = original.data.repository.discussion;
    for (const key of ["id", "number", "url", "createdAt"]) assert.equal(discussion[key], row[key]);
    const runIds = [...new Set([...discussion.body.matchAll(/https:\/\/github\.com\/github\/gh-aw\/actions\/runs\/(\d+)/g)]
      .map(match => match[1]))];
    assert.ok(runIds.length <= 12, "Report exceeds bounded candidate-run inspection");
    const runtimes = [], referencedRuns = [];
    for (const id of runIds) {
      const run = request(`run-${id}`, `repos/${contract.repository}/actions/runs/${id}`);
      assert.equal(String(run.id), id);
      assert.equal(run.repository?.id, contract.repositoryId);
      assert.equal(run.repository.private, false);
      const artifacts = request(`artifacts-${id}`, `repos/${contract.repository}/actions/runs/${id}/artifacts?per_page=100`);
      assert.ok(artifacts.total_count <= 100, "Artifact discovery requires explicit continuation");
      referencedRuns.push({ id: run.id, path: run.path, artifacts: artifacts.artifacts.map(
        ({ id, name, expired, size_in_bytes, created_at }) => ({ id, name, expired, size_in_bytes, created_at })) });
      if (run.path !== ".github/workflows/daily-firewall-report.lock.yml") continue;
      assert.match(run.head_sha, /^[a-f0-9]{40}$/);
      for (const suffix of ["md", "lock.yml"]) {
        request(`runtime-${id}-${suffix.replace(".", "-")}`,
          `repos/${contract.repository}/contents/.github/workflows/daily-firewall-report.${suffix}?ref=${run.head_sha}`);
      }
      runtimes.push({ id: run.id, head: run.head_sha, createdAt: run.created_at, artifacts: artifacts.artifacts.map(
        ({ id, name, expired, size_in_bytes, created_at }) => ({ id, name, expired, size_in_bytes, created_at })) });
    }
    return { id: row.id, number: row.number, createdAt: row.createdAt, title: row.title, runtimes, referencedRuns };
  });
  const index = { schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    revision: contract.revision, cutoff: contract.cutoff, contractSha256: hash(readFileSync(path.join(directory, "frozen-contract-v1.json"))),
    discoveryComplete: true, candidateCount: candidates.length,
    titleMatch: "Case-insensitive daily[- ]firewall[- ]report, including a source-profile prefix or human title.",
    selection: contract.selection, records, receipts,
    limitation: "Surviving after-cutoff bodies and editable run links are discovery, not original publication bytes, original request events or receipt-verified contribution." };
  writeJsonArchive(path.join(directory, "index.json.gz"), index);
  return index;
}

export function assessRetainedEvidence(base = directory) {
  const contract = JSON.parse(readFileSync(path.join(base, "frozen-contract-v1.json")));
  const index = readJsonArchive(path.join(base, "index.json.gz"));
  assert.equal(hash(readFileSync(path.join(base, "frozen-contract-v1.json"))), index.contractSha256);
  assert.equal(index.repositoryId, contract.repositoryId);
  assert.equal(index.revision, contract.revision);
  assert.equal(index.cutoff, contract.cutoff);
  const originals = {};
  for (const [label, receipt] of Object.entries(index.receipts)) {
    assert.match(receipt.file, /^originals\/[a-z0-9-]+\.json\.gz$/);
    const file = path.join(base, receipt.file);
    assert.equal(hash(readFileSync(file)), receipt.archiveSha256, `Archive custody changed: ${label}`);
    const packet = readJsonArchive(file);
    assert.equal(hash(packet.body), packet.sha256, `Original custody changed: ${label}`);
    assert.equal(packet.sha256, receipt.bodySha256);
    originals[label] = JSON.parse(packet.body);
  }
  assert.equal(originals.repository.id, contract.repositoryId);
  assert.equal(originals.repository.private, false);
  const dispositions = index.records.map(row => {
    const discussion = originals[`discussion-${row.number}`].data.repository.discussion;
    assert.equal(discussion.id, row.id);
    assert.equal(discussion.number, row.number);
    assert.equal(discussion.createdAt, row.createdAt);
    const referencedRuns = row.referencedRuns.map(reference => {
      const run = originals[`run-${reference.id}`], artifacts = originals[`artifacts-${reference.id}`];
      assert.equal(run.id, reference.id);
      assert.equal(run.repository.id, contract.repositoryId);
      assert.equal(run.repository.private, false);
      assert.equal(artifacts.total_count, artifacts.artifacts.length);
      assert.ok(artifacts.total_count <= 100);
      return { id: run.id, sourcePath: run.path, head: run.head_sha,
        returnedArtifactCount: artifacts.total_count };
    });
    return { number: row.number, createdAt: row.createdAt, nativeValue: null,
      completedNativeEvaluation: false, referencedRuns,
      reason: referencedRuns.length && referencedRuns.every(run => run.returnedArtifactCount === 0)
        ? "Provider inventories for the report and explicitly cited runs retain no artifacts. Original firewall request events are not established."
        : "Available metadata or report claims do not establish independently retained complete original firewall request events." };
  });
  return { schemaVersion: 1, workflow: contract.workflow, sourceGitBlob: originals["frozen-source-1"].sha,
    contractSha256: index.contractSha256, indexSha256: hash(readFileSync(path.join(base, "index.json.gz"))),
    candidateCount: index.candidateCount, selectedReports: dispositions,
    qualifiedNativeWorkflows: 0, nativeValue: null, fullAcceptance: null, contribution: null, costs: null,
    completedNativeEvaluation: false,
    limitation: "This is a bounded evidence-gap investigation, not a finished native value function or standard evaluation. Reported request totals, charts and a no-data report cannot replace original events or establish measured zero." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = collect(process.argv[2]);
  writeJsonArchive(path.join(directory, "assessment.json"), assessRetainedEvidence());
  console.log(JSON.stringify({ selected: index.records.length, candidates: index.candidateCount,
    originals: Object.keys(index.receipts).length, runtimes: index.records.map(row => ({ number: row.number, runtimes: row.runtimes })) }));
}
