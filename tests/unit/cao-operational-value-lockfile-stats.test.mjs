import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { checkoutReceipt, nativeStatisticalFacts, protectedAgentLog, reconcileStatisticalClaims } from "../../scripts/reconcile-lockfile-stats.mjs";
import { definition, scoreMetric } from "../../docs/operational-value/proof/functions/lockfile-stats.mjs";
import { readLockfileInputs } from "../../scripts/lockfile-stats-inputs.mjs";
import { parseIncludedResponse, quotaStop, queueTarget } from "../../scripts/resume-lockfile-stats-acquisition.mjs";

const directory = "docs/operational-value/proof/lockfile-stats";

test("protected log identity follows the compiled job display name without case guessing", () => {
  const jobs = { jobs: [{ name: "Agent", id: 1 }] };
  assert.equal(protectedAgentLog(jobs, ["4_Agent.txt", "Agent/system.txt"],
    { jobs: { agent: { name: "Agent" } } }).entry, "4_Agent.txt");
  assert.throws(() => protectedAgentLog(jobs, ["4_agent.txt"], { jobs: { agent: { name: "Agent" } } }), /unique/);
  assert.throws(() => protectedAgentLog(jobs, ["4_Agent.txt"], { jobs: { agent: {} } }), /unique/);
  assert.throws(() => protectedAgentLog(jobs, ["4_Agent.txt"], { jobs: { agent: { name: "${{ matrix.name }}" } } }), /Unresolved/);
});

test("native lockfile accuracy is not successful-run or report volume", () => {
  const metric = "verified-statistical-facts";
  assert.equal(definition.metrics.filter(row => row.role === "primary").length, 1);
  assert.equal(scoreMetric(metric, { valid: true, runs: 99, discussions: 99 }), null);
  assert.equal(scoreMetric(metric, definition.validationExamples.targetAttained), 2);
  assert.equal(scoreMetric("incorrect-statistical-facts", definition.validationExamples.targetMissed), 1);
  assert.equal(scoreMetric(metric, { valid: true, assessments: [{ id: 1, status: "missing", claims: [] }] }), null);
  assert.equal(scoreMetric(metric, { valid: true, assessments: [{ id: 1, status: "assessed", claims: [] }] }), 0);
  assert.equal(scoreMetric(metric, { valid: true, assessments: [{ id: 1, status: "missing", claims: [{ field: "x", agrees: true }] }] }), null);
});

test("numeric claims use semantic field identity, preserve mismatches and unsupported quantities", () => {
  const result = reconcileStatisticalClaims({
    total_bytes: 20, avg_bytes: 6.7, engine_distribution: { claude: 2 }, ungrounded_quality: 100,
  }, { total_bytes: 21, avg_bytes: 20 / 3, engine_distribution: { claude: 2 } });
  assert.deepEqual(result.claims.map(row => [row.field, row.agrees]),
    [["total_bytes", false], ["avg_bytes", true], ["engine_distribution.claude", true]]);
  assert.deepEqual(result.unsupported, [{ field: "ungrounded_quality", value: 100 }]);
  assert.equal(reconcileStatisticalClaims({ x: 2 }, { y: 2 }).claims.length, 0);
  const partial = reconcileStatisticalClaims({ safe_output_types: { create_issue: 3 }, total_bytes: 5 },
    { safe_outputs_config_invalid: 1, safe_output_types: { create_issue: 3 }, total_bytes: 5 });
  assert.deepEqual(partial.claims, [{ field: "total_bytes", meaning: "total_bytes", actual: 5, expected: 5, agrees: true }]);
  assert.match(partial.unsupported[0].reason, /unresolved/);
});

