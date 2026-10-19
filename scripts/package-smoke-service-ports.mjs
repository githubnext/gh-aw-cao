import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { collectBatch, definition, scoreMetric } from "../docs/operational-value/proof/functions/smoke-service-ports.mjs";
import { cutoff, hash } from "./native-smoke-service-ports.mjs";
import { replayInputs } from "./collect-smoke-service-ports.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proof = "docs/operational-value/proof/smoke-service-ports";
const moduleFile = "docs/operational-value/proof/functions/smoke-service-ports.mjs";
const ownedFiles = [
  moduleFile,
  "scripts/collect-smoke-service-ports.mjs",
  "scripts/native-smoke-service-ports.mjs",
  "scripts/package-smoke-service-ports.mjs",
  "tests/unit/operational-value-smoke-service-ports.test.mjs",
];
const write = (file, value) => writeJsonArchive(path.join(root, proof, file), value, { spacing: 2 });
const execute = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
  if (result.error) throw result.error;
  return { command, args, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr };
};
const requireSuccess = result => {
  if (result.status !== 0) throw new Error(JSON.stringify(result));
  return result;
};
function walk(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
}

export async function evaluateOffline() {
  const previous = path.join(root, proof, "frozen-cutoff-assessment.json");
  const predecessor = path.join(root, proof, "predecessor-frozen-cutoff-assessment.json");
  if (existsSync(previous) && !existsSync(predecessor)) writeFileSync(predecessor, readFileSync(previous));
  const verifier = execute(process.execPath, [
    ".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", moduleFile,
  ]);
  write("standard-collector.json", verifier);
  requireSuccess(verifier);
  const base = [".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", root,
    "--function", moduleFile, "--no-runs"];
  const frozen = execute(process.execPath, [...base, "--end", cutoff,
    "--output-dir", `${proof}/frozen-standard`, "github/gh-aw", "smoke-service-ports"]);
  const requests = [{
    windowStart: "2026-10-16T15:00:12Z", windowEnd: cutoff, observedAt: cutoff,
  }];
  const collections = await collectBatch(requests);
  write("frozen-standard-invocation.json", frozen);
  write("frozen-cutoff-assessment.json", {
    cutoff, definition, invocation: frozen, requests, collections,
    metrics: Object.fromEntries(definition.metrics.map(metric => [
      metric.id, scoreMetric(metric.id, collections[0].evidence),
    ])),
    interpretation: "The actual standard evaluator rejects a cutoff before the unchanged Oct19 contract activation. This separate retrospective observation admits independently corroborated Oct17 operations under the identical contemporaneous Markdown source; it does not backdate activation, infer adoption, establish complete history or replace that rejection.",
  });
  if (frozen.status === 0 || !frozen.stderr.includes("evaluation end must follow 2026-10-19T11:13:09Z")) {
    throw new Error("Unexpected frozen evaluator result");
  }
  const end = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const prospective = execute(process.execPath, [...base, "--end", end,
    "--output-dir", `${proof}/prospective`, "github/gh-aw", "smoke-service-ports"]);
  write("prospective-evaluator.json", prospective);
  requireSuccess(prospective);
  const tests = execute(process.execPath, ["--test", "tests/unit/operational-value-smoke-service-ports.test.mjs"]);
  write("focused-tests.json", tests);
  requireSuccess(tests);
  const linter = path.join(root, "node_modules/.bin/eslint");
  const lint = existsSync(linter) ? execute(linter, ownedFiles.filter(file => file.endsWith(".mjs")))
    : { command: "node_modules/.bin/eslint", status: 127,
      stderr: "Local eslint unavailable; no installation or registry request attempted." };
  write("lint-attempt.json", lint);
  // Avoid npm's implicit registry lookup for a missing compiler.
  const compiler = path.join(root, "node_modules/.bin/tsc");
  write("typecheck-attempt.json", existsSync(compiler)
    ? execute(compiler, ["--allowJs", "--checkJs", "false", "--noEmit", "--skipLibCheck",
      "--module", "NodeNext", "--target", "ES2022", moduleFile, ...ownedFiles.slice(1)])
    : { status: "unavailable", reason: "No local node_modules/.bin/tsc; installation and network are forbidden under this assignment." });
  const compile = { command: "gh aw compile --strict --no-emit --no-check-update --schedule-seed githubnext/gh-aw-cao",
    status: "deferred", reason: "Shared compilation is coordinator-owned; compiler has no offline flag and network is forbidden in this assignment. gh aw compile --help was inspected locally." };
  write("compile-attempt.json", compile);
  write("readiness.json", {
    schemaVersion: 1, workflow: definition.slug, cutoff,
    implementation: "Ready: schema-3 definition/collectBatch/scoreMetric recompute source-defined native protocol cases from custody-bound originals; interface tests alone are not admission.",
    producer: "Ready for bounded offline replay: verified original provider run, attempt jobs, protected host logs, provider-digest-bound agent ZIP and current/actual-head source blobs. No endpoint acquisition, fetched-code execution or live generic producer.",
    nativeEvidence: { status: "admitted-observed-lower-bound", acceptedCases: 3, fullHostBoundSessions: 1,
      runId: 38987730359, attempt: 1, jobId: 117263197566,
      completedAt: "2026-10-17T00:47:10.0140355Z",
      directCandidates: 17, forwardReverseClosure: 56,
      reason: "Exact protected step31 frames at host log lines2500/2504 corroborate raw PONG, successful SET followed by exact GET, and source-requested INFO prefix; protected startup/port-allowance/route/sandbox records establish the boundary." },
    fullFunction: "Native-admission-ready for retained source-bound observations, including the actual full integration session; not complete repository-period instrumentation or a complete opportunity census.",
    contribution: "Three observed native cases linked to the exact workflow run/head/attempt/job/client output; not a claim of sole causal authorship or campaign-wide benefit.",
    historical: "One legitimate retrospective Oct17 observation: actual-head source equals frozen Markdown acceptance. Unknown adoption, missing introduction/historical blobs and unassessed candidates still block complete historical/baseline readiness. New contract activation remains Oct19.",
    currentSource: "All four imports, full current compiled and actual-head compiled originals, and compiler service-port/checker sources preserved. Native admission uses executed request/response frames rather than health/telemetry/session success.",
    frozenStandard: { status: frozen.status, reason: frozen.stderr.trim(), actualAssessment: "frozen-cutoff-assessment.json" },
    prospective: { end, status: prospective.status, nativeScores: null,
      meaning: "No authenticated events after activation in the retained inputs; pre-activation event is reported separately, not moved into a new period.",
      reports: "prospective/github-gh-aw/" },
    costs: "Not measured", keep: "Not rated: no source-grounded keep bar.",
    validation: { focusedTests: tests.status, collector: verifier.status, lint: lint.status, compile: compile.status },
    unresolvedEndpointScope: {
      forAdmittedRun: [],
      historicalSourceBlobs: [...new Set(readJsonArchive(path.join(root, proof, "sources.json.gz")).missing.map(row => row.blob))],
      remainingDiscoveryRunMetadata: readJsonArchive(path.join(root, proof, "discovery.json.gz")).closure.entities
        .filter(row => row.workflowReference?.workflowId === definition.slug)
        .map(row => `repos/github/gh-aw/actions/runs/${row.workflowReference.runId}`),
      limitation: "These historical metadata/source gaps are not authority to acquire anything. Attempt/job/artifact endpoints for those other candidates cannot be specified until their original identities are established. No additional endpoint is needed to prove the admitted Oct17 session.",
    },
  });
  write("skill-improvement.json", {
    proposedInsertion: "Freeze a per-claim acceptance matrix before reading outcomes. For service tests, corroborate raw typed client request/result frames against an independently acquired, attempt-bound protected job log, source head, execution step/time, provider-digested original artifact and upload receipt; never accept assistant prose or digest-shaped flags. Admit independently evidenced protocol cases even when compiled boundary/other safeguards are missing, leaving those claims null. Preserve the source's actual output projection (e.g. INFO | head -5), not invented complete responses or restart durability. Deduplicate each service-lifetime/case before assigning disjoint event cohorts. Retrospective same-source operations can be useful without backdating new contract activation or guessing adoption.",
    implementationEvidence: ["scripts/native-smoke-service-ports.mjs", moduleFile,
      "tests/unit/operational-value-smoke-service-ports.test.mjs"],
    scope: "Reusable skill improvement for coordinator integration; shared seed and portfolio unchanged.",
  });
  return { frozen: frozen.status, prospective: prospective.status, tests: tests.status, end };
}

