import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition } from "../docs/operational-value/proof/functions/step-name-alignment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ownedRoot = "docs/operational-value/proof/step-name-alignment";
const moduleFile = "docs/operational-value/proof/functions/step-name-alignment.mjs";
const testFile = "tests/unit/operational-value-step-name-alignment.test.mjs";
const collectorFile = "scripts/collect-step-name-alignment.mjs";
const packageFile = "scripts/package-step-name-alignment.mjs";
const timelineFile = `${ownedRoot}/report/github-gh-aw/step-name-alignment-timeline.json`;
const hash = input => createHash("sha256").update(input).digest("hex");
const sha256File = file => hash(readFileSync(file));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const run = (args, cwd = root) => execFileSync(process.execPath, args, {
  cwd, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", npm_config_offline: "true" },
});

function timelineProjection(timeline) {
  return {
    window: timeline.window,
    definition: timeline.valueFunction.definition,
    snapshots: timeline.snapshots.map(snapshot => ({
      observedAt: snapshot.observedAt, window: snapshot.window, evidence: snapshot.evidence,
      provenance: snapshot.provenance, metrics: snapshot.metrics,
    })),
    coverage: timeline.evidenceCoverage,
  };
}

export function packageHandoff(seed, seedManifest, outputDirectory) {
  const seedHash = "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835";
  const seedManifestHash = "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd";
  assert.equal(sha256File(seed), seedHash);
  assert.equal(sha256File(seedManifest), seedManifestHash);
  const native = readJsonArchive(path.join(root, ownedRoot, "native-inputs.json.gz"), {
    maxDecodedBytes: 256 * 1024 * 1024, maxParts: 1536,
  });
  const timeline = readJson(path.join(root, timelineFile));
  assert.equal(timeline.window.endAt, definition.sourceIdentity.cutoff);
  assert.deepEqual(timeline.valueFunction.definition, definition);
  assert.ok(timeline.snapshots.every((snapshot, i, rows) =>
    snapshot.window.endAt <= definition.sourceIdentity.cutoff
    && (!i || rows[i - 1].window.endAt === snapshot.window.startAt)));
  const partialPeriods = timeline.snapshots.filter(snapshot => snapshot.evidence.nativePairs.length > 0)
    .map(snapshot => ({
      window: snapshot.window, observedAt: snapshot.observedAt, metrics: snapshot.metrics,
      coverageStatus: snapshot.evidence.coverageStatus,
      examinedFileTransitions: snapshot.evidence.examinedFileTransitions,
      discoveredFileTransitions: snapshot.evidence.discoveredFileTransitions,
      completePeriodRepairTotal: snapshot.evidence.completePeriodRepairTotal,
    }));
  const readiness = {
    schemaVersion: 1, workflow: definition.slug, sourceIdentity: definition.sourceIdentity,
    frozenHistoryEnd: timeline.window.endAt, producedAt: new Date().toISOString(),
    readiness: {
      implementedFunction: true, producerDecoding: true,
      nativeEvidence: partialPeriods.length > 0, completeNativeEvidence: false,
      fullSemanticFunction: false, acceptedWorkflowContribution: false,
      offlineEvaluation: true, nativePlot: "partial-native-subtotals-only",
    },
    result: "Partial terminology spelling instrument ready; full native workflow value remains blocked, not zero.",
    currentInventory: {
      totalLockFiles: native.currentFiles.length,
      readableLockFiles: native.currentFiles.filter(row => native.blobs[row.blob]?.status === "readable").length,
      missingLockFiles: native.currentFiles.filter(row => native.blobs[row.blob]?.status !== "readable"),
    },
    inputs: {
      firstParentCommits: native.changes.length,
      fileTransitions: native.changes.reduce((sum, row) => sum + row.changes.length, 0),
      objects: Object.keys(native.blobs).length,
      readableObjects: Object.values(native.blobs).filter(row => row.status === "readable").length,
      sourceOriginals: "native-inputs.json.gz#/blobs; complete originals verified against SHA-256 and Git blob IDs",
      missingObjects: "native-inputs.json.gz#/blobs; each status=missing record identifies the exact required immutable blob",
      originalMarkerCandidates: native.history.selectedEntities.filter(row =>
        row.workflowReference?.workflowId === definition.slug || row.unverifiedWorkflowId === definition.slug).length,
      retainedLineageEntities: native.history.selectedEntities.length,
      sharedHistory: { partitions: native.history.index.partitions.length, entities: native.history.index.totalEntities,
        completedAt: native.history.index.completedAt, interpretation: "Later discovery, not historical acceptance." },
    },
    periods: { count: timeline.snapshots.length, disjoint: true, partial: partialPeriods,
      noPreAdoptionComparison: true, noProspectiveResultsAdmitted: true },
    unknown: {
      completePeriodDelivery: null, fullSemanticQuality: null, workflowContribution: null,
      costs: null, keepBar: null, decision: "not-rated",
    },
    blockers: [
      { producer: "Immutable Git source acquisition", request: "Provide exact missing adoption source/lock blobs and full historical source/import/glossary profiles before adoption-relative interpretation.",
        adoption: native.adoption.map(row => ({ ...row, status: native.blobs[row.blob]?.status })) },
      { producer: "Immutable Git native evidence acquisition", request: "Provide the exact missing native blobs in native-inputs.json.gz#/blobs; absence was checked with GIT_NO_LAZY_FETCH=1, not inferred from metadata." },
      { producer: "Independent semantic naming evidence", request: "Supply immutable actual step intent and independent defect/correction adjudication, consistency/clarity criteria and regression evidence; no workflow-written suggestions or guessed acceptance booleans." },
      { producer: "Independent contribution lineage", request: "Supply protected original producer receipts and verified downstream graph edges bound to native accepted corrections; editable markers and current issue state remain discovery." },
      { producer: "Secondary terminology authority", request: "Supply retained immutable AI Coding Dictionary content to implement generic-AI term checks; its URL does not prove content." },
    ],
    validation: {
      nativeFixtures: "node --test tests/unit/operational-value-step-name-alignment.test.mjs",
      collector: `node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector ${moduleFile}`,
      evaluator: `node .github/skills/add-operational-value/scripts/evaluate.mjs --end ${definition.sourceIdentity.cutoff} --function ${moduleFile} --output-dir ${ownedRoot}/report github/gh-aw step-name-alignment`,
      compile: "npm run compile passed (71 workflows).",
      lint: "Owned code passed npm exec --offline --no -- eslint --no-ignore; root npm run lint is blocked by missing yaml.",
      typecheck: "Root npm run typecheck:cao is blocked by unavailable TypeScript; no installation authorized.",
    },
    dependencySeed: { sha256: seedHash, manifestSha256: seedManifestHash,
      members: 32, ownership: "Dependency only; unmodified and excluded from owned archive." },
  };
  writeJson(path.join(root, ownedRoot, "readiness.json"), readiness);
  const owned = [moduleFile, collectorFile, packageFile, testFile,
    ...walk(path.join(root, ownedRoot)).map(file => path.relative(root, file))].sort();
  assert.equal(new Set(owned).size, owned.length);
  const files = owned.map(file => {
    const stat = lstatSync(path.join(root, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, `Unbounded/unsafe member: ${file}`);
    if (file.endsWith(".mjs")) assert.ok(readFileSync(path.join(root, file), "utf8").split("\n").length <= 3000);
    return { path: file, bytes: stat.size, sha256: sha256File(path.join(root, file)) };
  });
  const dependencies = ["dashboard/site/src/data/model/schema.js", "dashboard/site/src/debug.js"]
    .map(file => ({ path: file, sha256: sha256File(path.join(root, file)) }));
  mkdirSync(outputDirectory, { recursive: true });
  const archiveFile = path.resolve(outputDirectory, "step-name-alignment-owned.tar.gz");
  execFileSync("tar", ["-czf", archiveFile, "-C", root, ...owned], { timeout: 120000 });
  const archiveHash = sha256File(archiveFile);
  const temporary = mkdtempSync(path.join(root, ".step-name-alignment-replay-"));
  let replay;
  try {
    const verifyExtract = String.raw`
import sys,pathlib,hashlib,json,tarfile
seed,manifest,owned,destination=sys.argv[1:]
expected=json.loads(pathlib.Path(manifest).read_text())["files"]
with tarfile.open(seed) as archive:
    members=archive.getmembers()
    assert len(members)==32 and {x.name for x in members}=={x["path"] for x in expected}
    lookup={x["path"]:x for x in expected}
    for member in members:
        assert member.isfile() and not pathlib.PurePosixPath(member.name).is_absolute() and ".." not in pathlib.PurePosixPath(member.name).parts
        data=archive.extractfile(member).read()
        assert len(data)==lookup[member.name]["bytes"] and hashlib.sha256(data).hexdigest()==lookup[member.name]["sha256"]
    archive.extractall(destination,filter="data")
with tarfile.open(owned) as archive:
    for member in archive.getmembers():
        assert member.isfile() and not pathlib.PurePosixPath(member.name).is_absolute() and ".." not in pathlib.PurePosixPath(member.name).parts and member.size<=256*1024
    archive.extractall(destination,filter="data")
`;
    execFileSync("python3", ["-c", verifyExtract, seed, seedManifest, archiveFile, temporary], { timeout: 120000 });
    for (const file of files) assert.equal(sha256File(path.join(temporary, file.path)), file.sha256);
    const seedEntries = JSON.parse(readFileSync(seedManifest, "utf8")).files;
    for (const entry of seedEntries) assert.equal(sha256File(path.join(temporary, entry.path)), entry.sha256);
    for (const dependency of dependencies) {
      const target = path.join(temporary, dependency.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, dependency.path), target);
      assert.equal(sha256File(target), dependency.sha256);
    }
    const verification = run([".github/skills/add-operational-value/scripts/verify-value-function.mjs",
      "--collector", moduleFile], temporary);
    const tests = run(["--test", testFile], temporary);
    const evaluator = run([".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", temporary,
      "--end", definition.sourceIdentity.cutoff, "--function", moduleFile,
      "--output-dir", `${ownedRoot}/fresh-report`, "github/gh-aw", "step-name-alignment"], temporary);
    const fresh = readJson(path.join(temporary, ownedRoot, "fresh-report/github-gh-aw/step-name-alignment-timeline.json"));
    assert.deepEqual(timelineProjection(fresh), timelineProjection(timeline));
    for (const entry of seedEntries) assert.equal(sha256File(path.join(temporary, entry.path)), entry.sha256);
    replay = { independentFreshExtraction: true, verifiedOwnedMembers: files.length, verifiedSeedMembers: 32,
      freshCollector: verification.trim(), freshTests: tests.trim().split("\n").slice(-10),
      freshEvaluator: evaluator.trim().split("\n"), identicalNativeEvidenceAndScores: true,
      end: fresh.window.endAt, periods: fresh.snapshots.length,
      sourceObjectsVerifiedByReplay: readiness.inputs.readableObjects,
      originalDependencySeedUnchanged: sha256File(seed) === seedHash && sha256File(seedManifest) === seedManifestHash };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const manifest = {
    schemaVersion: 1, kind: "step-name-alignment-owned-handoff",
    repository: definition.repository, sourceIdentity: definition.sourceIdentity,
    archive: { file: path.basename(archiveFile), sha256: archiveHash, bytes: lstatSync(archiveFile).size },
    dependencies: { seedSha256: seedHash, seedManifestSha256: seedManifestHash,
      repositoryBaseFiles: dependencies, environment: { node: process.version,
        ruby: "2.6.10", psych: "3.1.0", libyaml: "0.2.1" } },
    ownership: "Only assigned step-name-alignment paths; no shared seed/base files, external absolute imports, commits or PRs.",
    files, replay,
  };
  const manifestFile = path.resolve(outputDirectory, "step-name-alignment-owned.manifest.json");
  writeJson(manifestFile, manifest);
  const receiptFile = path.resolve(outputDirectory, "step-name-alignment-owned.receipt.json");
  writeJson(receiptFile, { archive: archiveFile, archiveSha256: archiveHash,
    manifest: manifestFile, manifestSha256: sha256File(manifestFile), replay });
  return { archive: archiveFile, archiveSha256: archiveHash, manifest: manifestFile,
    manifestSha256: sha256File(manifestFile), receipt: receiptFile,
    ownedMembers: files.length, replay };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error(
    "usage: node scripts/package-step-name-alignment.mjs SEED_ARCHIVE SEED_MANIFEST OUTPUT_DIRECTORY");
  console.log(JSON.stringify(packageHandoff(path.resolve(process.argv[2]),
    path.resolve(process.argv[3]), path.resolve(process.argv[4])), null, 2));
}
