import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = path.resolve("docs/operational-value/proof/cli-consistency-checker");
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function acquireSource(gitDirectory) {
  if (!gitDirectory) throw new Error("An explicit read-only Git directory is required");
  const git = args => execFileSync("git", ["--git-dir", gitDirectory, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const treeBytes = git(["ls-tree", "-rz", revision]);
  const tree = treeBytes.toString("utf8").split("\0").filter(Boolean).map(row => {
    const [metadata, name] = row.split("\t");
    const [mode, type, blob] = metadata.split(" ");
    return { path: name, mode, type, blob };
  });
  const explicit = new Set([
    ".github/workflows/cli-consistency-checker.md",
    ".github/workflows/cli-consistency-checker.lock.yml",
    "docs/src/content/docs/setup/cli.md", "go.mod", "go.sum", "Makefile",
    "cmd/gh-aw/main.go", "cmd/gh-aw/help_examples_test.go", "cmd/gh-aw/help_flag_test.go",
    "cmd/gh-aw/help_sections_order_test.go", "cmd/gh-aw/main_help_text_test.go",
    "pkg/cli/cli_consistency_help_test.go", "pkg/cli/help_text.go", "pkg/cli/commands.go",
  ]);
  const files = new Map(), blockers = [];
  function read(entry) {
    if (!entry || entry.type !== "blob" || entry.mode !== "100644") {
      throw new Error(`Unsupported or absent source entry: ${entry?.path}`);
    }
    try {
      const bytes = git(["cat-file", "blob", entry.blob]);
      const actual = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
      if (actual !== entry.blob) throw new Error("Git content digest mismatch");
      files.set(entry.path, { ...entry, bytes: bytes.length, sha256: sha256(bytes),
        encoding: "base64", content: bytes.toString("base64") });
      return bytes.toString("utf8");
    } catch (error) {
      blockers.push({ path: entry.path, blob: entry.blob, error: error.message });
      return null;
    }
  }
  for (const name of explicit) read(tree.find(entry => entry.path === name));
  const imports = ["otlp", "reporting", "graders", "graders/state-revisit-probability-rep",
    "graders/recurrence-determinism", "graders/recurrence-laminarity"];
  for (const name of imports) read(tree.find(entry => entry.path === `.github/workflows/shared/${name}.md`));
  for (const entry of tree.filter(entry => /^pkg\/cli\/[^/]+\.go$/.test(entry.path) && !entry.path.endsWith("_test.go"))) {
    // Constructor declarations and native behavior remain inspectable without executing fetched Go.
    read(entry);
  }
  const commitBytes = git(["cat-file", "commit", revision]);
  const archive = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
    revision, cutoff, acquisition: "offline Git cat-file; GIT_NO_LAZY_FETCH=1; no target code execution",
    commitBase64: commitBytes.toString("base64"), treeBase64: treeBytes.toString("base64"),
    files: [...files.values()], blockers };
  mkdirSync(directory, { recursive: true });
  writeJsonArchive(path.join(directory, "source.json.gz"), archive,
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  return { files: files.size, blockers, sourceDigest: sha256(JSON.stringify(archive)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(acquireSource(process.argv[2]), null, 2));
}
