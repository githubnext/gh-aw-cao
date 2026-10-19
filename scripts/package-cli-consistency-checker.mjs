import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const output = process.argv[2], seed = process.argv[3], seedManifest = process.argv[4];
if (![output, seed, seedManifest].every(value => value && path.isAbsolute(value))) {
  throw new Error("Usage: package-cli-consistency-checker.mjs ABSOLUTE_OUTPUT_DIR SEED_TGZ SEED_MANIFEST");
}
const root = process.cwd();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
if (digest(readFileSync(seed)) !== "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835"
  || digest(readFileSync(seedManifest)) !== "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd") {
  throw new Error("Seed digest mismatch");
}
const seedFiles = JSON.parse(readFileSync(seedManifest)).files;
for (const entry of seedFiles) {
  if (digest(readFileSync(entry.path)) !== entry.sha256 || statSync(entry.path).size !== entry.bytes) {
    throw new Error(`Seed changed in working checkout: ${entry.path}`);
  }
}
const ownedDirectory = "docs/operational-value/proof/cli-consistency-checker";
const files = ["docs/operational-value/proof/functions/cli-consistency-checker.mjs"];
const walk = directory => {
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) walk(file);
    else files.push(file);
  }
};
walk(ownedDirectory);
files.push(...readdirSync("scripts").filter(file => /cli-consistency-checker.*\.mjs$/.test(file)).map(file => `scripts/${file}`));
files.push(...readdirSync("tests/unit").filter(file => /^operational-value-cli-consistency-checker.*\.test\.mjs$/.test(file))
  .map(file => `tests/unit/${file}`));
files.sort();
if (new Set(files).size !== files.length) throw new Error("Repeated owned path");
const entries = files.map(file => {
  const bytes = readFileSync(file);
  if (bytes.length > 256 * 1024) throw new Error(`Oversized member: ${file}`);
  const lines = file.endsWith(".mjs") ? bytes.toString("utf8").split("\n").length : null;
  if (lines > 3000) throw new Error(`Oversized module: ${file}`);
  if (file.endsWith(".mjs")) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  return { path: file, bytes: bytes.length, sha256: digest(bytes), ...(lines ? { lines } : {}) };
});
mkdirSync(output, { recursive: true });
const archive = path.join(output, "cli-consistency-checker-owned.tar.gz");
execFileSync("tar", ["-czf", archive, ...files], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const fresh = mkdtempSync(path.join(root, ".cli-consistency-checker-replay-"));
const commands = [];
try {
  const baseline = execFileSync("git", ["archive", "HEAD", "package.json", "dashboard/site/package.json",
    "dashboard/site/src/data/model/schema.js", "dashboard/site/src/debug.js"]);
  execFileSync("tar", ["-xf", "-", "-C", fresh], { input: baseline });
  execFileSync("tar", ["-xzf", seed, "-C", fresh]);
  for (const entry of seedFiles) {
    if (digest(readFileSync(path.join(fresh, entry.path))) !== entry.sha256) throw new Error("Fresh seed changed");
  }
  execFileSync("tar", ["-xzf", archive, "-C", fresh]);
  for (const entry of entries) {
    if (digest(readFileSync(path.join(fresh, entry.path))) !== entry.sha256) throw new Error("Fresh owned extraction changed");
  }
  const commandLists = [
    ["--test", "tests/unit/operational-value-cli-consistency-checker.test.mjs"],
    [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector",
      "docs/operational-value/proof/functions/cli-consistency-checker.mjs"],
    ["scripts/freeze-cli-consistency-checker-contract.mjs"],
    ["scripts/replay-cli-consistency-checker.mjs"],
  ];
  for (const args of commandLists) {
    const result = spawnSync(process.execPath, args, { cwd: fresh, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    commands.push({ command: [process.execPath, ...args], status: result.status,
      stdout: result.stdout, stderr: result.stderr });
    if (result.error || result.status !== 0) throw new Error(`Fresh replay failed: ${result.error ?? result.stderr}`);
  }
  const replay = readJsonArchive(path.join(fresh, ownedDirectory, "replay.json"));
  const original = readJsonArchive(path.join(root, ownedDirectory, "replay.json"));
  if (JSON.stringify(replay.nativeMetric) !== JSON.stringify(original.nativeMetric)) {
    throw new Error("Native outcome changed during fresh replay");
  }
  for (const entry of seedFiles) {
    if (digest(readFileSync(path.join(fresh, entry.path))) !== entry.sha256) throw new Error("Fresh replay changed seed");
  }
  const manifest = { schemaVersion: 1, archive: path.basename(archive), archiveSha256: digest(readFileSync(archive)),
    seedArchiveSha256: digest(readFileSync(seed)), seedManifestSha256: digest(readFileSync(seedManifest)),
    seedIncluded: false, files: entries,
    freshReplay: { independentExtraction: true, sharedHistoryAndGitCacheAccess: false, commands,
      nativeMetric: replay.nativeMetric, fullAcceptance: null, contribution: null,
      frozenEvaluation: replay.frozenEvaluation.reason } };
  const manifestFile = path.join(output, "cli-consistency-checker-owned.manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ archive, archiveSha256: manifest.archiveSha256,
    manifest: manifestFile, manifestSha256: digest(readFileSync(manifestFile)), members: entries.length,
    bytes: statSync(archive).size, freshReplay: "passed", nativeMetric: replay.nativeMetric }, null, 2));
} finally {
  if (existsSync(fresh)) rmSync(fresh, { recursive: true });
}
