import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBatch, definition, scoreMetric } from "../../functions/smoke-service-ports.mjs";
import { hash } from "../../../../../scripts/native-smoke-service-ports.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const relative = "docs/operational-value/proof/smoke-service-ports/retrospective-cutoff";
const proof = path.dirname(relative);
const moduleFile = "docs/operational-value/proof/functions/smoke-service-ports.mjs";
const shared = ".github/skills/add-operational-value/scripts";
const baseArchiveSha256 = "dfd7a6768f2a3bf372cb0dc9b9bc44aa1fccd21a0f7ec0b2bf11084dc9acafc9";
const baseManifestSha256 = "dc0dc01c89af454568696368aad2d49a6e0b48117ef0d7594a1acfc71098b492";
const interpretation = "Source-matched retrospective reconstruction, not ex-ante historical acceptance or an adoption comparison. "
  + "The frozen standard evaluator rejected this cutoff before unchanged contract activation; this report does not claim standard evaluator success. "
  + "The known source-defined observed subtotal is 3 Redis cases, 1 full host-bound session and 3 receipt-linked contributions. "
  + "Population coverage remains partial; missing cohorts stay null, comparisons are unavailable, and there is no complete trend or agreed keep bar. "
  + "Costs remain unmeasured. Evidence was acquired retrospectively; observedAt is the preserved cutoff assessment coordinate, not an acquisition or acceptance date.";
const read = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const write = (name, value) => writeFileSync(path.join(root, relative, name), `${JSON.stringify(value, null, 2)}\n`);
const sha = file => hash(readFileSync(path.join(root, file)));
const execute = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(JSON.stringify({ args, ...result }));
  return { command: "node", args, status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const shell = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(JSON.stringify({ command, args, ...result }));
  return result;
};
const files = () => readdirSync(path.join(root, relative)).sort().map(name => `${relative}/${name}`);
const fingerprints = () => files().filter(file => !file.endsWith("/replay-receipt.json"))
  .map(file => ({ path: file, bytes: readFileSync(path.join(root, file)).length, sha256: sha(file) }));
const baseMembers = () => {
  const original = read(`${proof}/frozen-cutoff-assessment.json`);
  return {
    module: sha(moduleFile),
    contract: sha(`${proof}/contract.json`),
    cutoffSnapshot: sha(`${proof}/frozen-cutoff-assessment.json`),
    rejection: sha(`${proof}/frozen-standard-invocation.json`),
    predecessor: sha(`${proof}/predecessor-frozen-cutoff-assessment.json`),
    originalStatus: original.invocation.status,
    adoption: definition.adoption,
  };
};

