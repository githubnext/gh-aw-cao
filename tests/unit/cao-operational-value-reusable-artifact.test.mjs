import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { assessReusableArtifacts, reusableArtifactModule, reusableArtifactPaths,
  scoreReusableArtifacts, sha256 } from "../../scripts/reusable-artifact-value.mjs";
import { readReusableArchiveEntries, ReusableReceiptGap, reusableExpectedInputs,
  verifyReusableInputSerialization, verifyReusablePayloadContents, verifyReusableProtectedReadback,
  verifyReusableProviderArtifact } from "../../scripts/reusable-artifact-receipts.mjs";

function scenario() {
  return { runId: 1, headSha: "a".repeat(40), eligible: true, sourceBound: true, inventoryComplete: true,
    invocations: ["a", "b", "c"].map((id, i) => ({ caller: `task-${id}`, prefix: `${String(i).repeat(8)}-`,
      payloadCorrect: true, consumerCorrect: true, additionalArtifactsIsolated: true,
      payloadReceiptSha256: "b".repeat(64), consumerReceiptSha256: "c".repeat(64),
      artifacts: ["activation", "agent"].map((kind, j) => ({ id: i * 2 + j + 1,
        name: `${String(i).repeat(8)}-${kind}`, runId: 1, headSha: "a".repeat(40),
        digest: `sha256:${"d".repeat(64)}`, archiveSha256: "d".repeat(64) })) })) };
}

test("reusable artifact conjunction refuses success, names and counts as content proof", () => {
  assert.equal(assessReusableArtifacts(scenario()), true);
  for (const property of ["payloadCorrect", "consumerCorrect", "additionalArtifactsIsolated"]) {
    const row = scenario();
    row.invocations[0][property] = null;
    assert.equal(assessReusableArtifacts(row), null);
  }
  const row = scenario();
  row.invocations[1].artifacts[0].archiveSha256 = "e".repeat(64);
  assert.equal(assessReusableArtifacts(row), null);
  row.eligible = null;
  assert.equal(assessReusableArtifacts(row), null);
});

test("collision and incorrect payload evidence differs from missing evidence", () => {
  const collision = scenario();
  collision.invocations[1].prefix = collision.invocations[0].prefix;
  assert.equal(assessReusableArtifacts(collision), false);
  const incorrect = scenario();
  incorrect.invocations[0].payloadCorrect = false;
  assert.equal(assessReusableArtifacts(incorrect), false);
  const missing = scenario();
  missing.invocations[0].artifacts = [];
  assert.equal(assessReusableArtifacts(missing), null);
  assert.equal(scoreReusableArtifacts("verified-scenarios", { valid: true,
    assessments: [{ id: 1, attained: false }] }), 0);
  assert.equal(scoreReusableArtifacts("verified-scenarios", { valid: true,
    assessments: [{ id: 1, attained: null }] }), null);
  assert.equal(scoreReusableArtifacts("verified-scenarios", { valid: true, assessments: [] }), null);
});