test("protected checkout identity requires the actual successful host interval and git readback", () => {
  const sha = "a".repeat(40);
  const receipt = { status: "completed", conclusion: "success",
    started_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:00:02Z" };
  const log = `2026-10-01T00:00:00.1Z ${sha}\n2026-10-01T00:00:01Z [command]/usr/bin/git log -1 --format=%H\n2026-10-01T00:00:01.2Z ${sha}\n`;
  assert.equal(checkoutReceipt(log, receipt, sha).checkoutSha, sha);
  assert.equal(checkoutReceipt(log, { ...receipt, conclusion: "failure" }, sha), null);
  assert.equal(checkoutReceipt(log, receipt, "b".repeat(40)), null);
  assert.equal(checkoutReceipt(log.replace("git log -1 --format=%H", "echo"), receipt, sha), null);
  assert.equal(checkoutReceipt(log.replaceAll("2026-10-01", "2026-10-02"), receipt, sha), null);
});

test("schema spelling cannot hide native facts and omitted map scopes are effective none", () => {
  const facts = nativeStatisticalFacts({ avg_bytes: 15.5, min_bytes: 10, max_bytes: 21,
    job_counts: { total_jobs: 3, max_jobs: 2 } }, [
    { status: "parsed", agent_job_permissions: { contents: "read" }, union_job_permissions: { contents: "read", issues: "write" } },
    { status: "parsed", agent_job_permissions: {}, union_job_permissions: {} },
  ]);
  assert.equal(facts.avg_size, 15.5);
  assert.deepEqual(facts.job_counts_summary, { avg: 1.5, max: 2 });
  assert.deepEqual(facts.permissions_by_scope.contents, { read: 1, write: 0, none: 1 });
  assert.deepEqual(facts.agent_job_permissions_by_scope.issues, { read: 0, write: 0, none: 2 });
  assert.deepEqual(facts.union_job_permissions_by_scope.issues, { read: 0, write: 1, none: 1 });
  const differentGrain = reconcileStatisticalClaims({ script_counts_summary: { max: 10 } },
    { script_step_counts: { max: 5 } });
  assert.deepEqual(differentGrain.claims, []);
  assert.match(differentGrain.unsupported[0].reason, /Different grains/);
  const duplicate = reconcileStatisticalClaims({ workflow_dispatch_count: 2, trigger_counts: { workflow_dispatch: 2 } },
    { workflow_dispatch_count: 2, trigger_counts: { workflow_dispatch: 2 } });
  assert.equal(scoreMetric("verified-statistical-facts", { valid: true,
    assessments: [{ id: 1, status: "assessed", claims: duplicate.claims }] }), 1);
});

test("retained real acquisition covers every discovered run, not a selected easy sample", () => {
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  const index = readCensusJson(`${directory}/inventory-index.json`);
  assert.equal(index.complete, true);
  assert.equal(index.runs, 414);
  assert.equal(inventory.length, index.runs);
  assert.equal(censusDigest(inventory), index.inventorySha256);
  assert.equal(new Set(inventory.map(row => row.id)).size, inventory.length);
  assert.equal(index.contractSha256, censusDigest(readCensusJson(`${directory}/contract.json`)));
});

test("real original statistical facts replay against the complete native lockfile population", () => {
  const observations = readdirSync(`${directory}/observations`).filter(name => /^\d+\.json\.gz$/.test(name));
  assert.ok(observations.length > 0, "Actual independently verified historical evidence must exist");
  for (const name of observations) {
    const row = readCensusJson(`${directory}/observations/${name}`);
    assert.equal(row.status, "assessed");
    const native = readCensusJson(`${directory}/${row.nativeInput}`);
    assert.equal(censusDigest(native), row.nativeInputSha256);
    assert.equal(native.population.length, row.eligibleLockfiles);
    assert.ok(row.eligibleLockfiles > 250, "Full historical census, not an arbitrary file subset");
    const bytes = Buffer.from(row.originalSummary.content, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.originalSummary.sha256);
    assert.deepEqual(reconcileStatisticalClaims(JSON.parse(bytes), native.facts, native.population),
      { claims: row.claims, unsupported: row.unsupported });
    assert.equal(readLockfileInputs(`${directory}/inputs`, native).length, row.eligibleLockfiles);
    assert.throws(() => readLockfileInputs(`${directory}/absent-original-inputs`, native),
      /ENOENT/, "A missing original input must never leave claimed real coverage passing");
    assert.ok(row.claims.some(claim => claim.agrees));
    assert.equal(row.receipt.checkout.checkoutSha, row.headSha);
    assert.equal(row.receipt.artifact.workflow_run.id, row.id);
  }
  assert.equal(readFileSync("scripts/native-lockfile-stats.py", "utf8").includes("yaml.safe_load"), true);
});
test("coordinated acquisition retains actual headers, binary bytes and fail-closed quota stops", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 128]);
  const parsed = parseIncludedResponse(Buffer.concat([Buffer.from("HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 42\r\nContent-Type: application/zip\r\n\r\n"), zip]));
  assert.deepEqual(parsed.body, zip);
  assert.equal(parsed.blocks[0].headers["x-ratelimit-remaining"], "42");
  assert.equal(quotaStop(parsed.blocks), false);
  for (const headers of ["X-RateLimit-Remaining: 0", "Retry-After: 12"]) {
    assert.equal(quotaStop(parseIncludedResponse(Buffer.from(`HTTP/2.0 200 OK\n${headers}\n\nbody`)).blocks), true);
  }
  for (const status of [403, 429]) assert.equal(quotaStop([{ status, headers: {} }]), true);
  assert.throws(() => parseIncludedResponse(zip), /No actual HTTP/);
  assert.throws(() => queueTarget({ runId: 1, artifactId: 2 }, "rate_limit"), /outside/);
  assert.equal(queueTarget({ runId: 1, artifactId: 2 }, "repos/github/gh-aw/actions/artifacts/2/zip").maxBytes, 16 * 1024 * 1024);
});

test("actual coordinated acquisition exhausts only its frozen queue and retains response identities", () => {
  const receipt = readCensusJson(`${directory}/acquisition-2026-10-19.json`);
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  const artifacts = new Map(inventory.flatMap(run => run.artifacts).map(artifact => [artifact.id, artifact]));
  assert.equal(receipt.status, "exact-queue-acquired");
  assert.equal(receipt.concurrency, 1);
  assert.equal(receipt.queue.length, 17);
  assert.equal(receipt.requests.length, 49);
  assert.deepEqual(receipt.requests.map(row => row.endpoint), receipt.queue.flatMap(row => row.endpoints));
  for (const row of receipt.requests) {
    assert.equal(row.accepted, true);
    assert.equal(quotaStop(row.headers), false);
    assert.equal(row.headers.at(-1).status, 200);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    const queued = receipt.queue.find(item => item.runId === row.runId);
    const target = queueTarget(queued, row.endpoint);
    assert.ok(row.bytes <= target.maxBytes);
    if (target.kind === "artifact" && artifacts.get(row.artifactId).digest) {
      assert.equal(`sha256:${row.sha256}`, artifacts.get(row.artifactId).digest);
    }
  }
  const index = readCensusJson(`${directory}/index.json`);
  assert.equal(index.acquisitionComplete, true);
  assert.equal(index.pendingRetainedAcquisitions, 0);
  assert.equal(readCensusJson(`${directory}/resume.json`).pending.length, 0);
});
