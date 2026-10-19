import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const cutoff = "2026-10-18T15:00:12Z";
const functionPath = "docs/operational-value/proof/functions/smoke-ci.mjs";
const root = "docs/operational-value/proof/smoke-ci";
const runtime = ".github/skills/add-operational-value/scripts";
const [artifactDirectory, seedArchive, seedManifest] = process.argv.slice(2);
if (!artifactDirectory || !seedArchive || !seedManifest || !path.isAbsolute(artifactDirectory)) {
  throw new Error("usage: node scripts/package-smoke-ci.mjs ABS_ARTIFACT_DIR SEED_ARCHIVE SEED_MANIFEST");
}
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 16 * 1024 * 1024,
});
const seed = JSON.parse(readFileSync(seedManifest));
if (sha(readFileSync(seedArchive)) !== "f70992410c521b739bd323485108381cf6c9fbf41b6fb12c6f56b664c84f86fb"
  || sha(readFileSync(seedManifest)) !== "24a1ddee03dcf2cf2047fa40d6e57c86f2ec7cc63ebac7e8911c6ff8ee17fef6"
  || seed.files.length !== 35) throw new Error("Bootstrap identity mismatch");
for (const file of seed.files) {
  const bytes = readFileSync(file.path);
  if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Seed changed: ${file.path}`);
}
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) throw new Error("Owned symlink not allowed");
  return entry.isDirectory() ? walk(file) : [file];
});
const files = [
  functionPath, ...walk(root),
  "scripts/collect-smoke-ci.mjs", "scripts/native-smoke-ci.mjs",
  "scripts/package-smoke-ci.mjs", "tests/unit/operational-value-smoke-ci.test.mjs",
].sort();
if (new Set(files).size !== files.length || files.some(file => !statSync(file).isFile())) {
  throw new Error("Unsafe owned file inventory");
}
const manifest = {
  schemaVersion: 1, repository: "githubnext/gh-aw-cao",
  baseline: run("git", ["rev-parse", "HEAD"]).trim(),
  seedArchiveSha256: sha(readFileSync(seedArchive)),
  seedManifestSha256: sha(readFileSync(seedManifest)),
  files: files.map(file => {
    const bytes = readFileSync(file);
    if (file.endsWith(".mjs") && bytes.toString().split("\n").length >= 3000) throw new Error("Module line budget");
    return { path: file, bytes: bytes.length, sha256: sha(bytes) };
  }),
};
manifest.totalOwnedBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
if (manifest.totalOwnedBytes > 256 * 1024) throw new Error("Owned artifact byte budget exceeded");
mkdirSync(artifactDirectory, { recursive: true });
const archive = path.join(artifactDirectory, "smoke-ci-owned.tar.gz");
run("tar", ["-czf", archive, ...files]);
manifest.archiveSha256 = sha(readFileSync(archive));
writeFileSync(path.join(artifactDirectory, "smoke-ci-owned.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const temporary = mkdtempSync(path.join(artifactDirectory, "smoke-ci-independent-"));
try {
  const baseArchive = path.join(temporary, "baseline.tar");
  const checkout = path.join(temporary, "checkout");
  mkdirSync(checkout);
  run("git", ["archive", "--format=tar", `--output=${baseArchive}`, manifest.baseline]);
  run("tar", ["-xf", baseArchive, "-C", checkout]);
  // Seed was completely verified on intake and every live dependency above is
  // checked again; independently check the archive's safe members before use.
  run("python3", ["-c", `
import tarfile,json,hashlib,pathlib
seed=json.load(open(${JSON.stringify(seedManifest)}))
with tarfile.open(${JSON.stringify(seedArchive)}) as t:
 members=t.getmembers(); expected={x['path']:x for x in seed['files']}
 assert len(members)==35 and {x.name for x in members}==set(expected)
 for x in members:
  p=pathlib.PurePosixPath(x.name)
  assert x.isfile() and not p.is_absolute() and '..' not in p.parts
  b=t.extractfile(x).read(); e=expected[x.name]
  assert len(b)==e['bytes'] and hashlib.sha256(b).hexdigest()==e['sha256']
 for x in members:
  p=pathlib.Path(${JSON.stringify(checkout)})/x.name
  p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(t.extractfile(x).read())
`]);
  run("tar", ["-xzf", archive, "-C", checkout]);
  for (const file of [...seed.files, ...manifest.files]) {
    const bytes = readFileSync(path.join(checkout, file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error("Independent extraction mismatch");
  }
  const tests = run(process.execPath, ["--test", "tests/unit/operational-value-smoke-ci.test.mjs"], checkout);
  const verify = run(process.execPath, [`${runtime}/verify-value-function.mjs`, "--collector", functionPath], checkout);
  const evaluation = run(process.execPath, [`${runtime}/evaluate.mjs`, "--root", checkout,
    "--end", cutoff, "--function", functionPath, "--output-dir", `${root}/independent-report`,
    "--no-runs", "--refresh", "github/gh-aw", "smoke-ci"], checkout);
  const fresh = readJsonArchive(path.join(checkout, root, "independent-report/github-gh-aw/smoke-ci-timeline.json"),
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const preserved = readJsonArchive(`${root}/report/smoke-ci-timeline.json.gz`,
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const comparison = timeline => JSON.stringify(timeline.snapshots);
  if (comparison(fresh) !== comparison(preserved)) throw new Error("Fresh replay differs from preserved observations");
  writeFileSync(path.join(artifactDirectory, "smoke-ci-independent-replay.json"), `${JSON.stringify({
    schemaVersion: 1, baseline: manifest.baseline, seedMembers: seed.files.length,
    ownedFiles: files.length, totalOwnedBytes: manifest.totalOwnedBytes,
    archiveSha256: manifest.archiveSha256,
    functionSha256: sha(readFileSync(functionPath)),
    timelineSha256: sha(readFileSync(`${root}/report/smoke-ci-timeline.json.gz`)),
    snapshotSha256: sha(comparison(fresh)), snapshotCount: fresh.snapshots.length,
    isolation: "Fresh default-baseline archive + verified 35-member seed + owned files; no Git cache, output history, installs, network or target execution.",
    tests, verify, evaluation, replayMatches: true,
  }, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ archive, bytes: manifest.totalOwnedBytes, sha256: manifest.archiveSha256 }));