test("exact reviewed native prefix script distinguishes declared input and retry probes", () => {
  const contract = readCensusJson(reusableArtifactPaths.contract);
  const sources = readCensusJson(`${reusableArtifactPaths.directory}/sources.json.gz`);
  const script = sources.find(row => row.path === "actions/setup/sh/compute_artifact_prefix.sh"
    && row.revision === contract.sourceRevision);
  const bytes = Buffer.from(script.content, "base64");
  assert.equal(sha256(bytes), script.sha256);
  // This is the fully inspected hash-only shell helper, not arbitrary repository execution.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "reusable-native-prefix-"));
  try {
    const results = [];
    for (const [caller, job] of Object.entries(contract.callerJobs)) {
      for (const attempt of [1, 2]) {
        const output = path.join(scratch, `${caller}-${attempt}.txt`);
        execFileSync("bash", ["-s"], { input: bytes, timeout: 5000,
          env: { PATH: process.env.PATH, INPUTS_JSON: JSON.stringify(job.with),
            GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_OUTPUT: output } });
        const prefix = readFileSync(output, "utf8").trim();
        assert.match(prefix, /^prefix=[a-f0-9]{8}-$/);
        results.push(prefix);
      }
    }
    assert.equal(new Set(results).size, 6);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("actual retained discovery is complete but never substitutes for native outcome evidence", () => {
  const index = readCensusJson(reusableArtifactPaths.index);
  const rows = readCensusJson(`${reusableArtifactPaths.directory}/observations.json.gz`);
  const inventory = readCensusJson(`${reusableArtifactPaths.directory}/inventory.json.gz`);
  assert.equal(index.observationsSha256, censusDigest(rows));
  assert.equal(index.inventorySha256, censusDigest(inventory));
  assert.equal(index.discoveryComplete, true);
  assert.equal(inventory.length, 2459);
  assert.equal(rows.length, 2392);
  assert.equal(index.outcomeEvidenceReady, false);
  assert.equal(index.originalAttemptsWithReusableSourceReceipt, 2005);
  assert.equal(rows.filter(row => row.referencedWorkflows?.length).length, 2005);
  assert.equal(rows.filter(row => row.eligible === null && row.referencedWorkflows?.length).length, 1137);
  assert.equal(rows.filter(row => row.eligible === null).length, 1524);
  assert.equal(rows.flatMap(row => row.artifacts ?? []).length, 0);
  assert.ok(rows.every(row => assessReusableArtifacts(row) === null));
  const previousIndex = readCensusJson(`${reusableArtifactPaths.directory}/versions/pre-original-source-receipts/index.json`);
  const previousRows = readCensusJson(`${reusableArtifactPaths.directory}/versions/pre-original-source-receipts/observations.json.gz`);
  const previousInventory = readCensusJson(`${reusableArtifactPaths.directory}/versions/pre-original-source-receipts/inventory.json.gz`);
  assert.equal(censusDigest(previousRows), previousIndex.observationsSha256);
  assert.equal(censusDigest(previousInventory), previousIndex.inventorySha256);
  const timeline = readCensusJson(`${reusableArtifactPaths.directory}/reports/github-gh-aw/smoke-workflow-call-with-inputs-timeline.json`);
  assert.ok(timeline.snapshots.every(snapshot => snapshot.provenance.some(receipt =>
    receipt.kind === "reusable-artifact-isolation-index" && receipt.ref === censusDigest(previousIndex))));
  assert.ok(timeline.snapshots.every(snapshot => snapshot.metrics["verified-scenarios"] === null));
});

test("offline collection preserves unresolved eligibility and fails closed on missing retained evidence", () => {
  const contract = readCensusJson(reusableArtifactPaths.contract);
  const module = reusableArtifactModule(contract);
  const request = { windowStart: "2026-10-11T15:00:12Z", windowEnd: contract.until, observedAt: contract.until };
  const [{ evidence }] = module.collectBatch([request]);
  assert.equal(module.scoreMetric("verified-scenarios", evidence), null);
  assert.equal(evidence.eligibleCount, null);
  assert.equal(evidence.eligibilityStatus, "unknown");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "reusable-missing-evidence-"));
  const cwd = process.cwd();
  try {
    process.chdir(temporary);
    assert.throws(() => module.collectBatch([request]), /ENOENT/);
  } finally {
    process.chdir(cwd);
    rmSync(temporary, { recursive: true });
  }
});

test("provider payload verification requires actual ZIP bytes, digest and immutable execution identities", () => {
  const scratch = mkdtempSync(path.resolve(".reusable-zip-test-"));
  try {
    mkdirSync(path.join(scratch, "aw-prompts"));
    writeFileSync(path.join(scratch, "aw-prompts/prompt.txt"), "Synthetic parser fixture, not a real outcome.");
    const file = path.join(scratch, "payload.zip");
    execFileSync("zip", ["-q", file, "aw-prompts/prompt.txt"], { cwd: scratch, timeout: 5000 });
    const bytes = readFileSync(file);
    const metadata = { id: 1, name: "01234567-activation", expired: false,
      runId: 10, headSha: "a".repeat(40), digest: `sha256:${sha256(bytes)}` };
    const run = { runId: 10, headSha: "a".repeat(40) };
    assert.equal(verifyReusableProviderArtifact(metadata, bytes, run, metadata.name).archiveSha256, sha256(bytes));
    assert.throws(() => verifyReusableProviderArtifact(metadata, Buffer.from("wrong"), run, metadata.name), ReusableReceiptGap);
    assert.throws(() => verifyReusableProviderArtifact({ ...metadata, runId: 11 }, bytes, run, metadata.name), ReusableReceiptGap);
    const decoded = readReusableArchiveEntries(bytes, ["aw-prompts/prompt.txt"], scratch);
    assert.equal(decoded.entries["aw-prompts/prompt.txt"].bytes.toString(), "Synthetic parser fixture, not a real outcome.");
    assert.throws(() => readReusableArchiveEntries(bytes, ["../outside.txt"], scratch), /Unsafe/);
    assert.throws(() => readReusableArchiveEntries(bytes, ["absent.txt"], scratch), ReusableReceiptGap);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test("input defaults preserve zero and receipt parsing never assumes platform JSON serialization", () => {
  const contract = readCensusJson(reusableArtifactPaths.contract);
  const inputs = reusableExpectedInputs(contract, "task-a");
  assert.equal(inputs["task-count"], 0);
  assert.equal(inputs["task-description"], "task-a - first invocation");
  assert.ok(verifyReusableInputSerialization(JSON.stringify(inputs, null, 2), inputs).inputSha256);
  assert.throws(() => verifyReusableInputSerialization(JSON.stringify({ ...inputs, "task-count": 1 }), inputs), ReusableReceiptGap);
  assert.throws(() => verifyReusableInputSerialization("malformed", inputs), ReusableReceiptGap);
});

test("payload and protected noop readback remain separate independently bounded gates", () => {
  const contract = readCensusJson(reusableArtifactPaths.contract);
  const inputs = reusableExpectedInputs(contract, "task-a");
  const source = "---\non: workflow_call\n---\nTask description: ${{ inputs.task-description }}\nTask count: ${{ inputs.task-count }}\n";
  const prompt = `Task description: ${inputs["task-description"]}\nTask count: 0\n`;
  const message = `Completed task: ${inputs["task-description"]}`;
  const output = JSON.stringify({ items: [{ type: "noop", message }] });
  assert.equal(verifyReusablePayloadContents(source, inputs, prompt, output).payloadCorrect, true);
  assert.throws(() => verifyReusablePayloadContents(source, inputs, prompt,
    JSON.stringify({ items: [{ type: "noop", message: "Completed task: task-b" }] })), ReusableReceiptGap);
  const step = { name: "Process Safe Outputs", status: "completed", conclusion: "success",
    started_at: "2026-10-17T01:00:00Z", completed_at: "2026-10-17T01:00:10Z" };
  const line = `2026-10-17T01:00:05Z \u2713 Recorded noop message: ${message}`;
  assert.equal(verifyReusableProtectedReadback(line, step, message).consumerCorrect, true);
  assert.throws(() => verifyReusableProtectedReadback(line.replace("01:00:05Z", "01:00:15Z"), step, message), ReusableReceiptGap);
  assert.throws(() => verifyReusableProtectedReadback(`${line}\n${line}`, step, message), ReusableReceiptGap);
  assert.throws(() => verifyReusableProtectedReadback(line, { ...step, name: "Execute agent" }, message), ReusableReceiptGap);
});

test("complete coordinated queue preserves provider headers without converting missing logs into outcomes", () => {
  const transport = readCensusJson(`${reusableArtifactPaths.directory}/coordinated-log-transport.json.gz`);
  const index = readCensusJson(reusableArtifactPaths.index);
  const rows = readCensusJson(`${reusableArtifactPaths.directory}/observations.json.gz`);
  const remaining = readCensusJson(`${reusableArtifactPaths.directory}/remaining-requests.json`);
  const timeline = readCensusJson(`${reusableArtifactPaths.directory}/final-reports/github-gh-aw/smoke-workflow-call-with-inputs-timeline.json`);
  assert.equal(transport.complete, true);
  assert.equal(transport.authorizedEndpoints, 950);
  assert.equal(transport.receipts.length, 950);
  assert.equal(new Set(transport.receipts.map(row => row.endpoint)).size, 950);
  for (const receipt of transport.receipts) {
    assert.equal(receipt.httpStatus, 404);
    assert.equal(receipt.stop, false);
    assert.equal(receipt.endpoint, `repos/github/gh-aw/actions/runs/${receipt.runId}/attempts/1/logs`);
    assert.equal(receipt.headers["x-ratelimit-resource"], "core");
    assert.ok(Number(receipt.headers["x-ratelimit-remaining"]) > 0);
    assert.equal(Object.hasOwn(receipt.headers, "retry-after"), false);
    assert.ok(Object.keys(receipt.headers).every(key => ["date", "x-github-request-id", "x-ratelimit-resource",
      "x-ratelimit-limit", "x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset", "content-type"].includes(key)));
  }
  assert.equal(index.acquisitionComplete, true);
  assert.equal(index.outcomeEvidenceReady, false);
  assert.equal(remaining.remainingCount, 0);
  assert.equal(rows.filter(row => row.logProbe?.status === "unavailable").length, 1524);
  assert.equal(timeline.snapshots.length, 33);
  assert.ok(timeline.snapshots.every(snapshot => snapshot.metrics["verified-scenarios"] === null));
  assert.ok(timeline.snapshots.every(snapshot => snapshot.provenance.some(receipt =>
    receipt.kind === "reusable-artifact-isolation-index" && receipt.ref === censusDigest(index))));
});

test("portable indexes reconstruct exact predecessor bytes within the unchanged member cap", () => {
  const receipt = readCensusJson(`${reusableArtifactPaths.directory}/portability.json`);
  assert.equal(receipt.fileLimit, 256 * 1024);
  assert.equal(receipt.indexes.length, 2);
  for (const index of receipt.indexes) {
    const manifest = JSON.parse(readFileSync(index.path, "utf8"));
    assert.equal(manifest.kind, "partitioned-census-json");
    const chunks = manifest.parts.map(part => {
      const file = path.join(path.dirname(index.path), part.file);
      const raw = readFileSync(file);
      assert.ok(raw.length <= receipt.fileLimit);
      const chunk = Buffer.from(JSON.parse(gunzipSync(raw).toString("utf8")), "base64");
      assert.equal(sha256(chunk), part.sha256);
      return chunk;
    });
    const decoded = Buffer.concat(chunks);
    assert.equal(decoded.length, index.originalBytes);
    assert.equal(sha256(decoded), index.originalRawSha256);
    assert.equal(sha256(decoded), index.decodedSha256);
    assert.equal(sha256(readFileSync(index.path)), index.partitionManifestRawSha256);
    assert.deepEqual(readCensusJson(index.path), JSON.parse(decoded.toString("utf8")));
  }
});
