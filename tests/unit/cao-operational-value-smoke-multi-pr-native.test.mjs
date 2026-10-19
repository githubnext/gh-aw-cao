import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { assessMultiPrCase, multiPrContent, multiPrHostProjection, multiPrOperations, multiPrPatchPayload,
  scanMultiPrEvidence, verifyMultiPrGitObject } from "../../scripts/native-smoke-multi-pr-value.mjs";
import { missedMultiPrFixture, multiPrFixture } from "../../scripts/smoke-multi-pr-fixtures.mjs";
import { additionalMultiPrLogs, multiPrSummaryProjection, nativeMultiPrPatch } from "../../scripts/verify-smoke-multi-pr-deliveries.mjs";
import { assertMultiPrQuotaReady, multiPrAcquisitionStop, multiPrHttpResponse, retainMultiPrHttp } from "../../scripts/collect-smoke-multi-pr-receipts.mjs";
import { collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-multi-pr.mjs";
import { formatMultiPrWrapper, verifyMultiPrFormatting } from "../../scripts/format-smoke-multi-pr-value.mjs";

const context = { until: "2026-10-18T15:00:12Z", reviewedHosts: [], profiles: [{
  workflowGitBlob: "e".repeat(40), taskSha256: "f".repeat(64), era: "crlf",
}] };
const fixture = () => multiPrFixture(context);

test("native multi-PR: formatting preserves exact token lexemes, AST and every original evidence byte", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const receipt = readCensusJson(`${directory}/formatting-equivalence.json`);
  assert.equal(receipt.predecessorSha256, "0ba2ae5905c4dccf126c8728aa375fb7359b1b3f21bee5fda500b5a12124e6af");
  const archive = readCensusJson(receipt.archivePath);
  assert.equal(createHash("sha256").update(readFileSync(receipt.archivePath)).digest("hex"), receipt.archiveSha256);
  assert.equal(archive.functionSha256, receipt.predecessorSha256);
  for (const file of archive.files) {
    const bytes = Buffer.from(file.content, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    if (file.path.startsWith(`${directory}/`)) assert.deepEqual(readFileSync(file.path), bytes);
  }
  const original = Buffer.from(archive.files.find(file => file.path === receipt.modulePath).content, "base64").toString();
  const current = readFileSync(receipt.modulePath, "utf8");
  assert.equal(createHash("sha256").update(original).digest("hex"), receipt.predecessorSha256);
  assert.equal(createHash("sha256").update(current).digest("hex"), receipt.replacementSha256);
  assert.deepEqual(verifyMultiPrFormatting(original, current), {
    astSha256: receipt.astSha256, tokenLexemesSha256: receipt.tokenLexemesSha256, tokens: receipt.tokens,
  });
  assert.equal(formatMultiPrWrapper(original), current);
  assert.equal(formatMultiPrWrapper(current), current);
  assert.ok(current.split("\n").length <= 3000);
  assert.throws(() => verifyMultiPrFormatting(original, current.replace('"verified-payload-deliveries"', '"different"')));
  const timeline = readCensusJson("docs/operational-value/proof/reports/github-gh-aw/smoke-multi-pr-timeline.json");
  assert.equal(timeline.valueFunction.sha256, receipt.replacementSha256);
  const temporary = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-formatting-history-"));
  try {
    const reportDirectory = "docs/operational-value/proof/reports/github-gh-aw";
    for (const file of archive.files.filter(file => file.path.startsWith(`${reportDirectory}/smoke-multi-pr-evidence-archive`))) {
      writeFileSync(path.join(temporary, path.basename(file.path)), Buffer.from(file.content, "base64"));
    }
    const name = "smoke-multi-pr-evidence-archive.json.gz";
    const before = readCensusJson(path.join(temporary, name)), after = readCensusJson(`${reportDirectory}/${name}`);
    for (const [identity, observations] of Object.entries(before.functions)) assert.deepEqual(after.functions[identity], observations);
    assert.ok(before.functions[receipt.predecessorSha256]);
    assert.ok(!before.functions[receipt.replacementSha256]);
    assert.equal(after.functions[receipt.replacementSha256].snapshots.length, 35);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test("native multi-PR: every forbidden, throttled, depleted or Retry-After response stops the reserved batch", () => {
  for (const response of [{ status: 403, headers: {} }, { status: 429, headers: {} },
    { status: 200, headers: { "x-ratelimit-remaining": "0" } },
    { status: 200, headers: { "retry-after": "0", "x-ratelimit-remaining": "100" } }]) {
    assert.equal(multiPrAcquisitionStop(response), true);
  }
  assert.equal(multiPrAcquisitionStop({ status: 404, headers: {} }), false);
  assert.equal(multiPrAcquisitionStop({ status: 200, headers: { "x-ratelimit-remaining": "100" } }), false);
});
test("native multi-PR: protected message enumeration distinguishes two delivered PR requests from an absent summary request", () => {
  const step = { status: "completed", conclusion: "success", started_at: "2026-10-17T00:37:08Z", completed_at: "2026-10-17T00:37:26Z" };
  const messages = ["Found 3 message(s) in agent output", "Processing 3 message(s) in order of appearance...",
    "Processing message 1/3: create_pull_request", "Processing message 2/3: create_pull_request",
    "Processing message 3/3: noop", "##[warning]Unable to determine issue/PR number for append-only comment; skipping",
    "Safe Output Handler Manager completed"];
  const text = messages.map(message => `2026-10-17T00:37:10.000Z ${message}`).join("\n")
    + "\n2026-10-17T00:38:00.000Z Processing message 4/4: add_comment";
  const projection = multiPrSummaryProjection(text, step);
  assert.equal(projection.completeMessageEnumeration, true);
  assert.deepEqual(projection.processedTypes, ["create_pull_request", "create_pull_request", "noop"]);
  assert.equal(projection.commentRequests, 0);
  assert.equal(projection.missingTriggerCommentWarnings, 1);
  assert.deepEqual(projection.candidateCommentUrls, []);
  assert.equal(multiPrSummaryProjection(`${text}\n2026-10-17T00:37:10.000Z Processing message 3/3: add_comment`, step).commentRequests, null);
  assert.equal(multiPrSummaryProjection(text, { ...step, conclusion: "failure" }).completeMessageEnumeration, false);
});
test("native multi-PR: reserved log acquisition requires cached public repository metadata before reading target content", async () => {
  const cache = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-public-"));
  try {
    const endpoint = "repos/github/gh-aw", file = path.join(cache, `${createHash("sha256").update(endpoint).digest("hex")}.json`);
    for (const metadata of [{ id: 1036865607, full_name: "github/gh-aw", private: true, visibility: "private" },
      { id: 1036865607, full_name: "github/gh-aw", private: false },
      { id: 1, full_name: "github/gh-aw", private: false, visibility: "public" }]) {
      writeFileSync(file, JSON.stringify(metadata));
      await assert.rejects(additionalMultiPrLogs(cache, true), /Public repository authority is not established/);
    }
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
test("native multi-PR: a reserved endpoint mutation is rejected before any acquisition", async () => {
  const cwd = process.cwd(), directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const temporary = mkdtempSync(path.join(cwd, ".smoke-multi-pr-native-reservation-")), cache = path.join(temporary, "cache");
  try {
    mkdirSync(cache);
    mkdirSync(path.join(temporary, directory), { recursive: true });
    for (const name of readdirSync(directory).filter(name =>
      ["receipts", "inventory", "additional-protected-jobs"].some(prefix => name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}-`)))) {
      cpSync(path.join(cwd, directory, name), path.join(temporary, directory, name));
    }
    const endpoint = "repos/github/gh-aw";
    writeFileSync(path.join(cache, `${createHash("sha256").update(endpoint).digest("hex")}.json`),
      JSON.stringify({ id: 1036865607, full_name: "github/gh-aw", private: false, visibility: "public" }));
    process.chdir(temporary);
    const reserved = readCensusJson(`${directory}/additional-protected-jobs.json.gz`);
    reserved.rows[0].endpoint = "repos/github/gh-aw/actions/jobs/1/logs";
    writeCensusJson(`${directory}/additional-protected-jobs.json.gz`, reserved);
    await assert.rejects(additionalMultiPrLogs(cache, true), /Reserved public log endpoints changed/);
  } finally {
    process.chdir(cwd);
    rmSync(temporary, { recursive: true, force: true });
  }
});
test("native multi-PR: preserve actual quota/reset headers without retaining cookies, redirects or credentials", () => {
  const response = multiPrHttpResponse(Buffer.concat([
    Buffer.from("HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1792392948\r\nRetry-After: 60\r\n"
      + "Set-Cookie: not-retained\r\nLocation: not-retained\r\nAuthorization: not-retained\r\n\r\n"),
    Buffer.from([0, 255, 13, 10, 80, 75]),
  ]));
  assert.deepEqual(response.responses, [{ status: 403, headers: {
    "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792392948", "retry-after": "60",
  } }]);
  assert.deepEqual(response.body, Buffer.from([0, 255, 13, 10, 80, 75]));
  assert.equal(multiPrHttpResponse("HTTP/2.0 200 OK\nDate: fixture\n\nbody\r\n\r\n").body.toString(), "body\r\n\r\n");
  assert.throws(() => multiPrHttpResponse("body without headers"), /Missing native/);
});
test("native multi-PR: persisted Retry-After prevents another uncached request without a new rate-limit probe", () => {
  const cache = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-quota-"));
  try {
    retainMultiPrHttp(cache, "repos/github/gh-aw/actions/jobs/1/logs",
      "HTTP/2.0 429 Too Many Requests\nRetry-After: 600\n\nquota");
    assert.throws(() => assertMultiPrQuotaReady(cache), /honor retained GitHub quota/);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
test("native multi-PR: a shorter response cannot replace a longer retained quota hold", () => {
  const cache = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-quota-"));
  try {
    const endpoint = "repos/github/gh-aw/actions/jobs/1/logs";
    retainMultiPrHttp(cache, endpoint, "HTTP/2.0 429 Too Many Requests\nRetry-After: 600\n\nquota");
    const original = readFileSync(path.join(cache, "api-pause.json"), "utf8");
    retainMultiPrHttp(cache, endpoint, "HTTP/2.0 429 Too Many Requests\nRetry-After: 5\n\nquota");
    assert.equal(readFileSync(path.join(cache, "api-pause.json"), "utf8"), original);
    retainMultiPrHttp(cache, endpoint, "HTTP/2.0 429 Too Many Requests\nRetry-After: 1200\n\nquota");
    assert.ok(Date.parse(JSON.parse(readFileSync(path.join(cache, "api-pause.json"))).retryNotBefore)
      > Date.parse(JSON.parse(original).retryNotBefore));
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
test("native multi-PR: malformed persisted quota state fails closed without silently overwriting it", () => {
  const cache = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-quota-"));
  try {
    for (const retryNotBefore of [null, "not-a-date", "2026-10-19", "2026-02-30T00:00:00.000Z"]) {
      const original = JSON.stringify({ retryNotBefore });
      writeFileSync(path.join(cache, "api-pause.json"), original);
      assert.throws(() => assertMultiPrQuotaReady(cache), /Invalid persisted GitHub quota pause/);
      assert.throws(() => retainMultiPrHttp(cache, "repos/github/gh-aw/actions/jobs/1/logs",
        "HTTP/2.0 429 Too Many Requests\nRetry-After: 60\n\nquota"), /Invalid persisted GitHub quota pause/);
      assert.equal(readFileSync(path.join(cache, "api-pause.json"), "utf8"), original);
    }
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
test("native multi-PR: original allowlisted failure headers survive a later successful retry", () => {
  const cache = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-quota-"));
  try {
    const endpoint = "repos/github/gh-aw/actions/jobs/1/logs";
    retainMultiPrHttp(cache, endpoint,
      "HTTP/2.0 403 Forbidden\nRetry-After: 60\nSet-Cookie: never-retain\nAuthorization: never-retain\n\nquota");
    retainMultiPrHttp(cache, endpoint, "HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 100\n\nlog");
    const files = readdirSync(path.join(cache, "quota-receipts"));
    assert.equal(files.length, 1);
    const receipt = JSON.parse(readFileSync(path.join(cache, "quota-receipts", files[0])));
    assert.equal(receipt.endpoint, endpoint);
    assert.deepEqual(receipt.responses, [{ status: 403, headers: { "retry-after": "60" } }]);
    assert.equal(JSON.stringify(receipt).includes("never-retain"), false);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});
test("native multi-PR: two independent intended branch payloads, including preserved CRLF", () => {
  const { evidence, context } = fixture();
  assert.deepEqual(scanMultiPrEvidence(evidence, context), { "verified-payload-deliveries": 2,
    "verified-crlf-deliveries": 1, "unassessed-payload-cases": 0, candidateCases: 2, provenCases: 2, assessedCases: 2 });
});
test("native multi-PR: a known wrong delivered payload is distinct from an unknown sibling", () => {
  const { evidence, context } = fixture();
  const result = scanMultiPrEvidence(missedMultiPrFixture(evidence), context);
  assert.equal(result["verified-payload-deliveries"], 0);
  assert.equal(result["verified-crlf-deliveries"], 0);
  assert.equal(result["unassessed-payload-cases"], 1);
});
test("native multi-PR: missing candidate-case evidence is never a zero delivery result", () => {
  const { evidence, context } = fixture();
  evidence.observations[0].cases = [];
  assert.equal(scanMultiPrEvidence(evidence, context)["verified-payload-deliveries"], null);
  assert.equal(scanMultiPrEvidence({ valid: true, observations: [] }, context)["verified-payload-deliveries"], null);
  assert.equal(scanMultiPrEvidence({ valid: false }, context), null);
  assert.equal(scanMultiPrEvidence({ valid: true, observations: "bad" }, context), null);
});
test("native multi-PR: duplicate observations/cases fail closed", () => {
  const { evidence, context } = fixture();
  evidence.observations.push(evidence.observations[0]);
  assert.equal(scanMultiPrEvidence(evidence, context), null);
  evidence.observations.pop();
  evidence.observations[0].cases.push(evidence.observations[0].cases[0]);
  assert.equal(scanMultiPrEvidence(evidence, context), null);
});
for (const [name, change] of [
  ["PR existence", fact => { delete fact.target; }],
  ["unbound head", fact => { fact.operation.proof.head = "0".repeat(40); }],
  ["unreviewed source", fact => { fact.source.workflowGitBlob = "0".repeat(40); }],
  ["mixed host identity", fact => { fact.source.checkout = "0".repeat(40); }],
  ["wrong artifact digest", fact => { fact.payload.providerDigest = "bad"; }],
  ["missing artifact producer", fact => { delete fact.payload.producer; }],
  ["mixed artifact producer", fact => { fact.payload.producer.job.run_attempt = 2; }],
  ["unreviewed upload source", fact => { fact.payload.producer.uploadStepSha256 = "0".repeat(64); }],
  ["artifact outside upload step", fact => { fact.payload.producer.artifactCreatedAt = "2026-10-16T11:00:00Z"; }],
  ["wrong run", fact => { fact.payload.runId = 2; }],
  ["wrong protected step", fact => { fact.operation.step.name = "Agent says PASS"; }],
  ["missing branch receipt", fact => { fact.operation.lines = fact.operation.lines.slice(2); }],
  ["out-of-step receipt", fact => { fact.operation.lines[0].at = "2026-10-16T11:00:00Z"; }],
]) {
  test(`native multi-PR: ${name} is not proof`, () => {
    const { evidence, context } = fixture(), row = evidence.observations[0];
    change(row.cases[0]);
    assert.equal(assessMultiPrCase(row, "doc", context).status, "unknown");
    assert.equal(scanMultiPrEvidence(evidence, context)["verified-payload-deliveries"], 1);
  });
}
test("native multi-PR: reruns do not duplicate initial payload credit", () => {
  const { evidence, context } = fixture();
  evidence.observations[0].run.attempt = 2;
  assert.equal(scanMultiPrEvidence(evidence, context)["verified-payload-deliveries"], null);
});
test("native multi-PR: raw Git corruption throws instead of disappearing into missing evidence", () => {
  const { evidence, context } = fixture();
  evidence.observations[0].cases[0].target.blob.content = Buffer.from("bad").toString("base64");
  assert.throws(() => scanMultiPrEvidence(evidence, context), /Git object digest/);
  assert.throws(() => verifyMultiPrGitObject({ id: "a".repeat(40), content: "!!!" }, "tree"), /digest/);
});
test("native multi-PR: protected-log projection denies self-reports, patch previews and out-of-step lines", () => {
  const { evidence } = fixture(), { operation } = evidence.observations[0].cases[0];
  const text = operation.lines.map(line => `${line.at} ${line.message}`).join("\n")
    + "\n2026-10-16T12:01:10Z +Created pull request #99: https://github.com/github/gh-aw/pull/99"
    + "\n2026-10-16T12:01:11Z Agent says two PRs are good"
    + "\n2026-10-16T11:01:12Z Created pull request #99: https://github.com/github/gh-aw/pull/99";
  assert.equal(multiPrHostProjection(text, operation.step).length, operation.lines.length);
  assert.equal(multiPrOperations(multiPrHostProjection(text, operation.step)).length, 1);
});
test("native multi-PR: source-era LF configuration is not silently a CRLF test", () => {
  assert.equal(multiPrContent(1, "config", Buffer.from("Configuration smoke test for multi-PR workflow\nRun ID: 1\nCreated at: 2026-10-16T12:00:30Z\nPR: 2 of 2\n")), true);
  assert.equal(multiPrContent(1, "crlf", Buffer.from("Configuration smoke test for multi-PR workflow\nRun ID: 1\nCreated at: 2026-10-16T12:00:30Z\nPR: 2 of 2\n")), false);
});
test("native multi-PR: literal and native printf expansion preserve all carriage returns", () => {
  const head = "CRLF smoke test for multi-PR workflow\r\nRun ID: 1\r\nCreated at: 2026-10-16T12:00:30Z\r\nPR: 2 of 2\r\n";
  for (const tail of ["Line ending: CRLF (Windows-style \\r\\n)\r\n", "Line ending: CRLF (Windows-style \r\n)\r\n"]) {
    assert.equal(multiPrContent(1, "crlf", Buffer.from(head + tail)), true);
    assert.equal(multiPrContent(1, "crlf", Buffer.from((head + tail).replaceAll("\r", ""))), false);
  }
});
test("native multi-PR: independent native Git application agrees byte-for-byte", () => {
  const { evidence } = fixture(), fact = evidence.observations[0].cases[1];
  const root = mkdtempSync(path.join(process.cwd(), ".smoke-multi-pr-native-test-"));
  try {
    const result = nativeMultiPrPatch(root, Buffer.from(fact.payload.patchBase64, "base64"), "tmp-smoke-multi-pr-crlf-1-2.txt");
    assert.equal(result.appliedPayloadSha256, fact.payload.appliedPayloadSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("native multi-PR: missing newline, wrong filename and extra diff are not exact payloads", () => {
  const { evidence } = fixture(), fact = evidence.observations[0].cases[1];
  const bytes = Buffer.from(fact.payload.patchBase64, "base64");
  assert.equal(multiPrPatchPayload(bytes, "tmp-smoke-multi-pr-doc-1-1.txt"), null);
  assert.equal(multiPrPatchPayload(Buffer.concat([bytes, Buffer.from("\ndiff --git a/b b/b\n")]), "tmp-smoke-multi-pr-crlf-1-2.txt"), null);
});
test("native multi-PR: real acquired evidence must survive with its source/original/target identities", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const contract = readCensusJson(`${directory}/contract.json`), deliveries = readCensusJson(`${directory}/deliveries.json.gz`);
  const sources = readCensusJson(`${directory}/host-sources.json.gz`);
  assert.equal(deliveries.contractSha256, censusDigest(contract));
  assert.equal(deliveries.sourceObjectsSha256, censusDigest(sources));
  for (const source of sources) {
    const bytes = Buffer.from(source.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlob);
  }
  const retainedContract = readCensusJson(`${directory}/contracts.json`)[0];
  assert.ok(retainedContract.reviewedHosts.includes("21726a88ec0086db73c0ca062f2f4e72bdea1b81248763c6e1eabcbc96686565"));
  const real = scanMultiPrEvidence({ valid: true, observations: deliveries.rows }, retainedContract);
  assert.ok(real["verified-payload-deliveries"] >= 2);
  assert.ok(real["verified-crlf-deliveries"] >= 1);
  assert.equal(deliveries.rows.length, 2365);
});
test("native multi-PR: production collector uses explicit independent receipt periods and never falls back through gaps", () => {
  const requests = [
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-17T00:37:00Z", windowEnd: "2026-10-17T00:38:00Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-19T00:00:00Z", windowEnd: "2026-10-20T00:00:00Z", observedAt: "2026-10-20T00:00:00Z" },
    { windowStart: "2026-10-17T02:37:00+02:00", windowEnd: "2026-10-17T02:38:00+02:00", observedAt: "2026-10-18T15:00:12Z" },
  ];
  const results = collectBatch(requests, {});
  assert.ok(scoreMetric("verified-payload-deliveries", results[0].evidence) >= 2);
  assert.equal(scoreMetric("verified-payload-deliveries", results[1].evidence), 2);
  assert.equal(results[0].evidence.eligibleCount, null);
  assert.equal(results[0].evidence.coverageStatus, "partial");
  assert.equal(scoreMetric("verified-payload-deliveries", results[2].evidence), null);
  assert.equal(results[2].evidence.coverageStatus, "missing");
  assert.equal(scoreMetric("verified-payload-deliveries", results[3].evidence), 2);
  assert.throws(() => collectBatch([{ ...requests[0], repository: "another/repository" }]), /repository/);
  assert.throws(() => collectBatch([{ ...requests[0], windowEnd: requests[0].windowStart }]), /period/);
});
test("native multi-PR: real wrong annotations are not misreported as carriage-return corruption or erased sibling value", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const rows = readCensusJson(`${directory}/deliveries.json.gz`).rows;
  const contract = readCensusJson(`${directory}/contracts.json`)[0];
  for (const id of [33345208226, 33933398302]) {
    const row = rows.find(row => row.run.id === id), fact = row.cases.find(fact => fact.kind === "crlf");
    const bytes = Buffer.from(fact.target.blob.content, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fact.payload.appliedPayloadSha256);
    assert.ok(bytes.includes(Buffer.from("\r\n")));
    assert.equal(multiPrContent(id, "crlf", bytes), false);
    assert.equal(assessMultiPrCase(row, "crlf", contract).correct, false);
    assert.equal(scanMultiPrEvidence({ valid: true, observations: [row] }, contract)["verified-payload-deliveries"], 1);
  }
});
test("native multi-PR: retained summary gaps replay from approved native dispatcher source rather than agent claims", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const rows = readCensusJson(`${directory}/deliveries.json.gz`).rows;
  const review = readCensusJson(`${directory}/source-review.json.gz`);
  for (const row of rows.filter(row => row.host?.summaryEvidence)) {
    const approval = review.hostReviews.find(item => item.profile === row.host.profileId);
    const manager = approval.closure.find(item => item.path === "actions/setup/js/safe_output_handler_manager.cjs");
    const original = review.sources.find(item => item.gitBlob === manager.gitBlob);
    const source = verifyMultiPrGitObject({ id: original.gitBlob, content: original.content }, "blob").toString();
    assert.ok(source.includes("Processing message ${i + 1}/${messages.length}: ${messageType}"));
    const text = row.host.summaryEvidence.lines.map(line => `${line.at} ${line.message}`).join("\n");
    assert.deepEqual(multiPrSummaryProjection(text, row.host.step), row.host.summaryEvidence);
  }
  const actual = rows.find(row => row.run.id === 38986848365).host.summaryEvidence;
  assert.equal(actual.completeMessageEnumeration, true);
  assert.deepEqual(actual.processedTypes, ["create_pull_request", "create_pull_request", "noop"]);
  assert.equal(actual.commentRequests, 0);
  assert.equal(actual.missingTriggerCommentWarnings, 2);
  assert.deepEqual(actual.candidateCommentUrls, []);
});
test("native multi-PR: the complete reserved batch preserves actual unavailability without manufacturing outcome zeros", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const additional = readCensusJson(`${directory}/additional-protected-jobs.json.gz`);
  assert.equal(additional.rows.length, 188);
  assert.equal(additional.acquisitionOpen, false);
  assert.deepEqual(additional.httpStatusCounts, { 404: 9, 410: 179 });
  for (const row of additional.rows) {
    assert.equal(row.availability, "http-404-or-410");
    assert.equal(row.logSha256, null);
    assert.equal(row.responseReceipt.endpoint, row.endpoint);
    assert.equal(row.responseReceipt.responses.at(-1).status, row.httpStatus);
    for (const response of row.responseReceipt.responses) {
      assert.ok(Object.keys(response.headers).every(key => ["date", "x-ratelimit-limit", "x-ratelimit-remaining",
        "x-ratelimit-reset", "retry-after", "x-github-request-id"].includes(key)));
      assert.equal(multiPrAcquisitionStop(response), false);
    }
  }
  const index = readCensusJson(`${directory}/index.json`);
  assert.equal(index.acquisitionOpen, false);
  assert.equal(index.coverageStatus, "partial");
  assert.ok(index["verified-payload-deliveries"] >= 44);
  assert.ok(index["unassessed-payload-cases"] > 0);
});
test("native multi-PR: disjoint plotted periods reconcile exactly without duplicated native deliveries", () => {
  const directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const contract = readCensusJson(`${directory}/contracts.json`)[0], index = readCensusJson(`${directory}/index.json`);
  const timeline = readCensusJson("docs/operational-value/proof/reports/github-gh-aw/smoke-multi-pr-timeline.json");
  const delivered = new Set(), crlf = new Set();
  assert.equal(timeline.snapshots.length, 35);
  for (const [periodIndex, snapshot] of timeline.snapshots.entries()) {
    if (periodIndex) assert.equal(snapshot.window.startAt, timeline.snapshots[periodIndex - 1].window.endAt);
    const values = scanMultiPrEvidence(snapshot.evidence, contract);
    for (const [id, value] of Object.entries(snapshot.metrics)) assert.equal(value, values[id]);
    for (const row of snapshot.evidence.observations) for (const kind of row.windowCases) {
      const assessment = assessMultiPrCase(row, kind, contract);
      if (assessment.status !== "assessed" || !assessment.correct) continue;
      assert.ok(Date.parse(assessment.at) >= Date.parse(snapshot.window.startAt)
        && Date.parse(assessment.at) < Date.parse(snapshot.window.endAt));
      delivered.add(`${row.run.id}:${kind}`);
      if (kind === "crlf") crlf.add(`${row.run.id}:${kind}`);
    }
  }
  assert.equal(delivered.size, index["verified-payload-deliveries"]);
  assert.equal(crlf.size, index["verified-crlf-deliveries"]);
  assert.equal(timeline.snapshots.reduce((sum, row) => sum + (row.metrics["verified-payload-deliveries"] ?? 0), 0), delivered.size);
  assert.equal(timeline.snapshots.reduce((sum, row) => sum + (row.metrics["verified-crlf-deliveries"] ?? 0), 0), crlf.size);
  assert.ok(delivered.size >= 44 && crlf.size >= 21);
});
test("native multi-PR: a delivery exactly on a period boundary is credited once, not as repeated retained state", () => {
  const rows = readCensusJson("docs/operational-value/proof/smoke-multi-pr-native/deliveries.json.gz").rows;
  const proof = rows.find(row => row.run.id === 38986848365).cases[0].operation.proof;
  const instant = Date.parse(proof.at);
  const results = collectBatch([
    { windowStart: new Date(instant - 1).toISOString(), windowEnd: proof.at },
    { windowStart: proof.at, windowEnd: new Date(instant + 1).toISOString() },
  ]);
  assert.equal(scoreMetric("verified-payload-deliveries", results[0].evidence), null);
  assert.equal(scoreMetric("verified-payload-deliveries", results[1].evidence), 1);
  assert.equal(results[1].evidence.candidateCaseCount, 1);
});
test("native multi-PR: production acquisition gate fails closed when a preserved original disappears or changes", () => {
  const cwd = process.cwd(), directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const root = mkdtempSync(path.join(cwd, ".smoke-multi-pr-native-gate-"));
  const request = { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" };
  try {
    cpSync(path.join(cwd, directory), path.join(root, directory), {
      recursive: true, filter: file => !file.split(path.sep).includes("versions"),
    });
    process.chdir(root);
    const file = `${directory}/host-sources.json.gz`, original = readFileSync(file);
    rmSync(file);
    assert.throws(() => collectBatch([request], {}), /ENOENT|missing|not found/);
    writeFileSync(file, original);
    const corrupted = Buffer.from(original);
    corrupted[Math.floor(corrupted.length / 2)] ^= 1;
    writeFileSync(file, corrupted);
    assert.throws(() => collectBatch([request], {}));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
test("native multi-PR: every preserved predecessor independently reproduces its established native payload values", async () => {
  const cwd = process.cwd(), directory = "docs/operational-value/proof/smoke-multi-pr-native";
  const versions = readdirSync(`${directory}/versions`);
  assert.ok(versions.includes("fa21e37983d185529f82a8d21b389462fe2b17cc6c46518ae574fde3df4c75e2"));
  for (const version of versions) {
    const archive = readCensusJson(`${directory}/versions/${version}/archive.json.gz`);
    const root = mkdtempSync(path.join(cwd, ".smoke-multi-pr-native-predecessor-"));
    try {
      for (const dependency of ["scripts/operational-value-census-io.mjs", ".github/skills/add-operational-value/scripts/json-archive.mjs"]) {
        mkdirSync(path.dirname(path.join(root, dependency)), { recursive: true });
        writeFileSync(path.join(root, dependency), readFileSync(path.join(cwd, dependency)));
      }
      for (const file of archive.files) {
        assert.equal(path.posix.normalize(file.path), file.path);
        assert.ok(!path.isAbsolute(file.path) && !file.path.startsWith("../"));
        const bytes = Buffer.from(file.content, "base64");
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
        mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
        writeFileSync(path.join(root, file.path), bytes);
      }
      const modulePath = path.join(root, "docs/operational-value/proof/functions/smoke-multi-pr.mjs");
      assert.equal(createHash("sha256").update(readFileSync(modulePath)).digest("hex"), version);
      assert.equal(archive.functionSha256, version);
      process.chdir(root);
      const module = await import(pathToFileURL(modulePath).href);
      const [result] = module.collectBatch([{ windowStart: "2026-02-21T00:00:00Z", windowEnd: "2026-10-18T15:00:12Z" }]);
      assert.equal(module.scoreMetric("verified-payload-deliveries", result.evidence), archive.values.verifiedPayloads);
      assert.equal(module.scoreMetric("verified-crlf-deliveries", result.evidence), archive.values.verifiedCrlf);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
