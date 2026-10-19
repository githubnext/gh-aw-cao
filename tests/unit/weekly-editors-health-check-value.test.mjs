import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import {
  collectBatch, definition, discoverEditors, resolveEditorUrl, scoreMetric,
} from "../../docs/operational-value/proof/functions/weekly-editors-health-check.mjs";

const metric = definition.metrics[0].id;
const score = evidence => scoreMetric(metric, evidence);

test("native percentage counts exact HTTP 200, not a successful workflow or all 2xx statuses", () => {
  assert.equal(score(definition.validationExamples.targetAttained), 100);
  assert.equal(score(definition.validationExamples.targetMissed), 100 / 3);
  assert.equal(score(definition.validationExamples.missing), null);
  assert.equal(score(definition.validationExamples.malformed), null);
  const evidence = structuredClone(definition.validationExamples.targetAttained);
  const bytes = Buffer.from("HTTP/2 204\r\n\r\n");
  evidence.receipts[0].rawResponse = bytes.toString("base64");
  evidence.receipts[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(score(evidence), 200 / 3);
  assert.equal(scoreMetric("unsupported", evidence), null);
});

test("empty populations, partial coverage, duplicate or forged responses remain unavailable", () => {
  for (const change of [
    row => { row.eligibleCount = 0; row.receipts = []; row.inventory = []; },
    row => { row.coverageStatus = "partial"; },
    row => { row.receipts[0] = row.receipts[1]; },
    row => { row.receipts[0].independent = false; },
    row => { row.receipts[0].rawResponse = Buffer.from("The report says all editors worked").toString("base64"); },
    row => { row.receipts[0].url = "https://example.test/wrong-editor/"; },
    row => { row.receipts[0].sha256 = "0".repeat(64); },
    row => { row.receipts[0].followRedirects = true; },
  ]) {
    const evidence = structuredClone(definition.validationExamples.targetAttained);
    change(evidence);
    assert.equal(score(evidence), null);
  }
});

test("original source-defined curl stdout is accepted only with its exact request binding", () => {
  const evidence = structuredClone(definition.validationExamples.targetAttained);
  const receipt = evidence.receipts[0];
  const bytes = Buffer.from("503");
  Object.assign(receipt, { kind: "original-curl-status", exitCode: 0,
    command: ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", receipt.url],
    rawResponse: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.equal(score(evidence), 200 / 3);
  receipt.command.push("-L");
  assert.equal(score(evidence), null);
});

test("original connection failures require separate reliable probe-environment evidence", () => {
  const evidence = structuredClone(definition.validationExamples.targetAttained);
  const bytes = Buffer.from("curl: (7) Failed to connect to example.test");
  Object.assign(evidence.receipts[0], { kind: "original-curl-failure", exitCode: 7,
    rawResponse: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.equal(score(evidence), null);
  evidence.receipts[0].probeEnvironment = {
    independentlyVerified: true, immutableRef: "synthetic-fixture-not-a-native-probe-environment",
  };
  assert.equal(score(evidence), 200 / 3);
});

test("historical two/three-editor populations and URL eras retain ancillary prose links separately", () => {
  const report = readJsonArchive("docs/operational-value/proof/weekly-editors-health-check/investigation.json");
  for (const profile of report.inventoryHistory.filter(row => row.available)) {
    const result = discoverEditors(Buffer.from(profile.content, "base64").toString());
    assert.equal(result.editors.length, profile.blob === "db9abbc6453a1f7bc7a7f36f31f235396e30cd9d" ? 2 : 3);
    assert.equal(result.ancillary.length, 1);
    assert.equal(result.ancillary[0].url, "https://github.github.com/gh-aw/reference/wasm-compilation/");
    assert.equal(result.editors[0].url, profile.blob === "e08a335139a98b0b04740434d48215e24cec1c67"
      ? "https://github.github.com/editor/" : "https://github.github.com/gh-aw/editor/");
    assert.equal(result.editors.at(-1).url, "https://mossaka.github.io/gh-aw-editor-visualizer/");
    if (result.editors.length === 3) assert.equal(result.editors[1].url, "https://ashleywolf.github.io/agentic-prompt-generator/");
  }
});

test("URL resolution honors documentation base without executing MDX or expressions", () => {
  assert.equal(resolveEditorUrl("${import.meta.env.BASE_URL}editor/"), "https://github.github.com/gh-aw/editor/");
  assert.equal(resolveEditorUrl("/gh-aw/editor/"), "https://github.github.com/gh-aw/editor/");
  assert.equal(resolveEditorUrl("editor/"), "https://github.github.com/gh-aw/editor/");
  assert.throws(() => resolveEditorUrl("${unknown}editor/"));
  assert.throws(() => resolveEditorUrl("http://example.test/"));
  assert.throws(() => discoverEditors("### Editor\n- https://one.test/\n- https://two.test/"));
  assert.equal(discoverEditors("### Editor\n<LinkButton href=\"${import.meta.env.BASE_URL}editor/\">Open</LinkButton>")
    .editors[0].url, "https://github.github.com/gh-aw/editor/");
  assert.equal(discoverEditors("### Editor\n<LinkButton href={`${import.meta.env.BASE_URL}editor/`}>\nOpen\n</LinkButton>")
    .editors[0].url, "https://github.github.com/gh-aw/editor/");
  assert.throws(() => discoverEditors("### Editor\n<LinkButton href={computeUrl()}>\nOpen\n</LinkButton>"));
});

test("production batch preserves missing HTTP evidence without backdating corrected editor URLs", async () => {
  const requests = [
    { windowStart: "2026-02-21T22:11:11Z", windowEnd: "2026-02-22T22:11:11Z", observedAt: "2026-02-22T22:11:11Z" },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-12T15:00:12Z", windowEnd: "2026-10-19T15:00:12Z", observedAt: "2026-10-19T15:00:12Z" },
  ];
  const observations = await collectBatch(requests);
  assert.deepEqual(observations.map(row => row.evidence.eligibleCount), [3, 3, null]);
  assert.equal(observations[0].evidence.inventory[0].url, "https://github.github.com/editor/");
  assert.equal(observations[1].evidence.inventory[0].url, "https://github.github.com/gh-aw/editor/");
  for (const row of observations) {
    assert.equal(score(row.evidence), null);
    assert.equal(row.evidence.nativeOutcomeCount, null);
    assert.equal(row.evidence.knownResponseFailureCount, null);
    assert.equal(row.evidence.coverageStatus, "missing");
    assert.equal(row.evidence.originalHttpReceiptCount, 0);
    assert.ok(row.provenance.length > 0);
    assert.ok(row.evidence.missingReason);
  }
  await assert.rejects(collectBatch([{ ...requests[0], windowStart: requests[0].windowEnd }]));
  await assert.rejects(collectBatch(requests, { checkpoints: [] }));
});

test("native timeline, plot and evidence archive share the exact production function identity", () => {
  const prefix = "docs/operational-value/proof/weekly-editors-health-check/reports/github-gh-aw/weekly-editors-health-check";
  const timeline = readJsonArchive(`${prefix}-timeline.json`);
  const pulse = readJsonArchive(`${prefix}-pulse.json`);
  const archive = readJsonArchive(`${prefix}-evidence-archive.json`);
  const hash = createHash("sha256").update(readFileSync(
    "docs/operational-value/proof/functions/weekly-editors-health-check.mjs")).digest("hex");
  assert.equal(timeline.valueFunction.sha256, hash);
  assert.equal(pulse.valueFunctionSha256, hash);
  assert.ok(Object.hasOwn(archive.functions, hash));
  assert.equal(archive.functions[hash].snapshots.length, 0);
  assert.deepEqual(timeline.valueFunction.definition, definition);
  assert.equal(timeline.window.startAt, definition.adoption.adoptedAt);
  assert.equal(timeline.window.endAt, "2026-10-18T15:00:12Z");
  assert.equal(timeline.snapshots.length, 36);
  for (const snapshot of timeline.snapshots) {
    assert.equal(snapshot.metrics[metric], score(snapshot.evidence));
    assert.equal(snapshot.metrics[metric], null);
    assert.equal(snapshot.evidence.originalHttpReceiptCount, 0);
  }
  assert.equal(pulse.metrics[0].unit, "percent");
  assert.equal(pulse.metrics[0].series.length, timeline.snapshots.length);
  assert.ok(pulse.metrics[0].series.every(row => row.value === null));
  assert.equal(pulse.metrics[0].signal.status, "insufficient-evidence");
  assert.equal(pulse.decision.status, "not-rated");
});

test("full predecessor closure and exact native scoring implementation survive source extension", () => {
  const prefix = "docs/operational-value/proof/weekly-editors-health-check/predecessor-owned-v018";
  const manifest = JSON.parse(readFileSync(`${prefix}.manifest.json`));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(readFileSync(`${prefix}.tar.gz`)), "51664253ab6cc2962861eadf88b73a541b2c34d2a878195a1b67a67e93b2363e");
  assert.equal(manifest.members.length, 16);
  for (const member of manifest.members) {
    const bytes = execFileSync("tar", ["-xOf", `${prefix}.tar.gz`, member.path]);
    assert.equal(bytes.length, member.bytes);
    assert.equal(hash(bytes), member.sha256);
  }
  const modulePath = "docs/operational-value/proof/functions/weekly-editors-health-check.mjs";
  const previous = execFileSync("tar", ["-xOf", `${prefix}.tar.gz`, modulePath], { encoding: "utf8" });
  const current = readFileSync(modulePath, "utf8");
  const scorer = text => text.match(/export function scoreMetric[\s\S]*?(?=export async function collectBatch)/)[0];
  const responseParser = text => text.match(/function responseStatus[\s\S]*?(?=const fixture)/)[0];
  assert.equal(scorer(current), scorer(previous));
  assert.equal(responseParser(current), responseParser(previous));
});
