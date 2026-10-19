import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { cutoff, revision, sha256 } from "./custody.mjs";

const root = process.cwd(), base = path.dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] ?? path.relative(root, path.join(base, "reports"));
const skill = ".github/skills/add-operational-value/scripts";
const history = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
assert.equal(history.index.partitions.length, 346);
assert.equal(history.entities.length, 58048);
assert.equal(history.index.repositoryId, 1036865607);
assert.equal(history.index.sourceRevision, revision);
assert.equal(history.index.until, cutoff);
const run = args => execFileSync(process.execPath, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
});
const results = [];
for (const [slug, expected, expectedPeriods] of [
  ["dependabot-burner", [4, 3], 38],
  ["dependabot-go-checker", [1, 2, 1], 50],
  ["go-fan", [10], 47],
]) {
  const file = `docs/operational-value/proof/functions/${slug}.mjs`;
  run([`${skill}/verify-value-function.mjs`, "--collector", file]);
  const args = [`${skill}/evaluate.mjs`, "--refresh", "--no-runs", "--end", cutoff, "--output-dir", output,
    "--function", file, "github/gh-aw", slug];
  run(args);
  const timelineFile = path.join(output, "github-gh-aw", `${slug}-timeline.json`);
  const first = JSON.parse(readFileSync(timelineFile));
  run(args);
  const second = JSON.parse(readFileSync(timelineFile));
  assert.deepEqual(second.snapshots, first.snapshots);
  assert.deepEqual(second.valueFunction, first.valueFunction);
  assert.equal(second.snapshots.length, expectedPeriods);
  const scores = second.snapshots.map(row => row.metrics["native-partial"]);
  assert.deepEqual(scores.filter(value => value !== null), expected);
  assert.deepEqual(second.snapshots.map(row => row.metrics["corroborated-partial"]).filter(value => value !== null), expected);
  assert.equal(second.snapshots.at(-1).window.endAt, cutoff);
  const counts = new Set();
  for (let index = 0; index < second.snapshots.length; index++) {
    const row = second.snapshots[index];
    if (index) assert.equal(second.snapshots[index - 1].window.endAt, row.window.startAt);
    for (const id of row.evidence.caseIds) {
      assert.equal(counts.has(id), false, "Native case counted in more than one disjoint period");
      counts.add(id);
    }
    assert.equal(row.evidence.strictFullGoalAcceptance, null);
    assert.equal(row.evidence.actualCosts, null);
    assert.equal(row.evidence.completeComparablePeriod, false);
  }
  results.push({ slug, moduleSha256: sha256(readFileSync(file)), periods: expectedPeriods,
    observedPeriods: expected.length, unknownPeriods: scores.filter(value => value === null).length,
    nativePartialSubtotal: expected.reduce((sum, value) => sum + value, 0),
    corroboratedPartialSubtotal: expected.reduce((sum, value) => sum + value, 0),
    observations: second.snapshots.filter(row => row.metrics["native-partial"] !== null)
      .map(row => ({ window: row.window, metrics: row.metrics })),
    strictAcceptance: null, actualCosts: null, decision: "not rated",
    refreshedTwiceOffline: true, exactSnapshotReplay: true, disjointCoverage: true,
    snapshotSha256: sha256(Buffer.from(JSON.stringify(second.snapshots))) });
}
const files = directory => readdirSync(directory).flatMap(name => {
  const file = path.join(directory, name), stat = statSync(file);
  if (stat.isDirectory()) return files(file);
  assert.ok(stat.size <= 256 * 1024, `Artifact exceeds 256 KiB: ${file}`);
  return [{ path: path.relative(root, file), bytes: stat.size, sha256: sha256(readFileSync(file)) }];
});
const receipt = { schemaVersion: 1, cohort: "go-dependency", repository: "github/gh-aw",
  repositoryId: 1036865607, frozenRevision: revision, cutoff,
  integrationCheckpoint: "ce52f9bb36e7a1747f544a912978a87c925fa096",
  skillVersion: readFileSync(".github/skills/add-operational-value/SKILL.md", "utf8").match(/version: "([^"]+)"/)?.[1],
  runtime: process.version, nativeOracleToolchain: execFileSync("go", ["env", "GOVERSION"], {
    encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off" },
  }).trim(),
  productionDiscovery: { partitions: 346, entities: 58048, complete: true },
  costs: "not measured", decision: "not rated", results, artifacts: files(path.resolve(output)) };
mkdirSync(base, { recursive: true });
writeFileSync(path.join(base, "replay-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt.results, null, 2));
