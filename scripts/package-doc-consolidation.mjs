import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = "590529ea3a0a6e4dab9e57f933b4b01f69f0fb77";
const cutoff = "2026-10-18T15:00:12Z";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const slugs = ["unbloat-docs", "developer-docs-consolidator", "claude-code-user-docs-review"];
const proof = "docs/operational-value/proof/doc-consolidation";
const evaluator = ".github/skills/add-operational-value/scripts/evaluate.mjs";
const verifier = ".github/skills/add-operational-value/scripts/verify-value-function.mjs";
const functionPath = slug => `docs/operational-value/proof/functions/${slug}.mjs`;

function walk(directory) {
  return readdirSync(path.join(root, directory)).flatMap(name => {
    const filename = path.posix.join(directory, name), stat = lstatSync(path.join(root, filename));
    if (stat.isSymbolicLink()) throw new Error("Symlink in owned handoff");
    return stat.isDirectory() ? walk(filename) : [filename];
  });
}

function pinnedFile(filename) {
  const bytes = readFileSync(path.join(root, filename));
  if (bytes.length > 262144) throw new Error(`Owned file exceeds byte budget: ${filename}`);
  return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
}

export function packageCohort(outputDirectory) {
  const output = path.resolve(outputDirectory);
  if (output === root || output.startsWith(`${root}${path.sep}`)) throw new Error("Private package destination must be outside checkout");
  mkdirSync(output, { recursive: true });
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (current !== baseline) throw new Error("Wrong active integration baseline");
  const files = [...walk(proof), ...slugs.map(functionPath),
    "scripts/collect-doc-consolidation.mjs", "scripts/native-doc-consolidation.mjs",
    "scripts/package-doc-consolidation.mjs", "tests/unit/operational-value-doc-consolidation.test.mjs"].sort();
  const owned = files.map(pinnedFile);
  if (new Set(files).size !== files.length) throw new Error("Repeated owned path");
  const archive = path.join(output, "doc-consolidation-owned-v1.tar.gz");
  execFileSync("tar", ["-czf", archive, "--", ...files], { cwd: root });
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(members, files);
  const archiveSha256 = hash(readFileSync(archive));
  const dependencies = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, ".github/skills/add-operational-value"],
    { cwd: root, encoding: "utf8" }).trim().split("\n");
  const dependencyClosure = dependencies.map(filename => {
    const original = execFileSync("git", ["show", `${baseline}:${filename}`], { cwd: root });
    if (!original.equals(readFileSync(path.join(root, filename)))) throw new Error("Dependency differs from integration baseline");
    return { path: filename, bytes: original.length, sha256: hash(original) };
  });
  const receipt = { schemaVersion: 1, baseline, cutoff, archiveSha256, dependencyClosure,
    historicalSeed: { archiveSha256: "f70992410c521b739bd323485108381cf6c9fbf41b6fb12c6f56b664c84f86fb",
      manifestSha256: "24a1ddee03dcf2cf2047fa40d6e57c86f2ec7cc63ebac7e8911c6ff8ee17fef6",
      status: "Historical v021 bootstrap verified before transition; not overlaid onto newer integration dependency closure." },
    replay: { sharedCaches: false, targetGitHistory: false, networkAcquisition: false, nodeModules: false },
    commands: [], timelineComparisons: [], artifacts: owned.filter(item => /(?:functions\/|timeline\.json$|pulse\.html$|pulse\.json$)/.test(item.path)) };
  const temporary = mkdtempSync(path.join(root, ".doc-consolidation-replay-"));
  try {
    for (const item of dependencyClosure) {
      const filename = path.join(temporary, item.path);
      mkdirSync(path.dirname(filename), { recursive: true });
      const original = execFileSync("git", ["show", `${baseline}:${item.path}`], { cwd: root });
      writeFileSync(filename, original);
    }
    if (hash(readFileSync(archive)) !== archiveSha256) throw new Error("Package changed before replay");
    execFileSync("tar", ["-xzf", archive], { cwd: temporary });
    for (const item of owned) {
      const bytes = readFileSync(path.join(temporary, item.path));
      if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error("Fresh replay extraction mismatch");
    }
    const evaluations = path.join(temporary, proof, "evaluations");
    if (existsSync(evaluations)) rmSync(evaluations, { recursive: true });
    assert.equal(existsSync(path.join(temporary, ".git")), false);
    assert.equal(existsSync(path.join(temporary, "node_modules")), false);
    const bin = path.join(temporary, ".replay-bin");
    mkdirSync(bin);
    const shasum = execFileSync("which", ["shasum"], { encoding: "utf8" }).trim();
    symlinkSync(shasum, path.join(bin, "shasum"));
    const env = { ...process.env, PATH: bin, NODE_PATH: "", GIT_NO_LAZY_FETCH: "1", GH_TOKEN: "",
      GITHUB_TOKEN: "", GH_HOST: "", NODE_OPTIONS: "" };
    function run(args) {
      const stdout = execFileSync(process.execPath, args, { cwd: temporary, env, encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      receipt.commands.push({ command: ["node", ...args], exitCode: 0, stdout });
    }
    run(["--test", "tests/unit/operational-value-doc-consolidation.test.mjs"]);
    for (const slug of slugs) {
      run([verifier, "--collector", functionPath(slug)]);
      run([evaluator, "--root", ".", "--end", cutoff, "--output-dir", `${proof}/evaluations`,
        "--function", functionPath(slug), "--refresh", "github/gh-aw", slug]);
      const timeline = `${proof}/evaluations/github-gh-aw/${slug}-timeline.json`;
      const original = JSON.parse(readFileSync(path.join(root, timeline)));
      const replayed = JSON.parse(readFileSync(path.join(temporary, timeline)));
      const normalize = value => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
          .filter(([key]) => key !== "generatedAt").map(([key, child]) => [key, normalize(child)]));
        return value;
      };
      assert.deepEqual(normalize(replayed), normalize(original));
      receipt.timelineComparisons.push({ path: timeline, semanticIdentity: true,
        ignoredField: "generatedAt", originalSha256: hash(readFileSync(path.join(root, timeline))),
        freshReplaySha256: hash(readFileSync(path.join(temporary, timeline))),
        snapshots: replayed.snapshots.length, nonNullNative: replayed.snapshots.filter(snapshot => snapshot.metrics["native-improvements"] !== null).length,
        latestNative: replayed.snapshots.at(-1).metrics["native-improvements"] });
    }
  } finally {
    rmSync(temporary, { recursive: true });
  }
  const manifest = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607, baseline, cutoff,
    archive: path.basename(archive), archiveSha256, dependencyFilesExcluded: dependencyClosure.length,
    files: owned };
  const manifestFile = path.join(output, "doc-consolidation-owned-v1.manifest.json");
  const replayFile = path.join(output, "doc-consolidation-owned-v1.replay.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(replayFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return [archive, manifestFile, replayFile].map(filename => ({ path: filename, bytes: lstatSync(filename).size,
    sha256: hash(readFileSync(filename)) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-doc-consolidation.mjs PRIVATE_ARTIFACT_DIRECTORY");
  console.log(JSON.stringify(packageCohort(process.argv[2]), null, 2));
}
