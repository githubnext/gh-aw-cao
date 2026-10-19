import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readJsonArchive as read, writeJsonArchive as write } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const dir = "docs/operational-value/proof/native-code-debt";
const cache = process.env.NATIVE_CODE_DEBT_GIT_CACHE;
if (!cache) throw new Error("NATIVE_CODE_DEBT_GIT_CACHE must explicitly identify a read-only source cache");
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const gitId = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const objects = new Map();
const prior = existsSync(`${dir}/objects.json.gz`) ? read(`${dir}/objects.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : [];
for (const row of prior) objects.set(row.id, row);
function git(args) {
  const result = spawnSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function object(type, id) {
  if (objects.has(id)) return Buffer.from(objects.get(id).contentBase64, "base64");
  let result = git(["cat-file", type, id]), bytes;
  if (result.status === 0) bytes = result.stdout;
  else {
    if (type !== "blob") throw new Error(`Unavailable original ${type} ${id}: ${result.stderr}`);
    const file = `${dir}/api/blob-${id}.json.gz`;
    let original;
    if (existsSync(file)) original = read(file);
    else {
      result = spawnSync("gh", ["api", `repos/github/gh-aw/git/blobs/${id}`], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.toString());
      original = { endpoint: `repos/github/gh-aw/git/blobs/${id}`, observedAt: new Date().toISOString(),
        sha256: hash(result.stdout), bytes: result.stdout.length, contentBase64: result.stdout.toString("base64") };
      write(file, original);
    }
    const raw = Buffer.from(original.contentBase64, "base64");
    if (hash(raw) !== original.sha256 || raw.length !== original.bytes) throw new Error("API original custody");
    const body = JSON.parse(raw);
    if (body.encoding !== "base64" || body.sha !== id) throw new Error("Invalid blob identity");
    bytes = Buffer.from(body.content, "base64");
  }
  if (gitId(type, bytes) !== id) throw new Error("Git original identity mismatch");
  objects.set(id, { type, id, bytes: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString("base64") });
  return bytes;
}
function commit(id) {
  const text = object("commit", id).toString(), header = text.split("\n\n")[0];
  return { id, tree: header.match(/^tree (\w{40})$/m)[1], parents: [...header.matchAll(/^parent (\w{40})$/gm)].map(x => x[1]),
    at: new Date(Number(header.match(/^committer .* (\d+) [+-]\d{4}$/m)[1]) * 1000).toISOString().replace(".000Z", "Z") };
}
function entries(id) {
  const bytes = object("tree", id), rows = [];
  for (let start = 0; start < bytes.length;) {
    const space = bytes.indexOf(32, start), nul = bytes.indexOf(0, space);
    rows.push({ mode: bytes.subarray(start, space).toString(), name: bytes.subarray(space + 1, nul).toString(),
      id: bytes.subarray(nul + 1, nul + 21).toString("hex") });
    start = nul + 21;
  }
  return rows;
}
const paths = new Map();
if (existsSync(`${dir}/custody.json.gz`)) for (const row of read(`${dir}/custody.json.gz`).paths) paths.set(`${row.commit}:${row.path}`, row);
function source(id, file) {
  let tree = commit(id).tree;
  const parts = file.split("/");
  let blob = null;
  for (let i = 0; i < parts.length; i++) {
    const row = entries(tree).find(x => x.name === parts[i]);
    if (!row) break;
    if (i === parts.length - 1) {
      if (!["100644", "100755"].includes(row.mode)) throw new Error("Nonregular source");
      blob = row.id;
    } else {
      if (row.mode !== "40000") throw new Error("Non-tree source ancestor");
      tree = row.id;
    }
  }
  paths.set(`${id}:${file}`, { commit: id, path: file, blob });
  return blob === null ? null : object("blob", blob).toString();
}
function save() {
  write(`${dir}/objects.json.gz`, [...objects.values()], { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  write(`${dir}/custody.json.gz`, { repository: "github/gh-aw", repositoryId: 1036865607, revision,
    cutoff: "2026-10-18T15:00:12Z", paths: [...paths.values()], workflows, implementations, eligibility });
}
let eligibility = null;
const api = readdirSync(`${dir}/api`).filter(f => /^(daily-code-debt-aider|code-simplifier)-\d+\.json\.gz$/.test(f)).map(file => ({
  slug: file.replace(/-\d+\.json\.gz$/, ""),
  body: JSON.parse(Buffer.from(read(`${dir}/api/${file}`).contentBase64, "base64")),
}));
const implementations = [];
const seen = new Set();
for (const { slug, body } of api) for (const row of Object.values(body.data.repository)) {
  if (!row?.number) continue;
  const candidates = row.timelineItems ? row.timelineItems.nodes.map(event => ({ pull: event.source ?? event.subject, eventAt: event.createdAt, issue: row.number }))
    : [{ pull: row, eventAt: null, issue: null }];
  for (const { pull, eventAt, issue } of candidates) {
    if (!pull?.mergedAt || pull.mergedAt >= "2026-10-18T15:00:12Z") continue;
    const key = `${slug}:${pull.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (pull.files.pageInfo.hasNextPage) throw new Error("Incomplete candidate files");
    const actual = commit(pull.mergeCommit.oid);
    implementations.push({ slug, number: pull.number, issue, eventAt, commit: actual.id, parent: actual.parents[0],
      mergedAt: pull.mergedAt, paths: pull.files.nodes.map(x => x.path) });
  }
}
const workflows = [];
const introductions = {
  "daily-code-debt-aider": ["0841c9e3e6fc99312ed0e7f770fc5a0b6438ead8"],
  "code-simplifier": ["6f27e6d8218a5a3729f44ee5a6dbd68957ac0865", "e9b732bc366ade8de24f162b525ffbb354a53129"],
};
for (const [slug, ids] of Object.entries(introductions)) {
  const profiles = [];
  for (const id of [...ids, revision]) {
    const actual = commit(id);
    const text = source(id, `.github/workflows/${slug}.md`);
    const compiled = source(id, `.github/workflows/${slug}.lock.yml`);
    if (ids.includes(id)) {
      source(actual.parents[0], `.github/workflows/${slug}.md`);
      source(actual.parents[0], `.github/workflows/${slug}.lock.yml`);
    }
    const imports = [...new Set([...text.matchAll(/(?:^  - (?:uses: )?|^      - )(shared\/[\w./-]+\.md)/gm)].map(x => x[1]))];
    const visited = new Set();
    function retainImport(file) {
      if (visited.has(file)) return;
      visited.add(file);
      const imported = source(id, file);
      if (imported === null) return;
      for (const match of imported.matchAll(/(?:^  - (?:uses: )?)(shared\/[\w./-]+\.md)/gm)) retainImport(`.github/workflows/${match[1]}`);
    }
    for (const file of imports) retainImport(`.github/workflows/${file}`);
    for (const match of text.matchAll(/^@\.\/([\w./-]+\.md)$/gm)) retainImport(`.github/${match[1]}`);
    profiles.push({ ...actual, source: `.github/workflows/${slug}.md`, compiledPresent: compiled !== null, imports });
  }
  const adoption = profiles.find(x => x.compiledPresent);
  workflows.push({ slug, profiles, adoption: { commit: adoption.id, adoptedAt: adoption.at } });
}
try {
  for (const row of implementations) {
    for (const file of row.paths.filter(f => f.endsWith(".go") && !f.endsWith("_test.go"))) {
      source(row.parent, file);
      source(row.commit, file);
    }
  }
  if (process.argv.includes("--universe")) {
    for (const id of ["1869c125eb6172e337d0ee4a0be8621e7728f2df", "9dd21ebefb913330c3e9ba307304797e97faa24c"]) {
      let count = 0;
      function walk(tree, prefix) {
        for (const entry of entries(tree)) {
          const file = `${prefix}${entry.name}`;
          if (entry.mode === "40000") walk(entry.id, `${file}/`);
          else if (/\.(?:go|s|S|c|h|syso|o|a|so|ll|wasm)$/.test(file)) {
            if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Opaque native universe ${file}`);
            source(id, file);
            count++;
          }
        }
      }
      walk(commit(id).tree, "");
      console.log(JSON.stringify({ completeNativeUniverse: id, paths: count }));
    }
    const selected = implementations.find(x => x.number === 26384);
    for (const id of [selected.parent, selected.commit]) {
      source(id, ".github/workflows/code-simplifier.md");
      source(id, ".github/workflows/code-simplifier.lock.yml");
      source(id, ".github/agentics/code-simplifier.md");
    }
    const runFile = `${dir}/api/selected-run-24439426053.json.gz`;
    if (existsSync(runFile)) {
      const original = read(runFile), run = JSON.parse(Buffer.from(original.contentBase64, "base64"));
      const start = new Date(Date.parse(run.created_at) - 86400000).toISOString();
      const result = git(["log", run.head_sha, "--no-merges", `--since=${start}`, `--until=${run.created_at}`,
        "--format=%H", "--", "pkg/workflow/github_cli.go"]);
      if (result.status !== 0) throw new Error(result.stderr.toString());
      const ids = result.stdout.toString().trim().split("\n").filter(Boolean);
      if (ids.length > 100) throw new Error("Recent source-history acquisition bound exceeded");
      const recent = ids.map(id => {
        const row = commit(id);
        source(id, "pkg/workflow/github_cli.go");
        source(row.parents[0], "pkg/workflow/github_cli.go");
        return row;
      });
      source(run.head_sha, ".github/workflows/code-simplifier.md");
      source(run.head_sha, ".github/workflows/code-simplifier.lock.yml");
      const text = source(run.head_sha, ".github/agentics/code-simplifier.md");
      const workflowText = source(run.head_sha, ".github/workflows/code-simplifier.md");
      for (const match of workflowText.matchAll(/^  - (shared\/[\w./-]+\.md)$/gm)) source(run.head_sha, `.github/workflows/${match[1]}`);
      eligibility = { run: run.id, head: run.head_sha, runCreatedAt: run.created_at, windowStart: start,
        recent, runtimePromptPresent: text !== null, candidateListReceipt: null };
    }
  }
} finally { save(); }
mkdirSync(`${dir}/native`, { recursive: true });
console.log(JSON.stringify({ objects: objects.size, paths: paths.size, implementations: implementations.length, workflows }));
