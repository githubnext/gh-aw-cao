import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = ".github/skills/add-operational-value/scripts";
const until = "2026-10-18T15:00:12Z";
const slugs = ["stale-pr-cleanup", "draft-pr-cleanup", "sub-issue-closer"];
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return { command: [process.execPath, ...args], status: result.status, output: result.stdout.trim() };
};
const checks = [];
for (const slug of slugs) {
  const modulePath = `docs/operational-value/proof/functions/${slug}.mjs`;
  const value = await import(pathToFileURL(path.join(root, modulePath)).href);
  const moduleSha256 = createHash("sha256").update(readFileSync(path.join(root, modulePath))).digest("hex");
  checks.push(run([`${skill}/verify-value-function.mjs`, "--collector", modulePath]));
  const requests = [
    { windowStart: "2026-10-11T00:00:00Z", windowEnd: "2026-10-18T00:00:00Z", observedAt: until },
    { windowStart: "2026-10-18T00:00:00Z", windowEnd: until, observedAt: until },
  ];
  const first = await value.collectBatch(requests);
  assert.deepEqual(await value.collectBatch(requests), first);
  assert.deepEqual(first.map(item => value.scoreMetric("native", item.evidence)),
    slug === "sub-issue-closer" ? [null, 2] : [null, null]);
  const args = [`${skill}/evaluate.mjs`, "--root", root, "--end", until,
    "--output-dir", "docs/operational-value/proof/native-cleanup-outcomes/reports",
    "--function", modulePath, "--refresh", "github/gh-aw", slug];
  checks.push(run(args));
  const timelineFile = path.join(root, `docs/operational-value/proof/native-cleanup-outcomes/reports/github-gh-aw/${slug}-timeline.json`);
  const report1 = JSON.parse(readFileSync(timelineFile));
  checks.push(run(args));
  const report2 = JSON.parse(readFileSync(timelineFile));
  assert.deepEqual(report2.snapshots, report1.snapshots, "Refresh changed retained native facts");
  assert.deepEqual(report2.valueFunction, report1.valueFunction, "Refresh changed frozen contract");
  const accepted = report2.snapshots.filter(snapshot => snapshot.metrics.native !== null);
  const total = accepted.reduce((sum, snapshot) => sum + snapshot.metrics.native, 0);
  assert.equal(total, slug === "sub-issue-closer" ? 2 : 0);
  checks.push({
    slug, moduleSha256, refreshes: 2, directCollectBatchReplays: 2,
    periods: report2.snapshots.length,
    measuredSubtotalPeriods: accepted.length,
    unknownPeriods: report2.snapshots.length - accepted.length,
    nativeKnownSubtotal: total,
    qualifiedNativeInstrument: slug === "sub-issue-closer",
    comparison: "Exact snapshots and valueFunction match across standard --refresh evaluations.",
  });
}
checks.push(run(["--test", "tests/unit/native-cleanup-outcomes.test.mjs"]));
const receipt = {
  schemaVersion: 1, until, node: process.version, checks,
  networkRequired: false, gitRequired: false, nodeModulesRequired: false,
  pythonRequired: "Python 3 standard-library zipfile only; no archive member is executed.",
  shasumRequired: "The unchanged skill runtime uses shasum -a 256 FILE.",
  result: "Three deterministic instruments and reports replay. Only sub-issue-closer has demonstrated native useful-outcome evidence; the two PR cleanup instruments remain unqualified gaps.",
};
writeFileSync(path.join(root, "docs/operational-value/proof/native-cleanup-outcomes/replay.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
