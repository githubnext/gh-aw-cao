import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { base, cutoff, slugs, hash, json } from "./native-monitoring-accuracy.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const proof = "docs/operational-value/proof/native-monitoring-accuracy";
const ownedScripts = ["native-monitoring-accuracy.mjs", "native-monitoring-value.mjs",
  "collect-native-monitoring-accuracy.mjs", "author-native-monitoring-functions.mjs",
  "replay-native-monitoring-value.mjs", "native-monitoring-offline-guard.mjs"].map(name => `scripts/${name}`);
const testFile = "tests/unit/native-monitoring-accuracy.test.mjs";

function filesBelow(directory) {
  return readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not accepted in the owned handoff");
    return stat.isDirectory() ? filesBelow(file) : [file];
  });
}

function runStandard(root, guard = false) {
  const environment = guard ? { ...process.env, PATH: "/nonexistent", GH_TOKEN: "", GITHUB_TOKEN: "",
    NATIVE_MONITORING_REPLAY_ROOT: root,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, "scripts/native-monitoring-offline-guard.mjs")).href}` } : process.env;
  const skill = path.join(root, ".github/skills/add-operational-value/scripts");
  const run = args => execFileSync(process.execPath, args, { cwd: root, env: environment, maxBuffer: 16 * 1024 * 1024 }).toString();
  if (guard) run(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { request } from "node:https";
    import { connect } from "node:net";
    const blocked = /Offline native replay prohibits/;
    assert.throws(() => execFileSync("git", ["status"]), blocked);
    assert.throws(() => execFileSync("/usr/bin/true"), blocked);
    assert.throws(() => fetch("https://api.github.com/repos/github/gh-aw"), blocked);
    assert.throws(() => request("https://api.github.com/repos/github/gh-aw"), blocked);
    assert.throws(() => connect(443, "api.github.com"), blocked);
  `]);
  const results = [];
  for (const slug of slugs) {
    const module = `docs/operational-value/proof/functions/${slug}.mjs`;
    run([path.join(skill, "verify-value-function.mjs"), "--collector", module]);
    run([path.join(skill, "evaluate.mjs"), "--root", root, "--end", cutoff,
      "--output-dir", `${proof}/reports`, "--function", module, "--refresh", "github/gh-aw", slug]);
    const contract = json(path.join(root, proof, "contracts.json")).records.find(row => row.slug === slug);
    const timeline = json(path.join(root, proof, "reports/github-gh-aw", `${slug}-timeline.json`));
    const measured = timeline.snapshots.filter(snapshot => snapshot.evidence?.valid === true);
    if (measured.length !== 1 || measured[0].evidence.assessed <= 0) {
      throw new Error(`Standard report is not a real single-sample native evaluation: ${slug}`);
    }
    const evidence = measured[0].evidence;
    results.push({ slug, eligible: evidence.eligible, assessed: evidence.assessed, accepted: evidence.accepted,
      accuracyPercent: 100 * evidence.accepted / evidence.assessed,
      coveragePercent: 100 * evidence.assessed / evidence.eligible,
      observedPeriods: measured.length, unmeasuredPeriods: timeline.snapshots.length - measured.length,
      openingUndercountFloor: evidence.openingUndercountFloor, fullAcceptance: null, contribution: null,
      costs: "not measured", nativeDetail: evidence.detail,
      nativeEvidenceSha256: hash(JSON.stringify(measured[0].evidence)),
      snapshotsSha256: hash(JSON.stringify(timeline.snapshots)),
      nativeLabel: contract.nativeLabel, limitations: contract.limitations });
  }
  return results;
}