export function packageOwned(destination) {
  mkdirSync(destination, { recursive: true });
  const files = [...ownedFiles, ...walk(proof)].sort();
  for (const file of files) {
    if (readFileSync(path.join(root, file)).length > 256 * 1024) throw new Error(`Over-budget package member ${file}`);
  }
  const archive = path.join(destination, "smoke-service-ports-owned.tar.gz");
  requireSuccess(execute("tar", ["-czf", archive, ...files]));
  const manifest = {
    schemaVersion: 1, workflow: definition.slug,
    baselineCommit: "37c9f53cb2bd99c35f5954820ea185a2eb4b6eac",
    seed: { name: "workflow-value-native-wave-seed-v019.tar.gz",
      sha256: "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835",
      manifestSha256: "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd" },
    archive: path.basename(archive), archiveSha256: hash(readFileSync(archive)),
    files: files.map(file => ({ path: file, bytes: readFileSync(path.join(root, file)).length,
      sha256: hash(readFileSync(path.join(root, file))) })),
    readiness: readJsonArchive(path.join(root, proof, "readiness.json")),
  };
  const manifestFile = path.join(destination, "smoke-service-ports-owned.manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archive, archiveSha256: manifest.archiveSha256,
    manifest: manifestFile, manifestSha256: hash(readFileSync(manifestFile)), files: files.length };
}