export async function build() {
  const before = baseMembers();
  const frozen = read(`${proof}/frozen-cutoff-assessment.json`);
  assert.equal(frozen.invocation.status, 1);
  assert.match(frozen.invocation.stderr, /evaluation end must follow 2026-10-19T11:13:09Z/);
  assert.deepEqual(definition, frozen.definition);
  assert.equal(frozen.requests.length, 1);
  const current = frozen.requests[0];
  const start = new Date(Date.parse(current.windowStart) - 2 * 86_400_000).toISOString().replace(".000Z", "Z");
  const requests = [
    { observedAt: current.observedAt, windowStart: start, windowEnd: current.windowStart },
    { observedAt: current.observedAt, windowStart: current.windowStart, windowEnd: current.windowEnd },
  ];
  for (const request of requests) {
    assert.deepEqual(Object.keys(request), ["observedAt", "windowStart", "windowEnd"]);
  }
  assert.deepEqual(requests[1], current);
  const collections = await collectBatch(requests);
  assert.deepEqual(collections[1], frozen.collections[0]);
  assert.equal(collections[0].evidence.coverageStatus, "missing");
  assert.equal(collections[1].evidence.coverageStatus, "partial");
  const expected = { "verified-redis-cases": 3, "host-bound-sessions": 1, "workflow-contribution": 3 };
  assert.deepEqual(Object.fromEntries(definition.metrics.map(metric =>
    [metric.id, scoreMetric(metric.id, collections[1].evidence)])), expected);
  assert.ok(definition.metrics.every(metric => scoreMetric(metric.id, collections[0].evidence) === null));
  const observationsFile = `${relative}/observations.json`;
  const generatedAt = existsSync(path.join(root, observationsFile))
    ? read(observationsFile).generatedAt : new Date().toISOString();
  write("observations.json", {
    schemaVersion: 3, repository: definition.repository, workflowName: definition.workflowName,
    generatedAt, evaluationMode: "attainment-only",
    reportKind: "same-source-retrospective-cutoff-reconstruction", interpretation,
    collectionRequests: requests,
    window: { startAt: start, endAt: current.windowEnd },
    evidenceCoverage: {
      completeFromAdoption: false, hasPreAdoptionBaseline: false,
      baselineDescription: "No adoption comparison; missing prior cohort and partial current population.",
      reason: interpretation,
    },
    runs: [],
    caveat: interpretation,
    snapshots: collections.map((collection, index) => ({
      observedAt: requests[index].observedAt,
      window: { startAt: requests[index].windowStart, endAt: requests[index].windowEnd },
      ...collection,
    })),
  });
  const commands = [
    execute([`${shared}/verify-value-function.mjs`, "--collector", moduleFile]),
    execute([`${shared}/build-timeline.mjs`, moduleFile, observationsFile, `${relative}/timeline.json`]),
    execute([`${shared}/render-pulse.mjs`, `${relative}/timeline.json`, `${relative}/production-pulse.html`]),
  ];
  const timeline = read(`${relative}/timeline.json`);
  const pulse = read(`${relative}/production-pulse.json`);
  assert.deepEqual(timeline.valueFunction.definition, definition);
  assert.deepEqual(timeline.snapshots[1].evidence, frozen.collections[0].evidence);
  assert.deepEqual(timeline.snapshots[1].provenance, frozen.collections[0].provenance);
  assert.deepEqual(timeline.snapshots[1].metrics, expected);
  assert.ok(Object.values(timeline.snapshots[0].metrics).every(value => value === null));
  for (const metric of timeline.metricReview.metrics) {
    assert.equal(metric.recentComparison.status, "unavailable");
    assert.equal(metric.recentComparison.nativeDelta, null);
    assert.equal(metric.adoptionComparison.status, "unavailable");
    assert.equal(metric.adoptionComparison.nativeDelta, null);
  }
  assert.equal(pulse.decision.status, "not-rated");
  assert.equal(pulse.cost.status, "not-measured");
  for (const metric of pulse.metrics) {
    assert.equal(metric.signal.current, expected[metric.id]);
    assert.equal(metric.signal.previous, null);
    assert.equal(metric.signal.directionAwareGain, null);
    assert.equal(metric.signal.status, "insufficient-evidence");
    assert.deepEqual(metric.series.map(point => point.value), [null, expected[metric.id]]);
  }
  const rendered = readFileSync(path.join(root, relative, "production-pulse.html"), "utf8");
  const notice = `<aside role="note" aria-label="Retrospective reconstruction" style="padding:1rem;border:2px solid currentColor;margin:1rem">`
    + `<strong>Same-source retrospective cutoff reconstruction</strong><p>${interpretation}</p>`
    + `<p>The unmodified production pulse is below. Its numeric values are observed subtotals, not complete-population totals.</p></aside>`;
  assert.equal(rendered.split("<body>").length, 2);
  writeFileSync(path.join(root, relative, "retrospective-pulse.html"), rendered.replace("<body>", `<body>${notice}`));
  write("retrospective-pulse.json", {
    ...pulse,
    reportKind: "same-source-retrospective-cutoff-reconstruction",
    interpretation,
    preservedStandardEvaluatorRejection: { path: `${proof}/frozen-standard-invocation.json`, sha256: before.rejection },
  });
  write("interpretation.json", {
    schemaVersion: 1, reportKind: "same-source-retrospective-cutoff-reconstruction", interpretation,
    generatedAt, cutoff: current.windowEnd, standardEvaluator: { status: "rejected", exitCode: frozen.invocation.status,
      preservedOriginal: `${proof}/frozen-standard-invocation.json` },
    nativeObservedSubtotal: expected, completePopulation: false, exAnteAcceptance: false,
    adoptionComparison: false, completeTrend: false, keepDecision: "not-rated", costs: "not-measured",
    sourceSnapshot: { path: `${proof}/frozen-cutoff-assessment.json`, sha256: before.cutoffSnapshot },
    requestShape: ["observedAt", "windowStart", "windowEnd"],
    productionTimeline: `${relative}/timeline.json`, productionPulseModel: `${relative}/production-pulse.json`,
    productionPulseHtml: `${relative}/production-pulse.html`, labeledPulseHtml: `${relative}/retrospective-pulse.html`,
    labeledPulseJson: `${relative}/retrospective-pulse.json`,
    presentationOnly: "The labeled HTML adds only a static interpretation notice to a separate copy of the production renderer output. The labeled JSON adds report-classification metadata only. The production model, HTML, definition, evidence and provenance are retained unchanged.",
    preservation: before,
  });
  assert.deepEqual(baseMembers(), before);
  write("replay-receipt.json", {
    schemaVersion: 1, generatedAt, interpretation, commands,
    sourceSnapshotEvidenceIdentical: true, sourceSnapshotProvenanceIdentical: true,
    originalFrozenFilesUnchanged: true, replacements: [],
    metrics: expected, missingPriorCohort: null,
    recentComparisons: "unavailable", adoptionComparisons: "unavailable",
    preserved: before, artifacts: fingerprints(),
  });
  return { metrics: expected, replacements: [], standardEvaluator: "rejected-preserved", commands: commands.map(row => row.status) };
}

function verifyOriginalPackage(destination) {
  const manifestFile = path.join(destination, "smoke-service-ports-owned.manifest.json");
  const archive = path.join(destination, "smoke-service-ports-owned.tar.gz");
  assert.equal(hash(readFileSync(manifestFile)), baseManifestSha256);
  assert.equal(hash(readFileSync(archive)), baseArchiveSha256);
  const manifest = JSON.parse(readFileSync(manifestFile));
  assert.equal(manifest.files.length, 96);
  for (const member of manifest.files) {
    const bytes = readFileSync(path.join(root, member.path));
    assert.equal(bytes.length, member.bytes, member.path);
    assert.equal(hash(bytes), member.sha256, member.path);
  }
  return manifest;
}

