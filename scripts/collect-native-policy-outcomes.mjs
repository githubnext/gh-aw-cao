import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

export const scope = {
  repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
};
export const slugs = ["weekly-network-domains-audit", "daily-workflow-security-model", "daily-action-setup-security-audit"];
export const directory = "docs/operational-value/proof/native-policy-outcomes";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function save(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const bytes = gzipSync(`${JSON.stringify(value)}\n`, { mtime: 0 });
  if (bytes.length > 256 * 1024) throw new Error(`Artifact exceeds bound: ${file}`);
  writeFileSync(file, bytes);
}
export function load(file) {
  return JSON.parse(gunzipSync(readFileSync(file)));
}
export function acquire(endpoint) {
  if (!/^repos\/github\/gh-aw(?:[/?]|$)/.test(endpoint)) throw new Error("Public repository scope violation");
  const file = `${directory}/originals/${sha256(endpoint)}.json.gz`;
  if (existsSync(file)) {
    const packet = load(file);
    if (packet.endpoint !== endpoint || sha256(packet.body) !== packet.sha256) throw new Error("Original response changed");
    return { value: JSON.parse(packet.body), file };
  }
  const body = execFileSync("gh", ["api", "--method", "GET", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  save(file, { endpoint, body, sha256: sha256(body), observedAt: new Date().toISOString(), acquisition: "gh api GET" });
  return { value: JSON.parse(body), file };
}

export function sourceAt(revision, name) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[\w./-]+$/.test(name) || name.includes("..")) throw new Error("Invalid source reference");
  const result = acquire(`repos/github/gh-aw/contents/${name}?ref=${revision}`);
  const row = result.value;
  if (row.type !== "file" || row.encoding !== "base64" || row.path !== name) throw new Error("Invalid GitHub source response");
  const bytes = Buffer.from(row.content.replace(/\s/g, ""), "base64");
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== row.sha) throw new Error("Git blob custody mismatch");
  return { path: name, revision, blob: row.sha, sha256: sha256(bytes), content: bytes.toString("base64"), receipt: result.file };
}

function sources() {
  const receipt = acquire("repos/github/gh-aw");
  if (receipt.value.id !== scope.repositoryId || receipt.value.private !== false || receipt.value.visibility !== "public") {
    throw new Error("Repository is not the authorized public identity");
  }
  const history = {};
  for (const slug of slugs) {
    const endpoint = `repos/github/gh-aw/commits?sha=${scope.revision}&path=.github/workflows/${slug}.md&per_page=100`;
    const result = acquire(endpoint);
    if (!Array.isArray(result.value) || result.value.length === 100) throw new Error("Source history requires an explicit additional bounded page");
    history[slug] = { receipt: result.file, commits: result.value.map(row => ({
      sha: row.sha, parents: row.parents.map(parent => parent.sha), committedAt: row.commit.committer.date,
      subject: row.commit.message.split("\n")[0],
    })) };
  }
  save(`${directory}/source-history.json.gz`, { scope, repositoryReceipt: receipt.file, history });
  console.log(JSON.stringify(history, null, 2));
}

function sourceClosure() {
  const report = load(`${directory}/source-history.json.gz`);
  const closure = {};
  for (const slug of slugs) {
    const history = report.history[slug].commits;
    const adoption = history.at(-1);
    const addition = acquire(`repos/github/gh-aw/commits/${adoption.sha}`);
    const added = addition.value.files.find(row => row.filename === `.github/workflows/${slug}.md`);
    if (added?.status !== "added" || addition.value.parents[0]?.sha !== adoption.parents[0]) throw new Error("Unverified source adoption");
    closure[slug] = {
      adoption, additionReceipt: addition.file,
      profiles: [scope.revision, ...history.map(row => row.sha)].map(revision => sourceAt(revision, `.github/workflows/${slug}.md`)),
      compiledAtCutoff: sourceAt(scope.revision, `.github/workflows/${slug}.lock.yml`),
    };
  }
  save(`${directory}/source-closure.json.gz`, { scope, closure });
  for (const [slug, entry] of Object.entries(closure)) {
    console.log(`=== ${slug}: adoption ${entry.adoption.sha} ===`);
    console.log(Buffer.from(entry.profiles.at(-1).content, "base64").toString());
  }
}

function candidates() {
  for (const slug of slugs) {
    const discovery = load(`${directory}/${slug}-discovery.json.gz`);
    const entries = discovery.entities.map(entity => {
      const issue = acquire(`repos/github/gh-aw/issues/${entity.number}`);
      const timeline = acquire(`repos/github/gh-aw/issues/${entity.number}/timeline?per_page=100`);
      if (!Array.isArray(timeline.value) || timeline.value.length === 100) throw new Error("Candidate timeline exceeds bound");
      return {
        number: entity.number, title: issue.value.title, issueReceipt: issue.file, timelineReceipt: timeline.file,
        related: timeline.value.filter(row => row.event === "cross-referenced").map(row => ({
          eventAt: row.created_at, number: row.source?.issue?.number, url: row.source?.issue?.html_url,
          title: row.source?.issue?.title, pullRequest: !!row.source?.issue?.pull_request,
        })),
      };
    });
    save(`${directory}/${slug}-candidates.json.gz`, { scope, entries });
    console.log(slug, JSON.stringify(entries, null, 2));
  }
}

function ancestry() {
  for (const number of [67811, 54701, 55587]) {
    const record = load(`${directory}/transition-${number}.json.gz`);
    const receipt = acquire(`repos/github/gh-aw/compare/${record.commit}...${scope.revision}?per_page=1&page=2`);
    if (receipt.value.status !== "ahead" || receipt.value.merge_base_commit?.sha !== record.commit) {
      throw new Error("Landed source is not an ancestor of the frozen benchmark");
    }
    save(`${directory}/ancestry-${number}.json.gz`, { scope, commit: record.commit, receipt: receipt.file });
    console.log(number, receipt.value.status, receipt.value.ahead_by);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "sources") sources();
  else if (process.argv[2] === "source-closure") sourceClosure();
  else if (process.argv[2] === "candidates") candidates();
  else if (process.argv[2] === "ancestry") ancestry();
  else throw new Error("Expected sources, source-closure, candidates or ancestry");
}
