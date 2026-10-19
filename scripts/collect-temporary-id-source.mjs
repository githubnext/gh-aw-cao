import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const cache = ".cache/temporary-id";
mkdirSync(cache, { recursive: true });
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function request(endpoint, binary = false) {
  const file = path.join(cache, `${digest(endpoint)}.${binary ? "zip" : "json"}`);
  if (!existsSync(file)) {
    if (process.env.TEMPORARY_ID_OFFLINE === "1") throw new Error(`Unacquired temporary-ID source endpoint: ${endpoint}`);
    const bytes = execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(file, bytes);
  }
  const bytes = readFileSync(file);
  return binary ? bytes : JSON.parse(bytes);
}
export function blob(sha) {
  const row = request(`repos/github/gh-aw/git/blobs/${sha}`);
  const bytes = Buffer.from(row.content, "base64");
  if (row.sha !== sha || row.encoding !== "base64" || row.size !== bytes.length
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha) {
    throw new Error("Temporary-ID Git source identity mismatch");
  }
  return { gitBlob: sha, sha256: digest(bytes), content: bytes.toString("utf8") };
}
if (process.argv[1]?.endsWith("/collect-temporary-id-source.mjs")) {
  const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
  const tree = request(`repos/github/gh-aw/git/trees/${revision}?recursive=1`);
  if (tree.truncated) throw new Error("Incomplete source tree");
  const paths = [
    ".github/workflows/smoke-temporary-id.md", ".github/workflows/smoke-temporary-id.lock.yml",
    ".github/workflows/shared/otlp.md", ".github/workflows/shared/token-telemetry-check.md",
    ".github/workflows/shared/reporting.md",
    "actions/setup/js/temporary_id.cjs", "actions/setup/js/create_issue.cjs",
    "actions/setup/js/link_sub_issue.cjs", "actions/setup/js/process_safe_outputs.cjs",
    "actions/setup/js/safe_outputs_handlers.cjs", "actions/setup/js/add_comment.cjs",
    "actions/setup/js/safe_outputs_graph_temporary_id.integration.test.cjs",
    "actions/setup/js/safe_outputs_action_outputs.cjs", "actions/setup/js/safe_outputs_bootstrap.cjs",
    "actions/setup/js/safe_output_handler_manager.cjs", "actions/setup/js/sub_issue_helpers.cjs",
    "actions/setup/js/execution_provenance.cjs",
    "actions/setup/js/safe_output_manifest.cjs",
  ];
  const sources = paths.map(file => {
    const entry = tree.tree.find(row => row.path === file);
    if (!entry || entry.type !== "blob") throw new Error(`Missing source ${file}`);
    return { path: file, ...blob(entry.sha) };
  });
  const history = request(`repos/github/gh-aw/commits?path=.github/workflows/smoke-temporary-id.md&sha=${revision}&per_page=100`);
  if (history.length === 100) throw new Error("Source history needs another page");
  const profiles = history.map(commit => {
    const source = request(`repos/github/gh-aw/contents/.github/workflows/smoke-temporary-id.md?ref=${commit.sha}`);
    return { commit: commit.sha, at: commit.commit.committer.date, parents: commit.parents.map(row => row.sha),
      message: commit.commit.message.split("\n")[0], ...blob(source.sha) };
  });
  const first = profiles.at(-1);
  const historicalImports = new Map();
  for (const profile of profiles) {
    const imports = profile.content.match(/^\s+- (shared\/[\w.-]+\.md)\s*$/gm) ?? [];
    for (const line of imports) {
      const file = `.github/workflows/${line.trim().slice(2)}`;
      const key = `${profile.commit}:${file}`;
      const item = request(`repos/github/gh-aw/contents/${file}?ref=${profile.commit}`);
      if (!historicalImports.has(item.sha)) historicalImports.set(item.sha, { path: file, ...blob(item.sha), references: [] });
      historicalImports.get(item.sha).references.push(key);
    }
    for (const match of profile.content.matchAll(/\{\{#(?:runtime-)?import ([\w./-]+\.md)\}\}/g)) {
      const file = match[1].startsWith(".github/") ? match[1] : `.github/workflows/${match[1]}`;
      const item = request(`repos/github/gh-aw/contents/${file}?ref=${profile.commit}`);
      if (!historicalImports.has(item.sha)) historicalImports.set(item.sha, { path: file, ...blob(item.sha), references: [] });
      historicalImports.get(item.sha).references.push(`${profile.commit}:${file}`);
    }
  }
  const parent = request(`repos/github/gh-aw/git/trees/${first.parents[0]}?recursive=1`);
  if (parent.truncated || parent.tree.some(row => row.path === ".github/workflows/smoke-temporary-id.md")) {
    throw new Error("Adoption is not an actual workflow addition");
  }
  const output = { repository: "github/gh-aw", repositoryId: 1036865607, revision,
    cutoff: "2026-10-18T15:00:12Z", sources, profiles, historicalImports: [...historicalImports.values()],
    adoptionParentTree: parent.sha };
  mkdirSync("docs/operational-value/proof/temporary-id", { recursive: true });
  writeFileSync("docs/operational-value/proof/temporary-id/source-review.json.gz", gzipSync(JSON.stringify(output)));
  console.log(JSON.stringify({ sources: sources.length, profiles: profiles.length, adoption: first.commit, adoptedAt: first.at }));
}
