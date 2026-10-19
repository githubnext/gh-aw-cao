import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { originalBytes } from "./native-smoke-pydantic.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const proof = "docs/operational-value/proof/smoke-pydantic";
const owned = [proof, "docs/operational-value/proof/functions/smoke-pydantic.mjs",
  "scripts/collect-smoke-pydantic.mjs", "scripts/native-smoke-pydantic.mjs",
  "scripts/package-smoke-pydantic.mjs", "tests/unit/operational-value-smoke-pydantic.test.mjs"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const seedArchiveSha = "f70992410c521b739bd323485108381cf6c9fbf41b6fb12c6f56b664c84f86fb";
const seedManifestSha = "24a1ddee03dcf2cf2047fa40d6e57c86f2ec7cc63ebac7e8911c6ff8ee17fef6";
const command = (executable, args, cwd = root) => execFileSync(executable, args, {
  cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
});
const walk = relative => statSync(path.join(root, relative)).isDirectory()
  ? readdirSync(path.join(root, relative)).sort().flatMap(name => walk(`${relative}/${name}`)) : [relative];

function extractVerified(archive, manifest, destination) {
  const python = `
import hashlib,json,pathlib,tarfile,sys
archive,manifest,destination=sys.argv[1:]
m=json.loads(pathlib.Path(manifest).read_bytes())
assert hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest()==m['archiveSha256']
expected={f['path']:f for f in m['files']}
assert len(expected)==len(m['files'])
with tarfile.open(archive) as t:
 members=t.getmembers()
 assert len(members)==len(expected) and {x.name for x in members}==set(expected)
 for x in members:
  p=pathlib.PurePosixPath(x.name)
  assert x.isfile() and not p.is_absolute() and '..' not in p.parts and str(p)==x.name and x.name in expected
  b=t.extractfile(x).read(); e=expected[x.name]
  assert len(b)==e['bytes'] and hashlib.sha256(b).hexdigest()==e['sha256']
 for x in members:
  p=pathlib.Path(destination)/x.name
  p.parent.mkdir(parents=True,exist_ok=True)
  p.write_bytes(t.extractfile(x).read())
print(len(expected))
`;
  return Number(command("python3", ["-c", python, archive, manifest, destination]).trim());
}

export function packageProof(seedArchive, seedManifest, output) {
  if (sha(readFileSync(seedArchive)) !== seedArchiveSha
    || sha(readFileSync(seedManifest)) !== seedManifestSha) throw new Error("Bootstrap digest mismatch");
  const seed = JSON.parse(readFileSync(seedManifest, "utf8"));
  if (seed.files.length !== 35) throw new Error("Expected exactly 35 bootstrap dependencies");
  for (const file of seed.files) {
    const bytes = readFileSync(path.join(root, file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`Seed changed: ${file.path}`);
  }
  const files = owned.flatMap(walk).sort().map(file => {
    const bytes = readFileSync(path.join(root, file));
    if (bytes.length > 256 * 1024) throw new Error(`Owned size budget exceeded: ${file}`);
    if (file.endsWith(".mjs") && bytes.toString("utf8").split("\n").length >= 3000) {
      throw new Error(`Owned module line budget exceeded: ${file}`);
    }
    return { path: file, bytes: bytes.length, sha256: sha(bytes) };
  });
  mkdirSync(output, { recursive: true });
  const archive = path.resolve(output, "smoke-pydantic-owned.tar.gz");
  const manifestFile = path.resolve(output, "smoke-pydantic-owned.manifest.json");
  const tarScript = `
import pathlib,tarfile,sys
root,archive=sys.argv[1:3]
with tarfile.open(archive,'w:gz',format=tarfile.USTAR_FORMAT) as t:
 for name in sys.argv[3:]:
  t.add(pathlib.Path(root)/name,arcname=name,recursive=False)
`;
  command("python3", ["-c", tarScript, root, archive, ...files.map(file => file.path)]);
  const baseline = command("git", ["rev-parse", "HEAD"]).trim();
  const manifest = { schemaVersion: 1, baseline, archiveSha256: sha(readFileSync(archive)), files };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const work = mkdtempSync(path.join(root, ".smoke-pydantic-replay-"));
  try {
    const baseArchive = execFileSync("git", ["archive", baseline], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", work], { input: baseArchive });
    const seedCount = extractVerified(seedArchive, seedManifest, work);
    const ownedCount = extractVerified(archive, manifestFile, work);
    const results = [];
    const predecessor = JSON.parse(readFileSync(path.join(work, proof, "predecessor-v1.json"), "utf8"));
    for (const file of predecessor.files) {
      writeFileSync(path.join(work, file.path), originalBytes(path.join(work, proof), file.original));
    }
    for (const args of [
      ["--test", "tests/unit/operational-value-smoke-pydantic.test.mjs"],
      [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector",
        "docs/operational-value/proof/functions/smoke-pydantic.mjs"],
    ]) results.push({ phase: "preserved-strict-predecessor", args,
      output: command(process.execPath, args, work) });
    extractVerified(archive, manifestFile, work);
    for (const args of [
      ["--test", "tests/unit/operational-value-smoke-pydantic.test.mjs"],
      [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector",
        "docs/operational-value/proof/functions/smoke-pydantic.mjs"],
      [".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", work,
        "--end", "2026-10-18T15:00:12Z", "--function", "docs/operational-value/proof/functions/smoke-pydantic.mjs",
        "--output-dir", `${proof}/reports`, "--no-runs", "--refresh", "github/gh-aw", "smoke-pydantic"],
      ["scripts/native-smoke-pydantic.mjs", "--report"],
    ]) results.push({ phase: "current-additive-contract", args: args.map(arg => arg === work ? "<fresh-root>" : arg),
      output: command(process.execPath, args, work) });
    const proofModule = path.join(work, "docs/operational-value/proof/functions/smoke-pydantic.mjs");
    if (sha(readFileSync(proofModule)) !== files.find(file =>
      file.path === "docs/operational-value/proof/functions/smoke-pydantic.mjs").sha256) {
      throw new Error("Replay changed the frozen value function");
    }
    const expectedAssessment = readJsonArchive(path.join(root, proof, "assessment.json"));
    const actualAssessment = readJsonArchive(path.join(work, proof, "assessment.json"));
    const quantities = value => ({ genuineNativeMeasurement: value.genuineNativeMeasurement,
      periods: value.periods, costs: value.costs, discovery: value.discovery });
    if (JSON.stringify(quantities(expectedAssessment)) !== JSON.stringify(quantities(actualAssessment))) {
      throw new Error("Fresh replay changed native quantities, coverage, discovery or sampled costs");
    }
    if (actualAssessment.genuineNativeMeasurement.pythonFilesystemPartial.acceptedObservedCases !== 1
      || actualAssessment.genuineNativeMeasurement.pythonFilesystemPartial.successfulNativeReadResults !== 3
      || actualAssessment.genuineNativeMeasurement.strictReadFile.acceptedObservedCases !== 0) {
      throw new Error("Unexpected genuine native read quantities");
    }
    for (const file of seed.files) {
      if (sha(readFileSync(path.join(work, file.path))) !== file.sha256) throw new Error("Replay changed a seed dependency");
    }
    const receipt = { schemaVersion: 1, verifiedAt: new Date().toISOString(), baseline,
      archiveSha256: manifest.archiveSha256, manifestSha256: sha(readFileSync(manifestFile)),
      seedArchiveSha256: seedArchiveSha, seedManifestSha256: seedManifestSha,
      verifiedSeedFiles: seedCount, verifiedOwnedFiles: ownedCount,
      freshBaselineSeedOwnedOnly: true, sharedHistoryOrCachesRequired: false,
      preservedStrictPredecessorReplay: "passed", exactNativeQuantitiesReplay: "passed",
      genuineNativeMeasurement: actualAssessment.genuineNativeMeasurement,
      archivedAssessmentPin: files.find(file => file.path === `${proof}/assessment.json`),
      replayedTimelinePin: actualAssessment.pins.timeline,
      node: process.version, results };
    writeFileSync(path.join(output, "smoke-pydantic-replay-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, manifest, output] = process.argv.slice(2);
  if (!archive || !manifest || !output) throw new Error("usage: node scripts/package-smoke-pydantic.mjs SEED SEED_MANIFEST OUTPUT_DIRECTORY");
  const result = packageProof(path.resolve(archive), path.resolve(manifest), path.resolve(output));
  console.log(JSON.stringify({ archiveSha256: result.archiveSha256, seed: result.verifiedSeedFiles,
    owned: result.verifiedOwnedFiles, replay: "passed" }));
}