export function freshReplay(destination, seedDirectory) {
  const manifestFile = path.join(destination, "smoke-service-ports-owned.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile));
  const archive = path.join(destination, manifest.archive);
  if (hash(readFileSync(archive)) !== manifest.archiveSha256) throw new Error("Owned archive changed");
  const seed = path.join(seedDirectory, manifest.seed.name);
  const seedManifestFile = path.join(seedDirectory, "workflow-value-native-wave-seed-v019.manifest.json");
  if (hash(readFileSync(seed)) !== manifest.seed.sha256
    || hash(readFileSync(seedManifestFile)) !== manifest.seed.manifestSha256) throw new Error("Replay seed identity mismatch");
  const temporary = mkdtempSync(path.join(root, ".smoke-service-ports-replay-"));
  try {
    const baseline = path.join(temporary, "baseline.tar");
    requireSuccess(execute("git", ["archive", "--format=tar", "--output", baseline, manifest.baselineCommit]));
    requireSuccess(execute("tar", ["-xf", baseline, "-C", temporary]));
    requireSuccess(execute("tar", ["-xzf", seed, "-C", temporary]));
    const seedManifest = JSON.parse(readFileSync(seedManifestFile));
    for (const row of seedManifest.files) {
      const bytes = readFileSync(path.join(temporary, row.path));
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error("Extracted seed member changed");
    }
    requireSuccess(execute("tar", ["-xzf", archive, "-C", temporary]));
    for (const row of manifest.files) {
      const bytes = readFileSync(path.join(temporary, row.path));
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error("Fresh owned member changed");
    }
    const results = [
      execute(process.execPath, ["scripts/collect-smoke-service-ports.mjs", "--replay"], temporary),
      execute(process.execPath, ["--test", "tests/unit/operational-value-smoke-service-ports.test.mjs"], temporary),
      execute(process.execPath, [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", moduleFile], temporary),
      execute(process.execPath, [".github/skills/add-operational-value/scripts/evaluate.mjs",
        "--root", temporary, "--function", moduleFile, "--no-runs", "--end", cutoff,
        "--output-dir", ".frozen", "github/gh-aw", "smoke-service-ports"], temporary),
      execute(process.execPath, [".github/skills/add-operational-value/scripts/evaluate.mjs",
        "--root", temporary, "--function", moduleFile, "--no-runs",
        "--end", manifest.readiness.prospective.end,
        "--output-dir", ".prospective", "github/gh-aw", "smoke-service-ports"], temporary),
    ];
    results.slice(0, 3).forEach(requireSuccess);
    requireSuccess(results[4]);
    if (results[3].status !== 1 || !results[3].stderr.includes("evaluation end must follow")) {
      throw new Error("Fresh frozen rejection not reproduced");
    }
    const result = { archiveSha256: manifest.archiveSha256,
      manifestSha256: hash(readFileSync(manifestFile)), extractedMembers: manifest.files.length,
      seedMembers: seedManifest.files.length, sharedHistoryOrGitCacheUsed: false, results };
    writeFileSync(path.join(destination, "smoke-service-ports-fresh-replay.json"), `${JSON.stringify(result, null, 2)}\n`);
    return { statuses: results.map(result => result.status), sharedHistoryOrGitCacheUsed: false };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination, seedDirectory] = process.argv.slice(2);
  if (command === "--evaluate") console.log(JSON.stringify(await evaluateOffline()));
  else if (command === "--package" && destination) console.log(JSON.stringify(packageOwned(destination)));
  else if (command === "--fresh-replay" && destination && seedDirectory) console.log(JSON.stringify(freshReplay(destination, seedDirectory)));
  else if (command === "--replay") console.log(JSON.stringify(replayInputs()));
  else throw new Error("Use --evaluate, --package DESTINATION, --fresh-replay DESTINATION SEED_DIRECTORY, or --replay");
}