export function replayAndPackage(destination) {
  const root = process.cwd(), output = path.resolve(destination);
  mkdirSync(output, { recursive: true });
  const sourceResults = runStandard(root);
  const summaryFile = path.join(base, "summary.json");
  writeFileSync(summaryFile, `${JSON.stringify({ schemaVersion: 1, cutoff,
    interpretation: "Six non-null independently evaluated bounded native facets, one selected surviving report per workflow. Not six complete lifetime goals; not 344 completed reports. All unassessed periods remain unknown. Original full-goal census proposals are unchanged.",
    bodySemantics: "Retrospective assessment of surviving bodies observed after cutoff, allocated to report-creation cohorts. Original publication-time/cutoff bodies and their factual accuracy remain unknown; no historical body revision is reconstructed.",
    results: sourceResults }, null, 2)}\n`);
  const members = [...ownedScripts, testFile, ...slugs.map(slug => `docs/operational-value/proof/functions/${slug}.mjs`),
    ...filesBelow(proof)].sort();
  if (new Set(members).size !== members.length) throw new Error("Duplicate handoff path");
  for (const file of members) {
    if (file.split("/").some(part => part === "..") || !/^[a-zA-Z0-9_./-]+$/.test(file)
      || lstatSync(file).size > 256 * 1024) throw new Error(`Unsafe or oversized handoff member: ${file}`);
  }
  const archive = path.join(output, "native-monitoring-accuracy-owned.tar.gz");
  const memberList = path.join(output, "native-monitoring-accuracy-members.txt");
  writeFileSync(memberList, `${members.join("\n")}\n`);
  execFileSync("tar", ["-czf", archive, "-T", memberList],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 1024 * 1024 });
  const listed = execFileSync("tar", ["-tzf", archive]).toString().trim().split("\n").sort();
  assert.deepEqual(listed, members, "Tar member set must equal the owned paths, without AppleDouble metadata");
  unlinkSync(memberList);
  const clean = mkdtempSync(path.join(output, "native-monitoring-clean-replay-"));
  execFileSync("tar", ["-xzf", archive, "-C", clean], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  for (const file of members) assert.equal(hash(readFileSync(path.join(clean, file))), hash(readFileSync(file)),
    `Extracted archive member must match its source digest: ${file}`);
  cpSync(".github/skills/add-operational-value", path.join(clean, ".github/skills/add-operational-value"),
    { recursive: true, filter: source => !source.split(path.sep).includes("node_modules") });
  if (existsSync(path.join(clean, ".git")) || existsSync(path.join(clean, "node_modules"))) {
    throw new Error("Clean replay unexpectedly contains Git or installed packages");
  }
  const cleanResults = runStandard(clean, true);
  assert.deepEqual(cleanResults, sourceResults, "Clean offline replay must reproduce every fact and timeline snapshot");
  const manifest = { schemaVersion: 1, archive: path.basename(archive), archiveSha256: hash(readFileSync(archive)),
    bodySemantics: "Observed surviving bodies, not original historical report revisions. Period placement is by original object creation cohort, not proof these body bytes existed then.",
    cutoff, exactMemberCount: members.length, members: members.map(file => ({ path: file,
      bytes: lstatSync(file).size, sha256: hash(readFileSync(file)) })),
    replay: { directory: clean, noGit: true, noNodeModules: true, noNetwork: true,
      noTargetExecution: true, allowedNativeHostTool: "/usr/bin/shasum -a 256 on replay-contained files, required by the unchanged standard skill",
      guardProbeVerified: true,
      standardCollectorVerification: 6, standardRefreshEvaluations: 6,
      exactNativeAndSnapshotEquality: true },
    sharedDependencies: "Portable .github/skills/add-operational-value at pinned compiler-lock hashes; supplied by the receiving repository, deliberately excluded from this owned-only archive.",
    results: sourceResults.map(({ nativeDetail, ...row }) => row) };
  const manifestFile = path.join(output, "native-monitoring-accuracy-handoff.json");
  const manifestParts = writeJsonArchive(manifestFile, manifest);
  return { archive, manifest: manifestFile, manifestParts, ownedFiles: members.length, cleanReplay: clean,
    results: manifest.results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: replay-native-monitoring-value.mjs SESSION_ARTIFACT_DIRECTORY");
  console.log(JSON.stringify(replayAndPackage(process.argv[2]), null, 2));
}
