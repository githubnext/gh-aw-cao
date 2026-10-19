import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "docs/operational-value/proof/native-cleanup-outcomes");
const originals = path.join(directory, "originals");
const cutoff = "2026-10-18T15:00:12Z";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const slugs = ["stale-pr-cleanup", "draft-pr-cleanup", "sub-issue-closer"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
mkdirSync(originals, { recursive: true });

function command(executable, args, optional = false) {
  const result = spawnSync(executable, args, {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !optional) {
    throw new Error(`${executable} ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result;
}

let requests = 0;
function acquire(endpoint, { method = "GET", fields = [] } = {}) {
  assert.ok(endpoint.startsWith("repos/github/gh-aw")
    || endpoint.startsWith("search/issues?q=repo%3Agithub%2Fgh-aw%20")
    || endpoint === "graphql");
  const key = digest(Buffer.from(JSON.stringify({ endpoint, method, fields })));
  const file = path.join(originals, `${key}.json.gz`);
  if (existsSync(file)) return readJsonArchive(file);
  assert.ok(++requests <= 240, "Bounded acquisition budget exhausted");
  const result = command("gh", ["api", "--include", "--method", method, endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`])], true);
  const raw = result.stdout;
  const boundary = /\r?\n\r?\n/.exec(raw.subarray(0, 32768).toString("latin1"));
  assert.ok(boundary, "Provider response headers missing");
  const header = raw.subarray(0, boundary.index).toString("latin1");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(header)?.[1]);
  const bytes = raw.subarray(boundary.index + boundary[0].length);
  const receipt = {
    endpoint, method, fields, status, observedAt: new Date().toISOString(),
    headers: header.split(/\r?\n/).filter(line => /^(HTTP\/|date:|etag:|link:|content-type:|x-github-request-id:)/i.test(line)),
    encoding: "base64", bytes: bytes.length, sha256: digest(bytes),
    data: bytes.toString("base64"),
  };
  writeJsonArchive(file, receipt, { gzipLevel: 9 });
  assert.equal(result.status, 0, `Read acquisition failed: ${endpoint}, HTTP ${status}`);
  assert.equal(status, 200, `Read acquisition failed: ${endpoint}`);
  console.log(JSON.stringify({ endpoint, status, bytes: bytes.length, archive: path.relative(root, file) }));
  return receipt;
}

function decode(receipt) {
  assert.equal(receipt.status, 200);
  const bytes = Buffer.from(receipt.data, "base64");
  assert.equal(bytes.length, receipt.bytes);
  assert.equal(digest(bytes), receipt.sha256);
  return JSON.parse(bytes);
}

function publicAuthority() {
  const metadata = decode(acquire("repos/github/gh-aw"));
  assert.equal(metadata.id, 1036865607);
  assert.equal(metadata.private, false);
  assert.equal(metadata.full_name, "github/gh-aw");
}

