import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [outputDirectory, seedArchive, seedManifest] = process.argv.slice(2);
if (!outputDirectory || !seedArchive || !seedManifest) throw new Error("Expected output directory, seed archive and seed manifest");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = file => digest(readFileSync(file));
const seedSha = "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835";
const seedManifestSha = "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd";
assert.equal(sha(seedArchive), seedSha);
assert.equal(sha(seedManifest), seedManifestSha);
const seed = JSON.parse(readFileSync(seedManifest));
assert.equal(seed.files.length, 32);
for (const item of seed.files) {
  assert.equal(sha(item.path), item.sha256, `Seed changed: ${item.path}`);
  assert.equal(statSync(item.path).size, item.bytes);
}
const root = process.cwd();
const proof = "docs/operational-value/proof/daily-syntax-error-quality";
const modulePath = "docs/operational-value/proof/functions/daily-syntax-error-quality.mjs";
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.posix.join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});
const files = [
  modulePath, ...walk(proof),
  "scripts/preserve-daily-syntax-error-quality.mjs",
  "scripts/package-daily-syntax-error-quality.mjs",
  "tests/unit/operational-value-daily-syntax-error-quality.test.mjs",
].sort();
assert.equal(new Set(files).size, files.length);
for (const file of files) {
  assert.ok(statSync(file).size <= 256 * 1024, `Unbounded member: ${file}`);
  assert.ok(!seed.files.some(item => item.path === file), `Seed included in owned package: ${file}`);
  if (file.endsWith(".mjs")) assert.ok(readFileSync(file, "utf8").split("\n").length <= 3000);
}
const output = path.resolve(outputDirectory);
mkdirSync(output, { recursive: true });
const archive = path.join(output, "daily-syntax-error-quality-owned.tar.gz");
const manifestFile = path.join(output, "daily-syntax-error-quality-owned.manifest.json");
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", npm_config_offline: "true" },
});
run("tar", ["-czf", archive, ...files]);
const entries = run("tar", ["-tzf", archive]).trim().split("\n").sort();
assert.deepEqual(entries, files);
const receipt = {
  schemaVersion: 1, scope: "OWNED-ONLY daily-syntax-error-quality",
  repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
  archive: path.basename(archive), archiveSha256: sha(archive),
  seedExcluded: { archiveSha256: seedSha, manifestSha256: seedManifestSha, files: 32 },
  files: files.map(file => ({ path: file, bytes: statSync(file).size, sha256: sha(file) })),
};
const replay = mkdtempSync(path.join(root, ".daily-syntax-error-quality-replay-"));
try {
  run("tar", ["-xzf", path.resolve(seedArchive), "-C", replay]);
  run("tar", ["-xzf", archive, "-C", replay]);
  for (const item of [...seed.files, ...receipt.files]) {
    assert.equal(sha(path.join(replay, item.path)), item.sha256, `Fresh extraction mismatch: ${item.path}`);
  }
  // The standard verifier imports these existing CAO runtime files, not native workflow code.
  const support = ["dashboard/site/src/data/model/schema.js", "dashboard/site/src/debug.js"];
  for (const file of support) {
    mkdirSync(path.dirname(path.join(replay, file)), { recursive: true });
    copyFileSync(file, path.join(replay, file));
  }
  writeFileSync(path.join(replay, "package.json"), '{"type":"module"}\n');
  const tests = run(process.execPath, ["--test", "tests/unit/operational-value-daily-syntax-error-quality.test.mjs"], replay);
  const verifier = ".github/skills/add-operational-value/scripts/verify-value-function.mjs";
  const collector = run(process.execPath, [verifier, "--collector", modulePath], replay);
  const outputRoot = `${proof}/evaluation`;
  const evaluator = run(process.execPath, [
    ".github/skills/add-operational-value/scripts/evaluate.mjs",
    "--root", replay, "--end", receipt.cutoff, "--output-dir", outputRoot,
    "--function", modulePath, "--no-runs", "--refresh", "github/gh-aw", "daily-syntax-error-quality",
  ], replay);
  const timelinePath = `${outputRoot}/github-gh-aw/daily-syntax-error-quality-timeline.json`;
  const original = readJsonArchive(timelinePath);
  const fresh = readJsonArchive(path.join(replay, timelinePath));
  assert.equal(fresh.snapshots.length, 1);
  assert.deepEqual(fresh.snapshots, original.snapshots);
  assert.deepEqual(fresh.valueFunction, original.valueFunction);
  assert.ok(fresh.snapshots.every(snapshot => Object.values(snapshot.metrics).every(value => value === null)));
  receipt.replay = {
    freshExtraction: true, independentlyReplayed: true, allPackagedFilesAndSeedRehashed: true,
    tests: tests.trim(), standardCollector: collector.trim(), offlineEvaluator: evaluator.trim(),
    cutoff: receipt.cutoff, snapshots: fresh.snapshots.length, values: "All unavailable null, not zero",
    supportFiles: support.map(file => ({ path: file, sha256: sha(file) })),
    supportScope: "Two unchanged local CAO runtime dependencies supplied only to the independent replay; neither seed nor support files are owned package members.",
    network: "No network, install, acquired gh-aw code execution, workflow dispatch or remote writes.",
    lintAndTypecheck: "Existing eslint and tsc binaries absent; attempted without installation. Node syntax checks and focused native tests passed.",
  };
} finally {
  rmSync(replay, { recursive: true, force: true });
}
writeFileSync(manifestFile, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  archive, archiveSha256: receipt.archiveSha256, manifest: manifestFile, manifestSha256: sha(manifestFile),
  members: files.length, bytes: statSync(archive).size, replay: "passed",
}, null, 2));
