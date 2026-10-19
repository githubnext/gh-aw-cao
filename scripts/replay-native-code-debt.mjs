import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base, cutoff, read, verifyLock } from "../docs/operational-value/proof/native-code-debt/custody.mjs";
import { evaluateNative } from "../docs/operational-value/proof/native-code-debt/model.mjs";
import { sha256 } from "../docs/operational-value/proof/native-code-debt/native.mjs";

export function withoutGeneratedAt(value) {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "generatedAt").map(([key, item]) => [key, withoutGeneratedAt(item)]));
  return value;
}
function run(args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
export async function replay({ evaluate = true } = {}) {
  const dir = "docs/operational-value/proof/native-code-debt";
  const lockSha256 = sha256(readFileSync(`${dir}/instrument-lock.json`));
  const lock = verifyLock(lockSha256), native = evaluateNative();
  const quantities = {};
  for (const slug of ["daily-code-debt-aider", "code-simplifier"]) {
    const modulePath = `docs/operational-value/proof/functions/${slug}.mjs`;
    const module = await import(`../${modulePath}`);
    const collectorCheck = run([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", modulePath]).trim();
    const report = `${dir}/reports/github-gh-aw/${slug}-timeline.json`;
    let first;
    if (existsSync(report)) first = read(report);
    if (evaluate) {
      run([".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", process.cwd(), "--end", cutoff,
        "--output-dir", `${dir}/reports`, "--function", modulePath, "--refresh", "github/gh-aw", slug]);
      const second = read(report);
      if (first) assert.deepEqual(withoutGeneratedAt(second), withoutGeneratedAt(first), "Whole standard timeline changed, not just generatedAt");
      first = second;
    }
    assert.ok(first, "Standard report must exist");
    const known = first.snapshots.map(row => module.scoreMetric("native-partial", row.evidence)).filter(value => value !== null);
    for (let i = 1; i < first.snapshots.length; i++) assert.equal(first.snapshots[i - 1].window.endAt, first.snapshots[i].window.startAt);
    assert.equal(first.snapshots[0].window.startAt, module.definition.adoption.adoptedAt);
    assert.equal(first.snapshots.at(-1).window.endAt, cutoff);
    const rows = native.rows.filter(row => row.slug === slug);
    const positive = rows.filter(row => row.value > 0);
    const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    assert.equal(total, positive.length ? positive.reduce((sum, row) => sum + row.value, 0) : null);
    quantities[slug] = { status: positive.length ? "finite-useful-structural-partial" : "blocked-no-accepted-native-outcome",
      qualifiedWorkflow: positive.length > 0, unit: module.definition.metrics[0].unit, nativeUnits: total,
      selectedImplementations: rows.length, acceptedImplementations: positive.map(row => ({ number: row.number, commit: row.commit, parent: row.parent,
        at: row.mergedAt, value: row.value, corroborated: row.corroborated, receiptBackedAttribution: null })),
      weeklyPeriods: first.snapshots.length, knownWeeklyPeriods: known.length,
      timelineSha256ExceptGeneratedAt: sha256(JSON.stringify(withoutGeneratedAt(first))), collectorCheck,
      fullGoalAcceptance: null, behaviorPreservation: null, wholePopulationValue: null, costs: null, keepDecision: "not rated" };
  }
  return { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
    frozenSource: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff, instrumentSha256: lockSha256,
    finiteUsefulMeasuredWorkflowCount: Object.values(quantities).filter(row => row.qualifiedWorkflow).length,
    quantities, nativeResult: native.result, nativeUniverse: native.nativeUniverse, historicalEligibility: native.eligibility,
    actualAdoptions: native.adoptions, rejected: native.rejected,
    acquisition: { originalInventoryPartitions: 346, originalInventoryEntities: 58048,
      scope: "Only the selected 209 workflow-linked candidate identities and exact bounded public graph responses are transferred; shared full inventory is not owned.",
      discoveryCandidates: { "daily-code-debt-aider": 71, "code-simplifier": 138 }, markerIsCreationReceipt: false },
    unchangedBaselineDependencies: lock.unchangedBaselineDependencies,
    oracleCustody: { goToolchainManifestSha256: sha256(readFileSync(new URL("toolchain.json", base))),
      oracleSha256: sha256(readFileSync(new URL("oracle.go", base))), nodeAndGoBinariesPinned: true, targetSourceExecuted: false },
    limitations: "One narrow outcome-informed structural maintenance-surface consolidation. Changed constructors and logging prevent full behavior-equivalence claims. Aider remains an unfinished measurement attempt, not zero workflow value. Historical full executor continuity, candidate-list receipts, complete safeguards, causal attribution, costs and a keep bar remain unknown." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await replay({ evaluate: !process.argv.includes("--no-evaluate") });
  if (process.argv.includes("--write")) writeFileSync(new URL("assessment.json", base), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