export function packageDelta(destination) {
  const original = verifyOriginalPackage(destination);
  const members = files().map(file => {
    assert.ok(!original.files.some(row => row.path === file));
    const bytes = readFileSync(path.join(root, file));
    assert.ok(bytes.length <= 256 * 1024);
    return { path: file, bytes: bytes.length, sha256: hash(bytes) };
  });
  const archive = path.join(destination, "smoke-service-ports-retrospective-delta.tar.gz");
  shell("tar", ["-czf", archive, ...members.map(row => row.path)]);
  const manifest = {
    schemaVersion: 1, kind: "additive-owned-retrospective-report-delta",
    interpretation, originalArchiveSha256: baseArchiveSha256, originalManifestSha256: baseManifestSha256,
    archive: path.basename(archive), archiveSha256: hash(readFileSync(archive)),
    baselineCommit: original.baselineCommit, seed: original.seed,
    replacements: [], files: members,
  };
  const manifestFile = path.join(destination, "smoke-service-ports-retrospective-delta.manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archive, archiveSha256: manifest.archiveSha256,
    manifest: manifestFile, manifestSha256: hash(readFileSync(manifestFile)), files: members.length, replacements: [] };
}

export function freshReplay(destination, seedDirectory) {
  const original = verifyOriginalPackage(destination);
  const manifestFile = path.join(destination, "smoke-service-ports-retrospective-delta.manifest.json");
  const delta = JSON.parse(readFileSync(manifestFile));
  const archive = path.join(destination, delta.archive);
  assert.equal(hash(readFileSync(archive)), delta.archiveSha256);
  const seed = path.join(seedDirectory, original.seed.name);
  const seedManifest = path.join(seedDirectory, "workflow-value-native-wave-seed-v019.manifest.json");
  assert.equal(hash(readFileSync(seed)), original.seed.sha256);
  assert.equal(hash(readFileSync(seedManifest)), original.seed.manifestSha256);
  const temporary = mkdtempSync(path.join(root, ".smoke-service-ports-retrospective-"));
  try {
    const baseline = path.join(temporary, "baseline.tar");
    shell("git", ["archive", "--format=tar", "--output", baseline, original.baselineCommit]);
    shell("tar", ["-xf", baseline, "-C", temporary]);
    shell("tar", ["-xzf", seed, "-C", temporary]);
    for (const member of JSON.parse(readFileSync(seedManifest)).files) {
      const bytes = readFileSync(path.join(temporary, member.path));
      assert.equal(hash(bytes), member.sha256);
      assert.equal(bytes.length, member.bytes);
    }
    shell("tar", ["-xzf", path.join(destination, "smoke-service-ports-owned.tar.gz"), "-C", temporary]);
    for (const member of delta.files) assert.ok(!existsSync(path.join(temporary, member.path)), member.path);
    shell("tar", ["-xzf", archive, "-C", temporary]);
    const verifyMembers = members => {
      for (const member of members) {
        const bytes = readFileSync(path.join(temporary, member.path));
        assert.equal(hash(bytes), member.sha256, member.path);
        assert.equal(bytes.length, member.bytes, member.path);
      }
    };
    verifyMembers(original.files);
    verifyMembers(delta.files);
    const commands = [
      execute([`${relative}/replay.mjs`, "--build"], temporary),
      execute(["scripts/collect-smoke-service-ports.mjs", "--replay"], temporary),
      execute(["--test", "tests/unit/operational-value-smoke-service-ports.test.mjs"], temporary),
    ];
    verifyMembers(original.files);
    verifyMembers(delta.files);
    verifyOriginalPackage(destination);
    const receipt = {
      schemaVersion: 1, originalArchiveSha256: baseArchiveSha256, originalManifestSha256: baseManifestSha256,
      deltaArchiveSha256: delta.archiveSha256, deltaManifestSha256: hash(readFileSync(manifestFile)),
      originalMembersUnchanged: original.files.length, additiveMembersReproduced: delta.files.length,
      sharedHistoryOrGitCacheUsed: false, replacements: [], commands,
    };
    const receiptFile = path.join(destination, "smoke-service-ports-retrospective-fresh-replay.json");
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    return { receipt: receiptFile, receiptSha256: hash(readFileSync(receiptFile)),
      statuses: commands.map(row => row.status), originalMembersUnchanged: 96, replacements: [] };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination, seedDirectory] = process.argv.slice(2);
  if (command === "--build") console.log(JSON.stringify(await build()));
  else if (command === "--package" && destination) console.log(JSON.stringify(packageDelta(destination)));
  else if (command === "--fresh-replay" && destination && seedDirectory) console.log(JSON.stringify(freshReplay(destination, seedDirectory)));
  else throw new Error("Use --build, --package ORIGINAL_PACKAGE_DIRECTORY, or --fresh-replay ORIGINAL_PACKAGE_DIRECTORY SEED_DIRECTORY");
}
