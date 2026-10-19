import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { parseWorkflowReference, validateRunReference } from "../.github/skills/add-operational-value/scripts/github-lineage.mjs";

const directory = fileURLToPath(new URL("../docs/operational-value/proof/cli-compatibility/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function collect() {
  const contractFile = path.join(directory, "frozen-contract-v1.json");
  const contract = JSON.parse(readFileSync(contractFile));
  const receipts = {};
  let requests = 0;
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const request = (label, endpoint) => {
    assert.match(label, /^[a-z0-9-]+$/);
    const file = `originals/${label}.json.gz`, destination = path.join(directory, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      assert.ok(++requests <= contract.acquisition.requestBudget, "Compatibility acquisition budget exceeded");
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
  const prefix = `repos/${contract.repository}`;
  const repository = request("repository", prefix);
  assert.equal(repository.id, contract.repositoryId);
  assert.equal(repository.full_name, contract.repository);
  assert.equal(repository.private, false);
  assert.equal(repository.visibility, "public");
  const adoption = request("adoption", `${prefix}/commits/${contract.adoption.commit}`);
  assert.equal(adoption.parents[0].sha, contract.adoption.parent);
  assert.equal(adoption.commit.committer.date, contract.adoption.adoptedAt);
  assert.equal(adoption.files.find(file => file.filename === contract.adoption.sourcePath)?.status, "added");
  request("baseline", `${prefix}/commits/${contract.adoption.parent}`);
  request("source-history", `${prefix}/commits?path=${contract.adoption.sourcePath}&sha=${contract.revision}&per_page=100`);
  for (const [label, file, revision] of [
    ["source", contract.adoption.sourcePath, contract.revision],
    ["runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.revision],
    ["rules", contract.adoption.currentRulesPath, contract.revision],
    ["initial-source", contract.adoption.sourcePath, contract.adoption.commit],
    ["initial-runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.adoption.commit],
    ["initial-rules", contract.adoption.initialRulesPath, contract.adoption.commit],
    ["issue-base", ".github/workflows/shared/daily-issue-base.md", contract.revision],
    ["skip-base", ".github/workflows/shared/skip-if-issue-open.md", contract.revision],
  ]) {
    const blob = request(label, `${prefix}/contents/${file}?ref=${revision}`);
    assert.equal(blob.path, file);
    assert.equal(blob.encoding, "base64");
    if (label === "source") assert.equal(blob.sha, contract.sourceBlob);
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
  }
  const candidates = new Set(contract.selection.pulls), roots = [];
  for (const number of contract.selection.roots) {
    const issue = request(`issue-${number}`, `${prefix}/issues/${number}`);
    assert.equal(issue.number, number);
    assert.ok(issue.created_at < contract.cutoff, "Out-of-cutoff discovery root");
    const events = [];
    let complete = false;
    const labels = [];
    for (let page = 1; page <= 3; page++) {
      const label = `timeline-${number}-${page}`;
      const rows = request(label, `${prefix}/issues/${number}/timeline?per_page=100&page=${page}`);
      assert.ok(Array.isArray(rows), "Invalid issue timeline");
      labels.push(label);
      events.push(...rows);
      if (rows.length < 100) { complete = true; break; }
    }
    for (const event of events) {
      const linked = event.source?.issue;
      if (event.event === "cross-referenced" && linked?.pull_request
        && linked.repository?.id === contract.repositoryId && linked.created_at < contract.cutoff) {
        candidates.add(linked.number);
      }
    }
    roots.push({ number, timelineLabels: labels, timelineComplete: complete,
      kind: issue.pull_request ? "PullRequest" : "Issue" });
  }
  const pulls = [];
  assert.ok(candidates.size <= 25, "Downstream PR discovery exceeded frozen bounded scope");
  for (const number of [...candidates].sort((a, b) => a - b)) {
    const pull = request(`pull-${number}`, `${prefix}/pulls/${number}`);
    assert.equal(pull.base.repo.id, contract.repositoryId);
    assert.equal(pull.number, number);
    const files = [], labels = [];
    let complete = false;
    for (let page = 1; page <= 3; page++) {
      const label = `files-${number}-${page}`;
      const rows = request(label, `${prefix}/pulls/${number}/files?per_page=100&page=${page}`);
      assert.ok(Array.isArray(rows));
      labels.push(label);
      files.push(...rows);
      if (rows.length < 100) { complete = true; break; }
    }
    assert.equal(new Set(files.map(file => file.filename)).size, files.length, "Duplicate changed file");
    assert.equal(complete ? files.length : pull.changed_files, pull.changed_files, "PR file inventory incomplete");
    if (pull.merged_at && pull.merged_at < contract.cutoff) {
      request(`merge-${number}`, `${prefix}/commits/${pull.merge_commit_sha}`);
    }
    pulls.push({ number, mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha,
      fileLabels: labels, filesComplete: complete, paths: files.map(file => file.filename) });
  }
  const repair = request("merge-42794", `${prefix}/commits/7bc15e21c80d251de946b34e2798afe58fcfaf62`);
  request("repair-to-bound", `${prefix}/compare/${repair.sha}...${contract.revision}?per_page=1`);
  assert.equal(repair.parents.length, 1, "Expected the actual single-parent migration repair");
  const tree = request("repair-tree", `${prefix}/git/trees/${repair.commit.tree.sha}?recursive=1`);
  assert.equal(tree.truncated, false, "Repair source tree is incomplete");
  const sourcePaths = [
    "pkg/cli/codemod_github_app.go",
    "pkg/cli/codemod_github_app_test.go",
    "pkg/cli/fix_command.go",
    "pkg/parser/schemas/main_workflow_schema.json",
    ".changeset/minor-rename-app-to-github-app.md",
    "pkg/cli/fix_codemods.go",
    "pkg/cli/frontmatter_editor.go",
    "pkg/cli/yaml_frontmatter_utils.go",
    "pkg/cli/helpers.go",
    "pkg/parser/frontmatter.go",
    "pkg/parser/frontmatter_content.go",
  ];
  for (const [side, revision] of [["before", repair.parents[0].sha], ["after", repair.sha]]) {
    for (const [position, file] of sourcePaths.entries()) {
      const blob = request(`native-${side}-${position}`, `${prefix}/contents/${file}?ref=${revision}`);
      assert.equal(blob.path, file);
      const bytes = Buffer.from(blob.content, "base64");
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    }
  }
  const report = request("issue-42793", `${prefix}/issues/42793`);
  const reference = parseWorkflowReference(report.body, contract.repository);
  assert.equal(reference.workflowId, contract.workflow);
  const run = request("report-run", `${prefix}/actions/runs/${reference.runId}`);
  const runBinding = validateRunReference(reference, run, contract.adoption.sourcePath, contract.repository);
  request("report-source", `${prefix}/contents/${contract.adoption.sourcePath}?ref=${run.head_sha}`);
  request("report-runtime", `${prefix}/contents/${contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml")}?ref=${run.head_sha}`);
  const index = { schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    revision: contract.revision, cutoff: contract.cutoff, contractSha256: hash(readFileSync(contractFile)),
    roots, pulls, runBinding, nativeCandidate: { number: 42794, commit: repair.sha, parent: repair.parents[0].sha,
      sourcePaths, helperCandidates: tree.tree.filter(row => /^pkg\/cli\/(?:codemod|frontmatter)/.test(row.path)).map(row => row.path) },
    receipts, nativeEvaluationComplete: false,
    limitation: "Discovery and retained originals do not establish compatibility restorations or workflow contribution." };
  writeJsonArchive(path.join(directory, "index.json.gz"), index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = collect();
  console.log(JSON.stringify({ roots: index.roots.length, pulls: index.pulls, originals: Object.keys(index.receipts).length }));
}
