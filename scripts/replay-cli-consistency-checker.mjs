import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { collectBatch, definition, scoreMetric } from "../docs/operational-value/proof/functions/cli-consistency-checker.mjs";

const base = "docs/operational-value/proof/cli-consistency-checker";
const module = "docs/operational-value/proof/functions/cli-consistency-checker.mjs";
const scripts = ".github/skills/add-operational-value/scripts";
const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const cutoff = "2026-10-18T15:00:12Z";
const [collection] = await collectBatch([{ windowStart: "2026-10-17T15:00:12Z", windowEnd: cutoff, observedAt: cutoff }]);
const frozenSnapshot = {
  schemaVersion: 1, kind: "native-current-source-facet", capturedAt, cutoff,
  definition, collection,
  metrics: Object.fromEntries(definition.metrics.map(metric => [metric.id, scoreMetric(metric.id, collection.evidence)])),
  limitation: "One frozen source-native documentation snapshot, not a historical comparison or full CLI acceptance.",
};
mkdirSync(base, { recursive: true });
writeJsonArchive(path.join(base, "frozen-snapshot.json.gz"), frozenSnapshot);
const verify = execFileSync(process.execPath, [`${scripts}/verify-value-function.mjs`, "--collector", module], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const cutoffEvaluation = spawnSync(process.execPath, [`${scripts}/evaluate.mjs`, "--end", cutoff,
  "--output-dir", `${base}/reports/frozen`, "--function", module, "--no-runs", "github/gh-aw", "cli-consistency-checker"], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (cutoffEvaluation.error) throw cutoffEvaluation.error;
if (cutoffEvaluation.status !== 1 || !cutoffEvaluation.stderr.includes(`evaluation end must follow ${cutoff}`)) {
  throw new Error("Expected explicit temporal rejection at the activation cutoff");
}
const prospective = spawnSync(process.execPath, [`${scripts}/evaluate.mjs`, "--end", capturedAt,
  "--output-dir", `${base}/reports/prospective`, "--function", module, "--no-runs", "github/gh-aw", "cli-consistency-checker"], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (prospective.error) throw prospective.error;
if (prospective.status !== 0) throw new Error(`Prospective standard evaluation failed: ${prospective.stderr}`);
writeJsonArchive(path.join(base, "replay.json"), {
  schemaVersion: 1, capturedAt,
  collector: { stdout: verify, status: 0 },
  frozenEvaluation: { end: cutoff, status: cutoffEvaluation.status,
    stdout: cutoffEvaluation.stdout, stderr: cutoffEvaluation.stderr,
    reason: "Contract activation equals frozen cutoff. Refusing to backdate source predicates or fabricate a historical series." },
  prospectiveEvaluation: { end: capturedAt, status: prospective.status,
    stdout: prospective.stdout, stderr: prospective.stderr,
    limitation: "Later evidence is separate and unavailable, never a carried-forward frozen score." },
  nativeMetric: frozenSnapshot.metrics,
  fullAcceptance: null, contribution: null,
});
console.log(JSON.stringify({ ...frozenSnapshot.metrics, frozenEvaluation: "temporally-ineligible",
  prospectiveEvaluation: "generated-separately", capturedAt, fullAcceptance: null, contribution: null }, null, 2));