function sources(cache, extraRevisions) {
  assert.ok(cache, "sources requires the read-only bare cache path");
  const git = (...args) => command("git", [`--git-dir=${cache}`, ...args]).stdout.toString().trimEnd();
  const blobs = new Map();
  const entries = [];
  const objects = [];
  function object(sha, type) {
    if (objects.some(item => item.sha === sha)) return;
    const bytes = command("git", [`--git-dir=${cache}`, "cat-file", type, sha]).stdout;
    assert.equal(createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"), sha);
    const file = `sources/object-${sha}.json.gz`;
    mkdirSync(path.join(directory, "sources"), { recursive: true });
    writeJsonArchive(path.join(directory, file), {
      sha, type, sha256: digest(bytes), data: bytes.toString("base64"),
    }, { gzipLevel: 9 });
    objects.push({ sha, type, archive: file });
  }
  function commitProof(commit) {
    object(commit, "commit");
    for (const suffix of ["^{tree}", ":.github", ":.github/workflows"]) {
      object(git("rev-parse", `${commit}${suffix}`), "tree");
    }
  }
  function source(commit, filename) {
    const tree = git("ls-tree", commit, "--", filename);
    if (!tree) return null;
    const sha = /^\d+ blob ([a-f0-9]{40})\t/.exec(tree)?.[1];
    assert.ok(sha, `Not a blob: ${filename}`);
    if (!blobs.has(sha)) {
      const result = command("git", [`--git-dir=${cache}`, "cat-file", "blob", sha], true);
      let bytes = result.stdout;
      if (result.status !== 0) {
        const response = decode(acquire(`repos/github/gh-aw/git/blobs/${sha}`));
        assert.equal(response.sha, sha);
        assert.equal(response.encoding, "base64");
        bytes = Buffer.from(response.content, "base64");
        assert.equal(bytes.length, response.size);
      }
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), sha);
      const file = `sources/${sha}.json.gz`;
      mkdirSync(path.join(directory, "sources"), { recursive: true });
      writeJsonArchive(path.join(directory, file), {
        gitBlob: sha, sha256: digest(bytes), encoding: "base64", bytes: bytes.length,
        data: bytes.toString("base64"),
      }, { gzipLevel: 9 });
      blobs.set(sha, { file, bytes });
    }
    const record = { commit, path: filename, gitBlob: sha, archive: blobs.get(sha).file };
    if (!entries.some(item => item.commit === commit && item.path === filename)) entries.push(record);
    return blobs.get(sha).bytes.toString();
  }
  function imports(commit, filename, seen = new Set()) {
    if (seen.has(filename)) return;
    seen.add(filename);
    const text = source(commit, filename);
    assert.notEqual(text, null, `Missing declared source: ${filename}`);
    const references = [...text.matchAll(/(?:^\s*-\s*|#(?:runtime-)?import\s+)(shared\/[\w./-]+\.md)/gm)];
    for (const match of references) imports(commit, `.github/workflows/${match[1]}`, seen);
  }
  const histories = {};
  for (const slug of slugs) {
    const filename = `.github/workflows/${slug}.md`;
    const commits = git("log", "--format=%H", "--reverse", revision, "--", filename).split("\n").filter(Boolean);
    histories[slug] = commits.map(commit => {
      const [committedAt, parent] = git("show", "-s", "--format=%cI%n%P", commit).split("\n");
      const firstParent = parent.split(" ")[0];
      assert.match(firstParent, /^[a-f0-9]{40}$/);
      imports(commit, filename);
      return { commit, committedAt: new Date(committedAt).toISOString().replace(".000Z", "Z"),
        parent: firstParent, parentAt: new Date(git("show", "-s", "--format=%cI", firstParent)).toISOString().replace(".000Z", "Z") };
    });
    const adoption = histories[slug][0];
    assert.equal(git("ls-tree", adoption.parent, "--", filename), "", "Source exists before claimed adoption");
    commitProof(adoption.commit);
    commitProof(adoption.parent);
    imports(revision, filename);
    for (const commit of [adoption.commit, revision]) source(commit, `.github/workflows/${slug}.lock.yml`);
    for (const commit of extraRevisions) {
      assert.match(commit, /^[a-f0-9]{40}$/);
      imports(commit, filename);
      source(commit, `.github/workflows/${slug}.lock.yml`);
      commitProof(commit);
    }
  }
  commitProof(revision);
  writeJsonArchive(path.join(directory, "source-index.json.gz"), {
    schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
    revision, cutoff, histories, entries, objects,
  }, { gzipLevel: 9 });
}

function discover() {
  const census = path.join(root, "docs/operational-value/gh-aw-workflows/evidence");
  const index = readJsonArchive(path.join(census, "history.json.gz"));
  console.log(JSON.stringify(index).slice(0, 1500));
  const found = [];
  for (let partition = 1; partition <= 346; partition++) {
    const filename = path.join(census, `entities-${String(partition).padStart(5, "0")}.json.gz`);
    const rows = readJsonArchive(filename);
    for (const row of rows) {
      if (slugs.some(slug => JSON.stringify(row.workflowReference).includes(slug) || row.unverifiedWorkflowId === slug)) {
        found.push(row);
      }
    }
  }
  writeJsonArchive(path.join(directory, "discovery.json.gz"), {
    limitation: "Discovery only. Post-cutoff current state is not historical acceptance.",
    candidates: found,
  }, { gzipLevel: 9 });
  console.log(JSON.stringify(found, null, 2));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "sources") {
  publicAuthority();
  sources(args[0], args.slice(1));
} else if (mode === "discover") {
  discover();
} else if (mode === "api") {
  publicAuthority();
  for (const endpoint of args) decode(acquire(endpoint));
} else if (mode === "binary") {
  publicAuthority();
  for (const endpoint of args) acquire(endpoint);
} else if (mode === "children") {
  publicAuthority();
  for (const number of args) {
    assert.match(number, /^\d+$/);
    const children = decode(acquire(`repos/github/gh-aw/issues/${number}/sub_issues?per_page=100`));
    assert.ok(Array.isArray(children) && children.length < 100, "Child set requires additional acquisition");
    for (const child of children) {
      assert.equal(child.url, `https://api.github.com/repos/github/gh-aw/issues/${child.number}`);
      for (let page = 1; page <= 8; page++) {
        const rows = decode(acquire(`repos/github/gh-aw/issues/${child.number}/timeline?per_page=100${page === 1 ? "" : `&page=${page}`}`));
        assert.ok(Array.isArray(rows));
        if (rows.length < 100) break;
        assert.ok(page < 8, "Child timeline exceeds bounded acquisition");
      }
    }
  }
} else if (mode === "seal") {
  const files = ["contracts.json", "source-index.json.gz", "discovery.json.gz",
    ...["originals", "sources"].flatMap(folder => readdirSync(path.join(directory, folder)).map(file => `${folder}/${file}`))]
    .toSorted().map(file => {
      const bytes = readFileSync(path.join(directory, file));
      assert.ok(bytes.length <= 256 * 1024, `Oversized owned evidence: ${file}`);
      return { path: file, size: bytes.length, sha256: digest(bytes) };
    });
  writeJsonArchive(path.join(directory, "inputs.json"), {
    schemaVersion: 1, cutoff, repository: "github/gh-aw", repositoryId: 1036865607,
    parents: [69626, 69627], parentRun: 39104430263, parentApplicationArtifact: 12127649313,
    pullRequests: {
      "stale-pr-cleanup": [56568],
      "draft-pr-cleanup": [47642, 51754, 69586, 69848, 69866],
    },
    files,
    limitation: "Only the two selected parents have independently verified useful native outcomes. No eligible PR closure evidence was found in this bounded acquisition. Empty search results and current census state are not historical no-opportunity proof.",
  });
} else {
  throw new Error("usage: acquire-native-cleanup.mjs sources CACHE | discover | api|binary ENDPOINT...");
}
