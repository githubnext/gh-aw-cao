import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpus } from "../tests/fixtures/operational-value-benchmark/corpus.mjs";
import { activation, firstEnd, referenceModule, secondEnd } from "../tests/fixtures/operational-value-benchmark/reference.mjs";

const root = path.resolve(import.meta.dirname, "..");
const skill = ".github/skills/add-operational-value";
const scripts = path.join(root, skill, "scripts");
const referencePath = "tests/fixtures/operational-value-benchmark/reference.mjs";
const shift = (time, days) => new Date(Date.parse(time) + days * 86_400_000).toISOString().replace(".000Z", "Z");
const digest = text => createHash("sha256").update(text).digest("hex");

function runScript(name, args) {
  const result = spawnSync(process.execPath, [path.join(scripts, name), ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function moduleSource(id, overrides = {}) {
  return `import { referenceModule } from ${JSON.stringify(pathToFileURL(path.join(root, referencePath)).href)};
const value = await referenceModule(${JSON.stringify(id)});
export const definition = { ...value.definition, ...${JSON.stringify(overrides)} };
export const collectBatch = value.collectBatch;
export const scoreMetric = value.scoreMetric;
`;
}

export async function runOperationalValueBenchmark() {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".tmp", "operational-value-benchmark-"));
  const checks = [];
  const cases = [];
  const fingerprints = {};
  const check = (caseId, category, name, expected, actual) => {
    const passed = typeof expected === "number" && typeof actual === "number"
      ? Number.isFinite(actual) && Math.abs(expected - actual) <= 1e-9
      : isDeepStrictEqual(expected, actual);
    checks.push({ caseId, category, name, passed, expected, actual });
  };
  const fingerprint = file => {
    fingerprints[file] = digest(readFileSync(path.join(root, file)));
  };
  try {
    for (const file of [
      "scripts/benchmark-operational-value.mjs",
      "package.json", "tests/unit/cao-operational-value-benchmark.test.mjs",
      "tests/unit/cao-operational-value-review.test.mjs",
      "tests/unit/cao-operational-value-pulse.test.mjs",
      "tests/fixtures/operational-value-benchmark/corpus.mjs", referencePath,
      `${skill}/SKILL.md`, `${skill}/references/module-contract.md`,
      `${skill}/scripts/pulse.css`,
      "dashboard/site/src/data/model/schema.js",
      ...readdirSync(scripts).filter(name => name.endsWith(".mjs")).map(name => `${skill}/scripts/${name}`),
    ]) fingerprint(file);
    for (const item of corpus) {
      const acquisition = JSON.parse(runScript("discover-intent.mjs", [
        "--root", root, ...(item.source ? ["--source", item.source] : ["--goal", item.goal]),
      ]));
      if (item.source) fingerprint(item.source);
      check(item.id, "intent-source", "bounded-source-or-goal-read", true,
        item.source ? acquisition.document.text.includes(item.grounding)
          && acquisition.document.sha256 === fingerprints[item.source] : acquisition.goal === item.goal);
      cases.push({
        id: item.id, source: item.source ?? "natural-language",
        disposition: item.disposition, dispositionOrigin: "author-curated, not model-predicted",
        ...(item.reason ? { reason: item.reason } : {}),
      });
      if (item.disposition !== "measurable") continue;
      if (item.module) fingerprint(item.module);
      const value = await referenceModule(item.id);
      const { definition, metricId, scoreMetric } = value;
      const file = path.join(temporary, `${item.id}.mjs`);
      writeFileSync(file, moduleSource(item.id));
      const frozen = digest(readFileSync(file));
      check(item.id, "interface", "production-definition-and-collector-verifier", true,
        runScript("verify-value-function.mjs", ["--collector", file]).startsWith("verified "));
      const expectedValidation = item.expectedValidation ?? {
        targetAttained: item.kind === "count" ? 0 : item.kind === "target" ? 2 : 100,
        targetMissed: item.kind === "count" ? 2 : item.kind === "target" ? 10 : 0,
        missing: null, malformed: null,
      };
      for (const [name, expected] of Object.entries(expectedValidation)) {
        check(item.id, "native-score", name, expected, scoreMetric(metricId, definition.validationExamples[name]));
      }
      for (const sample of [
        { name: "first-cutoff", evidence: item.before, expected: item.beforeValue },
        { name: "second-cutoff", evidence: item.after, expected: item.afterValue },
        ...(item.extra ?? []),
      ]) {
        check(item.id, "native-score", sample.name, sample.expected, scoreMetric(metricId, sample.evidence));
      }
      let unknownRejected;
      try {
        unknownRejected = scoreMetric("not-a-declared-metric", item.before) === null;
      } catch (error) {
        if (error.message !== "unknown metric: not-a-declared-metric") throw error;
        unknownRejected = true;
      }
      check(item.id, "native-score", "unknown-metric-is-rejected", true, unknownRejected);
      const enriched = structuredClone(item.before);
      enriched.producedPullRequests = 1000;
      enriched.actor = "another-automation";
      if (enriched.records) {
        enriched.records = enriched.records.map(record => ({ ...record, actor: "human", producedOutputs: 1000 }));
        check(item.id, "native-score", "empty-population", item.kind === "count" ? 0 : null,
          scoreMetric(metricId, value.empty));
        check(item.id, "invariance", "opportunity-order", item.beforeValue,
          scoreMetric(metricId, { ...enriched, records: [...enriched.records].reverse() }));
        check(item.id, "native-score", "duplicate-opportunity-identity", null,
          scoreMetric(metricId, { ...enriched, records: [enriched.records[0], enriched.records[0]] }));
        check(item.id, "native-score", "invalid-acceptance-gate", null,
          scoreMetric(metricId, { ...enriched, records: [{ ...enriched.records[0], [item.fields[0]]: "true" }] }));
      }
      check(item.id, "invariance", "actor-and-output-volume", item.beforeValue, scoreMetric(metricId, enriched));
      check(item.id, "invariance", "repeated-scoring", [item.beforeValue, item.beforeValue, item.beforeValue],
        [0, 1, 2].map(() => scoreMetric(metricId, item.before)));
      const requests = [firstEnd, secondEnd].map(windowEnd => ({
        windowStart: shift(windowEnd, -definition.evidence.window.durationDays), windowEnd, observedAt: windowEnd,
      }));
      const collected = await value.collectBatch(requests);
      check(item.id, "collection", "batch-order-and-evidence", [item.before, item.after],
        collected.map(row => row.evidence));
      check(item.id, "collection", "repeatable-batch", collected, await value.collectBatch(requests));
      check(item.id, "collection", "unknown-cutoff-is-missing", null,
        scoreMetric(metricId, (await value.collectBatch([{
          windowStart: secondEnd, windowEnd: shift(secondEnd, 7), observedAt: shift(secondEnd, 7),
        }]))[0].evidence));
      const snapshot = (end, evidence) => ({
        observedAt: end, window: { startAt: shift(end, -7), endAt: end },
        evidence: { ...structuredClone(evidence), coverageStatus: "complete", maturityStatus: "matured" },
        provenance: collected[0].provenance,
      });
      const first = snapshot(firstEnd, item.before);
      const second = snapshot(secondEnd, item.after);
      const scenarios = [
        { name: "improvement", snapshots: [first, second], current: item.afterValue, delta: item.afterValue - item.beforeValue, gain: item.gain },
        { name: "deterioration", snapshots: [snapshot(firstEnd, item.after), snapshot(secondEnd, item.before)],
          current: item.beforeValue, delta: item.beforeValue - item.afterValue, gain: -item.gain },
        { name: "missing-current", snapshots: [first, snapshot(secondEnd, definition.validationExamples.missing)], current: null },
        { name: "unknown-coverage", snapshots: [first, { ...second, evidence: { ...second.evidence, coverageStatus: "unknown" } }], current: item.afterValue },
        { name: "interim-current", snapshots: [first, { ...second, evidence: { ...second.evidence, maturityStatus: "interim" } }], current: item.afterValue },
        { name: "gap", snapshots: [snapshot(shift(firstEnd, -1), item.before), second], current: item.afterValue },
        { name: "overlap", snapshots: [snapshot(shift(firstEnd, 1), item.before), second], current: item.afterValue },
        { name: "stale-current", snapshots: [first, second], current: item.afterValue,
          end: shift(secondEnd, definition.evidence.window.cadenceDays) },
        { name: "future-assessment", snapshots: [first, second], current: item.afterValue, end: shift(secondEnd, -1) },
        { name: "newer-unavailable-same-period", snapshots: [first, second, {
          ...snapshot(secondEnd, definition.validationExamples.missing), observedAt: shift(secondEnd, 1 / 24),
        }], current: null, end: shift(secondEnd, 1 / 24) },
        { name: "explicit-historical-reference", snapshots: [first, second], current: item.afterValue,
          delta: item.afterValue - item.beforeValue, gain: item.gain, baseline: true },
      ];
      if (item.kind === "target") {
        scenarios.push(
          { name: "target-approach-from-below", snapshots: [
            snapshot(firstEnd, { valid: true, errors: 0, requests: 100 }), second,
          ], current: 2, delta: 2, gain: 2 },
          { name: "target-depart-below", snapshots: [
            snapshot(firstEnd, item.after), snapshot(secondEnd, { valid: true, errors: 0, requests: 100 }),
          ], current: 0, delta: -2, gain: -2 },
        );
      }
      for (const scenario of scenarios) {
        let module = file;
        if (scenario.baseline) {
          module = path.join(temporary, `${item.id}-baseline.mjs`);
          writeFileSync(module, moduleSource(item.id, {
            evaluation: { mode: "baseline-comparable" },
            adoption: { ...definition.adoption, adoptedAt: firstEnd, baselineAt: firstEnd, baselineCommit: "1".repeat(40) },
          }));
        }
        const input = path.join(temporary, "observations.json");
        const output = path.join(temporary, `${item.id}-${scenario.name}-timeline.json`);
        writeFileSync(input, JSON.stringify({
          generatedAt: secondEnd, repository: definition.repository, workflowName: definition.workflowName,
          adoptionAt: scenario.baseline ? firstEnd : activation,
          evaluationMode: scenario.baseline ? "baseline-comparable" : "attainment-only",
          window: { startAt: activation, endAt: scenario.end ?? secondEnd },
          evidenceCoverage: {}, snapshots: scenario.snapshots, runs: [],
        }));
        runScript("build-timeline.mjs", [module, input, output]);
        const timeline = JSON.parse(readFileSync(output, "utf8"));
        const metric = timeline.metricReview.metrics.find(candidate => candidate.id === metricId);
        check(item.id, "value-review", scenario.name, {
          current: scenario.current, decision: "not-rated", costStatus: "not-measured", costPerOutcome: null,
        }, {
          current: timeline.valueReview.current.value, decision: timeline.valueReview.decision.status,
          costStatus: timeline.valueReview.cost.status, costPerOutcome: timeline.valueReview.cost.costPerAcceptedOutcome,
        });
        check(item.id, "temporal-comparison", scenario.name, {
          current: scenario.current, status: scenario.gain === undefined ? "unavailable" : "available",
          delta: scenario.delta ?? null, gain: scenario.gain ?? null,
          historicalStatus: scenario.baseline ? "available" : "unavailable",
        }, {
          current: metric.currentValue, status: metric.recentComparison.status,
          delta: metric.recentComparison.nativeDelta, gain: metric.recentComparison.directionAwareGain,
          historicalStatus: metric.adoptionComparison.status,
        });
        if (scenario.name === "improvement") {
          const report = path.join(temporary, `${item.id}-definitions.md`);
          runScript("render-definitions.mjs", [output, report]);
          runScript("validate-report-artifacts.mjs", [output, report]);
          const text = readFileSync(report, "utf8");
          check(item.id, "report", "intent-and-activation-label", true,
            text.includes(item.goal) && text.includes(item.acceptance) && text.includes("not a workflow adoption date"));
        }
      }
      check(item.id, "invariance", "module-unchanged-after-evaluation", true, frozen === digest(readFileSync(file)));
    }
    const probes = [
      { name: "missing-as-zero", id: "prose-confirmed-bug-resolution",
        score: (original, id, evidence) => original(id, evidence) ?? 0 },
      { name: "output-count-proxy", id: "prose-confirmed-bug-resolution",
        score: () => 1000 },
      { name: "normalize-native-value", id: "security-alert-backlog",
        score: (original, id, evidence) => {
          const value = original(id, evidence);
          return value === null ? null : value / 100;
        } },
      { name: "clamp-native-value", id: "native-ai-credit-efficiency",
        score: (original, id, evidence) => {
          const value = original(id, evidence);
          return value === null ? null : Math.min(1, value);
        } },
      { name: "ignore-regression-acceptance", id: "prose-confirmed-bug-resolution",
        score: (original, id, evidence) => evidence?.valid && evidence.records?.length
          ? evidence.records.filter(record => record.closed).length * 100 / evidence.records.length : null },
    ];
    for (const probe of probes) {
      const item = corpus.find(candidate => candidate.id === probe.id);
      const value = await referenceModule(probe.id);
      const detected = [
        [item.before, item.beforeValue], [item.after, item.afterValue],
        [value.definition.validationExamples.missing, null],
      ].some(([evidence, expected]) => !isDeepStrictEqual(
        probe.score(value.scoreMetric, value.metricId, evidence), expected,
      ));
      check(probe.id, "mutation-probe", probe.name, true, detected);
    }
    const categories = Object.fromEntries([...new Set(checks.map(check => check.category))].sort().map(category => {
      const selected = checks.filter(check => check.category === category);
      return [category, { passed: selected.filter(check => check.passed).length, total: selected.length }];
    }));
    const sources = Object.fromEntries(Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right)));
    return {
      schemaVersion: 1, benchmark: "operational-value-local-reference-v1",
      runtime: { node: process.version },
      evidence: "synthetic; not repository outcome observations",
      generativeTranslationEvaluated: false,
      corpusFingerprint: digest(JSON.stringify(sources)), sourceFingerprints: sources,
      totals: { intents: corpus.length, executableContracts: cases.filter(item => item.disposition === "measurable").length,
        designOnlyCases: cases.filter(item => item.disposition !== "measurable").length,
        checks: checks.length, passed: checks.filter(check => check.passed).length,
        failed: checks.filter(check => !check.passed).length },
      categories, cases, checks,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) {
    throw new Error("usage: node scripts/benchmark-operational-value.mjs [--output FILE]");
  }
  const result = await runOperationalValueBenchmark();
  if (args.length) {
    writeFileSync(path.resolve(args[1]), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ totals: result.totals, categories: result.categories }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result.totals.failed) process.exitCode = 1;
}
