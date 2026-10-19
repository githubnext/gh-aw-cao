import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadNative } from "./native-smoke-capabilities.mjs";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";

const root = process.cwd(), proof = "docs/operational-value/proof/native-smoke-capabilities";
const skill = ".github/skills/add-operational-value/scripts";
const workflows = ["claude", "gemini", "kiro", "opencode", "cursor", "crush"].map(name => `smoke-${name}`);
const test = "tests/unit/operational-value-native-smoke-capabilities.test.mjs";
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== "--output-dir"
  || (args.length === 4 && args[2] !== "--repackage-from")) {
  throw new Error("Required: --output-dir FRESH_OWNED_DIRECTORY [--repackage-from PREVIOUS_MANIFEST]");
}
if (process.platform !== "darwin") throw new Error("This bounded packager requires macOS sandbox-exec for enforced isolated replay");
const output = path.resolve(args[1]);
mkdirSync(output, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = file => {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: hash(bytes) };
};
const run = (command, commandArgs, cwd = root, env = process.env) => execFileSync(command, commandArgs, {
  cwd, env: { ...env, COPYFILE_DISABLE: "1" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000,
});
const verifyArchive = (archive, manifest) => JSON.parse(run("python3", ["-c", [
  "import sys,tarfile,json,hashlib",
  "manifest=json.load(open(sys.argv[2])); expected={r['path']:r for r in manifest['files']}",
  "assert len(expected)==len(manifest['files']), 'Duplicate manifest paths'",
  "with tarfile.open(sys.argv[1], 'r:gz') as archive:",
  " members=archive.getmembers(); regular=[m for m in members if m.isfile()]",
  " assert all(m.isfile() or m.isdir() for m in members), 'Unsupported archive member type'",
  " assert len(regular)==len(expected), 'Unexpected regular-member count'",
  " assert len({m.name for m in regular})==len(regular), 'Duplicate archive paths'",
  " assert {m.name for m in regular}==set(expected), 'Complete regular-member set differs from external manifest'",
  " assert not any(part.startswith('._') for m in members for part in m.name.split('/')), 'AppleDouble member'",
  " for member in regular:",
  "  row=expected[member.name]; data=archive.extractfile(member).read()",
  "  assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256'], 'Member custody mismatch: '+member.name",
  "print(json.dumps({'status':'passed','regularMembers':len(regular),'exactExternalManifestSet':True,'allMemberBytesAndDigests':True,'appleDoubleMembers':0}))",
].join("\n"), archive, manifest]));
if (args[3]) {
  const previousFile = path.resolve(args[3]), previous = readJson(previousFile);
  assert.equal(digest(path.join(path.dirname(previousFile), previous.archive)).sha256, previous.sha256);
  const changed = [];
  const members = previous.files.map(row => {
    const current = digest(row.path);
    if (current.bytes !== row.bytes || current.sha256 !== row.sha256) {
      assert.equal(row.path, "scripts/package-native-smoke-capabilities.mjs", "Evidence/report or another owned member changed");
      changed.push(row.path);
    }
    return { path: row.path, ...current };
  });
  const archive = path.join(output, "native-smoke-capabilities-owned-v3.tar.gz");
  const manifestFile = path.join(output, "native-smoke-capabilities-owned-v3.manifest.json");
  const receiptFile = path.join(output, "native-smoke-capabilities-offline-replay.json");
  const validationFile = path.join(output, "native-smoke-capabilities-archive-validation.json");
  if ([archive, manifestFile, receiptFile, validationFile].some(existsSync)) throw new Error("Preserve existing handoff; choose a fresh output directory");
  const previousReceipt = path.join(path.dirname(previousFile), previous.replayReceipt.file);
  assert.deepEqual(digest(previousReceipt), { bytes: previous.replayReceipt.bytes, sha256: previous.replayReceipt.sha256 });
  copyFileSync(previousReceipt, receiptFile);
  run("tar", ["-czf", archive, ...members.map(row => row.path)]);
  const manifest = { ...previous, archive: path.basename(archive), ...digest(archive), files: members,
    repackaging: { predecessorArchiveSha256: previous.sha256, evidenceAndReportsByteIdentical: true, changedOwnedPaths: changed,
      creationEnvironment: { COPYFILE_DISABLE: "1" }, replayReceipt: "Original successful replay receipt preserved byte-for-byte; no reacquisition or report regeneration" } };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const validation = verifyArchive(archive, manifestFile);
  writeFileSync(validationFile, `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify({ archive, manifestFile, receiptFile, validationFile, archiveSha256: manifest.sha256,
    manifestSha256: digest(manifestFile).sha256, validation, preservedEvidenceAndReports: true }, null, 2));
  process.exit(0);
}
const filesIn = directory => readdirSync(directory).sort().flatMap(name => {
  const file = path.join(directory, name), stat = lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Unsafe handoff member");
  return stat.isDirectory() ? filesIn(file) : [file];
});
const evaluate = (cwd, invoke) => {
  const commands = [[process.execPath, ["--test", test]]];
  for (const workflow of workflows) {
    const module = `docs/operational-value/proof/functions/${workflow}.mjs`;
    commands.push([process.execPath, [`${skill}/verify-value-function.mjs`, "--collector", module]]);
    commands.push([process.execPath, [`${skill}/evaluate.mjs`, "--root", cwd, "--end", "2026-10-18T15:00:12Z",
      "--output-dir", `${proof}/reports`, "--function", module, "--no-runs", "--refresh", "github/gh-aw", workflow]]);
  }
  return commands.map(([command, commandArgs]) => ({ command: [path.basename(command), ...commandArgs],
    stdoutSha256: hash(invoke(command, commandArgs)), status: "passed" }));
};
evaluate(root, (command, commandArgs) => run(command, commandArgs));

const references = new Set();
const visit = value => {
  if (!value || typeof value !== "object") return;
  if (typeof value.file === "string" && /^originals\/[a-f0-9]{64}-\d+\.gz$/.test(value.file)) references.add(value.file);
  for (const child of Object.values(value)) visit(child);
};
for (const name of ["sources.json", "acquisition.json"]) visit(readJson(`${proof}/${name}`));
for (const name of readdirSync(`${proof}/originals`)) {
  if (!/^[a-f0-9]{64}-\d+\.gz$/.test(name)) throw new Error("Unknown original filename");
  if (!references.has(`originals/${name}`)) rmSync(`${proof}/originals/${name}`);
}

const facts = loadNative();
const assessment = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
  authoring: "Outcome-informed retrospective v2; original v1 expanded-date and full-goal predicates preserved",
  quantities: { retainedOriginalAttempts: facts.length, independentlyProvenCapabilityFacets: 5,
    expandedDateReadbackAttempts: 3, literalTemplateReadbackAttempts: 1, completedBuildAttempts: 1,
    nativeBuildFailures: 1, fullWorkflowAcceptance: null, costs: "not measured", keepDecision: "not rated" },
  workflows: workflows.map(workflow => {
    const selected = facts.filter(row => row.workflow === workflow);
    const timeline = readJson(`${proof}/reports/github-gh-aw/${workflow}-timeline.json`);
    const measured = timeline.snapshots.filter(snapshot => snapshot.metrics.capabilities !== null);
    const totals = Object.fromEntries(["capabilities", "expandedReadback", "literalReadback", "writeReadback", "build", "fullAcceptance"]
      .map(id => {
        const known = timeline.snapshots.map(row => row.metrics[id]).filter(value => value !== null);
        return [id, known.length ? known.reduce((sum, value) => sum + value, 0) : null];
      }));
    return { workflow, retainedAttempts: selected.length, nativePartialReady: totals.capabilities > 0,
      completedNativeEvaluation: totals.capabilities > 0,
      fullAcceptanceReady: false, allHistoryCovered: false, comparableTrendReady: false,
      standardCollector: "passed", standardRefresh: "passed", periods: timeline.snapshots.length,
      measuredPeriods: measured.length, totals, gaps: [...new Set(selected.map(row => row.gap).filter(Boolean))],
      rejections: selected.flatMap(row => row.rejections.map(reason => ({ runId: row.runId, attempt: row.attempt, reason }))) };
  }),
  facts,
  limitations: [
    "Only three native partial evaluations qualify; the Gemini, Kiro and Crush all-null instruments remain incomplete evidence gaps.",
    "Claude: two actual expanded-date file writes/readbacks. Cursor: one expanded-date write/readback plus an independently joined asynchronous native build.",
    "OpenCode: one literal source-template filesystem readback, not date expansion. Overlapping native write/read intervals do not establish the strict write-before-read join. Actual make build failed.",
    "Run/agent/job success, self-reported PASS, issue creation and artifact existence never count as delivered capability effects.",
    "No full original workflow acceptance, all-attempt coverage, current-runtime certification, sustained trend, cost denominator or keep bar is asserted.",
    "Issue/PR discovery was complete at acquisition; its bounded safe projection is retained. Replay does not repeat the full census. Discussions/comments cannot be inferred absent from that inventory.",
    "Parent's separately acquired Discussion inventory cannot establish native filesystem/tool bytes and is not used as substitute evidence.",
    "The sealed retrospective instrument is not deployed as a continuous collector. New acquisition or source profiles require reviewed custody and explicit contract identity.",
  ],
};
assert.equal(assessment.workflows.filter(row => row.completedNativeEvaluation).length, 3);
assert.equal(assessment.workflows.reduce((sum, row) => sum + (row.totals.capabilities ?? 0), 0), 5);
writeFileSync(`${proof}/assessment.json`, `${JSON.stringify(assessment, null, 2)}\n`);

const owned = [...filesIn(proof), ...workflows.map(workflow => `docs/operational-value/proof/functions/${workflow}.mjs`),
  "scripts/collect-native-smoke-capabilities.mjs", "scripts/native-smoke-capabilities.mjs",
  "scripts/package-native-smoke-capabilities.mjs", test].sort();
const members = owned.map(file => {
  assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."));
  const item = { path: file, ...digest(file) };
  assert.ok(item.bytes <= 256 * 1024, `Oversized handoff member: ${file}`);
  return item;
});
const dependencyPaths = [...filesIn(skill), "scripts/native-smoke-copilot-small.mjs", "scripts/collect-smoke-copilot-small.mjs",
  "scripts/native-smoke-pydantic.mjs", "scripts/collect-smoke-pydantic.mjs"];
const dependencies = dependencyPaths.sort().map(file => ({ path: file, ...digest(file) }));
const archive = path.join(output, "native-smoke-capabilities-owned-v2.tar.gz");
const manifestFile = path.join(output, "native-smoke-capabilities-owned-v2.manifest.json");
const receiptFile = path.join(output, "native-smoke-capabilities-offline-replay.json");
if ([archive, manifestFile, receiptFile].some(existsSync)) throw new Error("Preserve existing handoff; choose a fresh output directory");
run("tar", ["-czf", archive, ...owned]);
const fresh = mkdtempSync(path.join(output, "isolated-replay-"));
let replay;
try {
  run("tar", ["-xzf", archive, "-C", fresh]);
  for (const row of dependencies) {
    const target = path.join(fresh, row.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(row.path, target);
  }
  for (const row of [...members, ...dependencies]) assert.deepEqual(digest(path.join(fresh, row.path)), { bytes: row.bytes, sha256: row.sha256 });
  assert.ok(!existsSync(path.join(fresh, ".git")) && !existsSync(path.join(fresh, "node_modules")));
  const home = path.join(fresh, "empty-home");
  mkdirSync(home);
  const shared = "/Users/mnkiefer/.copilot/session-state/8c4bd83e-6e85-44bb-b6cd-5addf8a4ac38/files";
  const profile = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(shared)}) (regex #"/node_modules(/|$)") (regex #"/[.]git(/|$)"))`;
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache"),
    NODE_PATH: "", NODE_OPTIONS: "", GIT_NO_LAZY_FETCH: "1", GH_TOKEN: "", GITHUB_TOKEN: "" };
  const isolated = (command, commandArgs) => run("/usr/bin/sandbox-exec", ["-p", profile, command, ...commandArgs], fresh, env);
  isolated(process.execPath, ["-e", [
    "const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');",
    `for(const file of [${JSON.stringify(path.join(root, "package.json"))},${JSON.stringify(shared)}]) {let denied=false;try{fs.statSync(file)}catch(e){denied=e.code==='EPERM'||e.code==='EACCES'}assert.ok(denied,'Ambient evidence access must be denied')}`,
    "const s=net.createConnection({host:'1.1.1.1',port:443});s.on('error',e=>{assert.ok(['EPERM','EACCES'].includes(e.code),'OS must deny network');process.exit(0)});s.on('connect',()=>process.exit(2));setTimeout(()=>process.exit(3),3000);",
  ].join("\n")]);
  const commands = evaluate(fresh, isolated);
  for (const workflow of workflows) {
    const filename = `${proof}/reports/github-gh-aw/${workflow}-timeline.json`;
    const original = readJson(filename), actual = readJson(path.join(fresh, filename));
    const projection = timeline => ({ snapshots: timeline.snapshots.map(row =>
      ({ window: row.window, observedAt: row.observedAt, metrics: row.metrics, evidence: row.evidence, provenance: row.provenance })),
    review: timeline.valueReview, definition: timeline.valueFunction.definition });
    assert.deepEqual(projection(actual), projection(original));
  }
  for (const row of dependencies) assert.deepEqual(digest(path.join(fresh, row.path)), { bytes: row.bytes, sha256: row.sha256 });
  replay = { schemaVersion: 1, status: "passed", isolation: "macOS sandbox-exec: OS-denied network, original worktree, coordinator cache, .git and node_modules",
    cleanReplayContainsGit: false, cleanReplayContainsNodeModules: false, ambientAccessAndNetworkNegativeProbes: "passed",
    actualFocusedTests: "passed", actualCollectorChecks: 6, actualRefreshEvaluations: 6, identicalTimelineEvidenceMetricsAndDefinitions: true,
    commands, qualifiedNativeReports: 3, evidenceGapReports: 3 };
} finally { rmSync(fresh, { recursive: true, force: true }); }
writeFileSync(receiptFile, `${JSON.stringify(replay, null, 2)}\n`);
const manifest = { schemaVersion: 1, baseline: run("git", ["rev-parse", "HEAD"]).trim(),
  repository: "github/gh-aw", ownedOnly: true, archive: path.basename(archive), ...digest(archive),
  replayReceipt: { file: path.basename(receiptFile), ...digest(receiptFile) }, files: members, dependencies,
  qualifiedNativeReports: 3, evidenceGapReports: 3 };
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
verifyArchive(archive, manifestFile);
console.log(JSON.stringify({ archive, manifestFile, receiptFile, archiveSha256: manifest.sha256,
  manifestSha256: digest(manifestFile).sha256, ownedMembers: members.length, qualifiedNativeReports: 3, evidenceGapReports: 3 }, null, 2));
