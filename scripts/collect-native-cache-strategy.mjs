import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { treeEntries } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const directory = fileURLToPath(new URL("../docs/operational-value/proof/native-cache-strategy/", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function collectCacheStrategy({ sourcesOnly = false, gitCache = null } = {}) {
  const contractBytes = readFileSync(path.join(directory, "frozen-contract-v1.json"));
  const contract = JSON.parse(contractBytes), receipts = {};
  let requests = 0;
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const request = (label, endpoint, query = null, allowMissing = false) => {
    assert.match(label, /^[a-z0-9-]+$/);
    const file = `originals/${label}.json.gz`, destination = path.join(directory, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      assert.ok(++requests <= contract.acquisition.requestBudget, "Cache acquisition request budget exceeded");
      let body, status = 200;
      try {
        body = execFileSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
      } catch (error) {
        if (!allowMissing || error.status !== 1 || !/Not Found \(HTTP 404\)/.test(String(error.stderr))) throw error;
        body = String(error.stdout);
        assert.equal(JSON.parse(body).status, "404");
        status = 404;
      }
      JSON.parse(body);
      packet = { endpoint, query, status, observedAt: new Date().toISOString(), body, sha256: hash(body) };
      writeJsonArchive(destination, packet);
    }
    assert.equal(packet.endpoint, endpoint);
    assert.equal(packet.query, query);
    if (packet.status !== undefined) assert.ok(packet.status === 200 || allowMissing && packet.status === 404);
    assert.equal(hash(packet.body), packet.sha256, `Changed original ${label}`);
    const value = JSON.parse(packet.body);
    assert.ok(!value.errors, `GitHub request failed: ${JSON.stringify(value.errors)}`);
    receipts[label] = { file, archiveSha256: hash(readFileSync(destination)), bodySha256: packet.sha256 };
    return value;
  };
  const prefix = `repos/${contract.repository}`;
  const metadata = request("repository", prefix);
  assert.equal(metadata.id, contract.repositoryId);
  assert.equal(metadata.full_name, contract.repository);
  assert.equal(metadata.private, false);
  assert.equal(metadata.visibility, "public");
  const introduction = request("adoption", `${prefix}/commits/${contract.adoption.commit}`);
  assert.equal(introduction.parents[0].sha, contract.adoption.parent);
  assert.equal(introduction.commit.committer.date, contract.adoption.adoptedAt);
  for (const file of [contract.adoption.sourcePath, contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml")]) {
    assert.equal(introduction.files.find(row => row.filename === file)?.status, "added");
  }
  request("baseline", `${prefix}/commits/${contract.adoption.parent}`);
  for (const [label, file, revision, expected, allowMissing = false] of [
    ["source", contract.adoption.sourcePath, contract.revision, contract.sourceBlob],
    ["runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.revision, null],
    ["initial-source", contract.adoption.sourcePath, contract.adoption.commit, contract.adoption.initialSourceBlob],
    ["initial-runtime", contract.adoption.sourcePath.replace(/\.md$/, ".lock.yml"), contract.adoption.commit, contract.adoption.initialCompiledBlob],
    ...["meta-analysis-base", "aw-logs-24h-fetch-setup", "aw-logs-24h-fetch-prompt", "reporting", "otlp"]
      .map(name => [name, `.github/workflows/shared/${name}.md`, contract.revision, null]),
    ["shared-instructions", ".github/shared-instructions.md", contract.revision, null, true],
  ]) {
    const blob = request(label, `${prefix}/contents/${file}?ref=${revision}`, null, allowMissing);
    if (allowMissing && blob.status === "404") continue;
    assert.equal(blob.path, file);
    assert.equal(blob.encoding, "base64");
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    if (expected) assert.equal(blob.sha, expected);
  }
  const cacheMetadata = request("cache-action-repository", "repos/actions/cache");
  assert.equal(cacheMetadata.full_name, "actions/cache");
  assert.equal(cacheMetadata.private, false);
  assert.equal(cacheMetadata.visibility, "public");
  for (const revision of ["27d5ce7f107fe9357f9df03efb73ab90386fccae", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"]) {
    for (const [label, file] of [["interface", "restore/action.yml"], ["implementation", "src/restoreImpl.ts"]]) {
      const blob = request(`cache-${revision.slice(0, 8)}-${label}`, `repos/actions/cache/contents/${file}?ref=${revision}`);
      assert.equal(blob.path, file);
      assert.equal(blob.encoding, "base64");
      const bytes = Buffer.from(blob.content, "base64");
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    }
  }
  if (sourcesOnly) return { sourcesOnly, requests, receipts };
  const history = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
  assert.equal(history.index.repositoryId, contract.repositoryId);
  assert.equal(history.index.repository, contract.repository);
  assert.equal(history.index.sourceRevision, contract.revision);
  assert.equal(history.index.until, contract.cutoff);
  const roots = history.entities.filter(row => row.workflowReference?.workflowId === contract.workflow)
    .map(({ number, kind }) => ({ number, kind })).sort((left, right) => left.number - right.number);
  const selectionFile = path.join(directory, "selection.json");
  const selection = { contractSha256: hash(contractBytes), roots, rootsSha256: hash(JSON.stringify(roots)) };
  if (existsSync(selectionFile)) assert.deepEqual(readJsonArchive(selectionFile), selection);
  else writeJsonArchive(selectionFile, selection);
  const candidates = new Set(), graphs = [];
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
  assert.ok(candidates.size <= contract.acquisition.candidateBudget, "Cache candidate budget exceeded");
  const pulls = [];
  for (const number of [...candidates].sort((left, right) => left - right)) {
    const pull = request(`pull-${number}`, `${prefix}/pulls/${number}`);
    assert.equal(pull.number, number);
    assert.equal(pull.base.repo.id, contract.repositoryId);
    assert.ok(pull.created_at < contract.cutoff);
    const retained = { number, mergedAt: pull.merged_at, mergeCommit: pull.merge_commit_sha };
    if (pull.merged_at && pull.merged_at < contract.cutoff) {
      assert.match(pull.merge_commit_sha, /^[a-f0-9]{40}$/);
      const commit = request(`commit-${number}`, `${prefix}/commits/${pull.merge_commit_sha}?per_page=100&page=1`);
      assert.equal(commit.sha, pull.merge_commit_sha);
      assert.match(commit.parents[0]?.sha, /^[a-f0-9]{40}$/);
      const parent = request(`parent-${number}`, `${prefix}/commits/${commit.parents[0].sha}?per_page=100&page=1`);
      assert.equal(parent.sha, commit.parents[0].sha);
      retained.actualParent = parent.sha;
      retained.commitAt = commit.commit.committer.date;
      const files = [...commit.files];
      let last = commit;
      for (let page = 2; last.files.length === 100; page++) {
        assert.ok(page <= 20, "Cache candidate changed-file budget exceeded");
        last = request(`commit-${number}-${String(page).padStart(3, "0")}`,
          `${prefix}/commits/${pull.merge_commit_sha}?per_page=100&page=${page}`);
        assert.equal(last.sha, commit.sha);
        assert.equal(last.parents[0].sha, parent.sha);
        files.push(...last.files);
      }
      assert.equal(new Set(files.map(row => row.filename)).size, files.length, "Duplicate changed-file identity");
      retained.changedPaths = files.map(({ filename, previous_filename, status, sha }) =>
        ({ path: filename, previousPath: previous_filename ?? null, status, blob: sha }));
      retained.fileListComplete = true;
    }
    pulls.push(retained);
  }
  const nativeSources = [];
  for (const number of [32682, 40882]) {
    const pull = pulls.find(row => row.number === number);
    assert.ok(pull?.actualParent, "Missing selected actual-parent transition");
    for (const [phase, revision] of [["before", pull.actualParent], ["after", pull.mergeCommit]]) {
      for (const [name, file] of [
        ["cache", "pkg/workflow/cache.go"],
        ...(number === 40882 ? [
          ["detection", "pkg/workflow/threat_detection.go"],
          ["classifier", "actions/setup/js/collect_ndjson_output.cjs"],
          ["conclusion", "actions/setup/sh/conclude_threat_detection.sh"],
        ] : []),
        ["witness-source", ".github/workflows/chaos-pr-bundle-fuzzer.md"],
        ["witness-runtime", ".github/workflows/chaos-pr-bundle-fuzzer.lock.yml"],
      ]) {
        const label = `native-${number}-${phase}-${name}`;
        const original = request(label, `${prefix}/contents/${file}?ref=${revision}`);
        assert.equal(original.path, file);
        assert.equal(original.encoding, "base64");
        const bytes = Buffer.from(original.content, "base64");
        assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), original.sha);
        nativeSources.push({ number, phase, revision, path: file, blob: original.sha, label });
      }
    }
  }
  const index = { schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    revision: contract.revision, cutoff: contract.cutoff, contractSha256: hash(contractBytes),
    selectionSha256: hash(JSON.stringify(selection)), roots: roots.length, graphs, pulls, nativeSources, receipts };
  writeJsonArchive(path.join(directory, "index.json.gz"), index);
  if (gitCache) retainCacheCustody(gitCache, index);
  return { requests, roots: roots.length, candidates: pulls.length, incompleteGraphs: graphs.filter(row => row.complete === false).length };
}

function retainCacheCustody(cache, index) {
  const objects = new Map(), paths = [];
  const retain = (type, id, content = null) => {
    if (objects.has(id)) return objects.get(id);
    const bytes = content ?? execFileSync("git", [`--git-dir=${cache}`, "cat-file", type, id], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 4 * 1024 * 1024, timeout: 30000,
    });
    assert.equal(createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"), id);
    assert.ok(objects.size < 300 && bytes.length <= 4 * 1024 * 1024, "Cache custody budget exceeded");
    objects.set(id, bytes);
    mkdirSync(path.join(directory, "git"), { recursive: true });
    writeJsonArchive(path.join(directory, "git", `${id}.json.gz`),
      { id, type, bytes: bytes.length, contentBase64: bytes.toString("base64"), sha256: hash(bytes) });
    return bytes;
  };
  for (const source of index.nativeSources) {
    const rawCommit = retain("commit", source.revision);
    let tree = rawCommit.toString().match(/^tree ([a-f0-9]{40})$/m)?.[1];
    assert.ok(tree, "Missing original commit tree");
    const parts = source.path.split("/");
    for (let offset = 0; offset < parts.length; offset++) {
      const entry = treeEntries(retain("tree", tree)).get(parts[offset]);
      assert.ok(entry, "Unbound source path");
      if (offset < parts.length - 1) {
        assert.equal(entry.mode, "40000");
        tree = entry.id;
      } else {
        assert.ok(["100644", "100755"].includes(entry.mode), "Non-regular native source");
        assert.equal(entry.id, source.blob);
      }
    }
    const receipt = index.receipts[source.label];
    const packet = readJsonArchive(path.join(directory, receipt.file));
    const original = JSON.parse(packet.body);
    retain("blob", source.blob, Buffer.from(original.content, "base64"));
    paths.push({ commit: source.revision, path: source.path, blob: source.blob });
  }
  writeJsonArchive(path.join(directory, "custody.json.gz"), { schemaVersion: 1, repository: index.repository,
    repositoryId: index.repositoryId, revision: index.revision, cutoff: index.cutoff,
    contractSha256: index.contractSha256, paths,
    objects: [...objects.keys()].sort().map(id => {
      const file = `git/${id}.json.gz`, bytes = readFileSync(path.join(directory, file));
      return { file, bytes: bytes.length, sha256: hash(bytes) };
    }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let offset = 2; offset < process.argv.length; offset++) {
    const argument = process.argv[offset];
    if (argument === "--sources-only") options.sourcesOnly = true;
    else if (argument === "--git-cache") {
      options.gitCache = process.argv[++offset];
      assert.ok(options.gitCache, "Missing read-only Git cache path");
    } else throw new Error(`Unsupported cache acquisition option ${argument}`);
  }
  console.log(JSON.stringify(collectCacheStrategy(options)));
}
