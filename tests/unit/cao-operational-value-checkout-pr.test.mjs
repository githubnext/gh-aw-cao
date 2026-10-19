import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessCheckoutReceipt, checkoutOpportunity, checkoutValueModule, scoreCheckoutMetric } from "../../scripts/native-checkout-pr-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidencePath = "docs/operational-value/proof/checkout-pr-dispatch";
const repository = { id: 1036865607, full_name: "github/gh-aw", fork: false };
const contract = readCensusJson(`${evidencePath}/contract.json`);
const profile = contract.sourceProfiles[0];
const sha = "a".repeat(40), hash = "b".repeat(64);
const direct = () => ({ repository, eventName: "pull_request",
  action: "labeled", label: { name: "smoke-checkout-pr-dispatch" },
  pull_request: { number: 42, head: { sha, ref: "feature/pr" } } });
const dispatch = aw => ({ repository, eventName: "workflow_dispatch", inputs: { aw_context: JSON.stringify(aw) } });
const receipt = () => {
  const event = direct();
  return { runId: 42, attempt: 1, event, eventSha256: censusDigest(event),
    lockGitBlob: profile.lockGitBlob, checkerGitBlob: profile.checkerGitBlob,
    sourceVerified: true, policyAdmitted: true, agentStartedAt: "2026-10-17T01:00:01Z",
    expected: { runId: 42, attempt: 1, prNumber: 42, repositoryId: repository.id,
      kind: "original-pr-event-head", receiptSha256: hash, headSha: sha, headRef: "feature/pr" },
    actual: { producer: "protected-pre-agent-git-readback", jobId: 43, runId: 42, attempt: 1,
      receiptSha256: hash, at: "2026-10-17T01:00:00.999Z", headSha: sha, branch: "feature/pr",
      clean: true, initialized: true, originPresent: true, visibleCommits: 1 } };
};

test("checkout trigger inventory covers dispatch, centralized slash, direct PR and PR-comment paths", () => {
  assert.equal(checkoutOpportunity(direct()).triggerClass, "direct-pr");
  assert.equal(checkoutOpportunity(dispatch({ item_type: "pull_request", item_number: "42" })).eligible, true);
  assert.equal(checkoutOpportunity(dispatch({ item_type: "pull_request", item_number: 42,
    command_name: "smoke-checkout-pr-dispatch" })).triggerClass, "centralized-slash-pr-dispatch");
  assert.equal(checkoutOpportunity({ repository, eventName: "issue_comment",
    issue: { number: 42, pull_request: {} } }).triggerClass, "direct-pr-comment");
  assert.equal(checkoutOpportunity({ ...direct(), eventName: "pull_request_review_comment" }).eligible, true);
});

test("checkout no-PR schedules, issue commands and empty dispatches are controls, never proofs", () => {
  for (const event of [{ repository, eventName: "schedule" }, { repository, eventName: "issues" },
    { repository, eventName: "issue_comment", issue: { number: 42 } }, dispatch({}),
    dispatch({ item_type: "issue", item_number: 42 }),
    dispatch({ item_type: "pull_request", item_number: 42, repo: "other/repo" })]) {
    assert.equal(checkoutOpportunity(event).eligible, false);
  }
  assert.equal(checkoutOpportunity({}).eligible, null);
});

test("checkout parser retains historical coercion semantics as a separate source era", () => {
  for (const value of [true, "4.2e1", "0x2a", " 42", 0, -1, 1.5]) {
    assert.equal(checkoutOpportunity(dispatch({ item_type: "pull_request", item_number: value })).eligible, false);
  }
  assert.equal(checkoutOpportunity(dispatch({ item_type: "pull_request", item_number: "4.2e1" }),
    { strictPrNumber: false }).number, 42);
  assert.equal(checkoutOpportunity({ repository, eventName: "workflow_dispatch",
    inputs: { aw_context: "{" } }).eligible, false);
});

test("checkout outcome requires the exact full native conjunction before agent execution", () => {
  const result = assessCheckoutReceipt(receipt(), contract);
  assert.equal(result.headMatches, true);
  assert.equal(result.attained, true);
  for (const [field, value] of [["clean", false], ["initialized", false], ["originPresent", false], ["visibleCommits", 0]]) {
    const row = receipt();
    row.actual[field] = value;
    assert.equal(assessCheckoutReceipt(row, contract).attained, false, field);
  }
});

test("checkout mismatching SHA or ref is a verified miss, not a non-main success", () => {
  for (const [field, value] of [["headSha", "c".repeat(40)], ["branch", "different-feature"]]) {
    const row = receipt();
    row.actual[field] = value;
    const result = assessCheckoutReceipt(row, contract);
    assert.equal(result.headMatches, false);
    assert.equal(result.attained, false);
  }
});

test("checkout retains independent head improvement without erasing missing cleanliness", () => {
  const row = receipt();
  delete row.actual.clean;
  const result = assessCheckoutReceipt(row, contract);
  assert.equal(result.headMatches, true);
  assert.equal(result.attained, null);
  const evidence = { valid: true, assessments: [{ id: "42:1", ...result }] };
  assert.equal(scoreCheckoutMetric("verified-heads", evidence), 1);
  assert.equal(scoreCheckoutMetric("verified-checkouts", evidence), null);
});

test("checkout agent claims, successful job, post-agent readback and unbound source are unknown", () => {
  for (const modify of [
    row => { row.actual.producer = "agent-report"; },
    row => { row.actual.at = "2026-10-17T01:00:02Z"; },
    row => { row.sourceVerified = false; },
    row => { row.policyAdmitted = false; },
    row => { row.actual.attempt = 2; },
    row => { row.expected.prNumber = 99; },
    row => { row.eventSha256 = hash; },
    row => { row.lockGitBlob = "d".repeat(40); },
    row => { delete row.actual; row.runConclusion = "success"; },
    row => { row.expected.headSha = "c".repeat(40); row.actual.headSha = row.expected.headSha; },
  ]) {
    const row = receipt();
    modify(row);
    assert.equal(assessCheckoutReceipt(row, contract).attained, null);
  }
});

test("checkout scoring preserves zero, unknown, no opportunities and duplicates distinctly", () => {
  const evidence = { valid: true, assessments: [{ id: "42:1", eligible: true, attained: false, headMatches: false }] };
  assert.equal(scoreCheckoutMetric("verified-checkouts", evidence), 0);
  evidence.assessments[0].attained = null;
  assert.equal(scoreCheckoutMetric("verified-checkouts", evidence), null);
  assert.equal(scoreCheckoutMetric("verified-checkouts", { valid: true, assessments: [] }), null);
  evidence.assessments.push({ ...evidence.assessments[0] });
  assert.equal(scoreCheckoutMetric("verified-checkouts", evidence), null);
  assert.equal(scoreCheckoutMetric("unknown", {}), null);
});

test("checkout real acquisition exhausts all events and artifacts without treating scheduled controls as evidence", () => {
  const index = readCensusJson(`${evidencePath}/index.json`);
  const rows = readCensusJson(`${evidencePath}/observations.json.gz`);
  assert.equal(index.inventoryComplete, true);
  assert.equal(index.inventoryRuns, 529);
  assert.equal(rows.length, 529);
  assert.equal(new Set(rows.map(row => row.runId)).size, 529);
  assert.deepEqual(index.events, { pull_request: 502, schedule: 27 });
  assert.equal(rows.flatMap(row => row.jobs).length, 2784);
  assert.equal(rows.flatMap(row => row.artifacts).length, 162);
  assert.equal(rows.flatMap(row => row.checkoutSteps).length, 26);
  assert.equal(rows.flatMap(row => row.checkoutSteps).every(row => row.step.conclusion === "skipped"), true);
  assert.equal(rows.every(row => row.receipt === null), true);
  const value = checkoutValueModule();
  const [result] = value.collectBatch([{ windowStart: contract.adoption.adoptedAt,
    windowEnd: contract.until, observedAt: contract.until }]);
  assert.equal(result.evidence.eligibleCount, null);
  assert.equal(result.evidence.unassessedEligibility, 502);
  assert.equal(result.evidence.assessments.filter(row => row.eligible === false).length, 27);
  assert.equal(value.scoreMetric("verified-checkouts", result.evidence), null);
  assert.equal(value.scoreMetric("verified-heads", result.evidence), null);
  assert.equal(index.measurementReady, false);
});

test("checkout retained originals verify native Git hashes for every reviewed source version", () => {
  const manifest = readCensusJson(`${evidencePath}/sources.json.gz`);
  assert.equal(manifest.profiles.length, 227);
  assert.equal(manifest.nativeHistory.length, 11);
  let count = 0;
  for (const part of manifest.parts) {
    const blobs = readCensusJson(`${evidencePath}/${part.file}`);
    assert.equal(censusDigest(blobs), part.sha256);
    for (const blob of blobs) {
      verifyPublicGitBlob(Buffer.from(blob.native, "base64"), blob.id);
      count++;
    }
  }
  assert.equal(count, manifest.sourceCount);
  assert.equal(censusDigest(manifest), contract.sourcesSha256);
});

test("checkout real replay fails closed when acquired evidence disappears or changes", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".cache", "checkout-integrity-"));
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {checkoutValueModule} from ${JSON.stringify(path.join(root, "scripts/native-checkout-pr-value.mjs"))};
     checkoutValueModule().collectBatch([{windowStart:"2026-10-11T15:00:12Z",windowEnd:"2026-10-18T15:00:12Z",observedAt:"2026-10-18T15:00:12Z"}]);`],
  { cwd: temporary, stdio: "pipe" });
  try {
    cpSync(path.join(root, evidencePath), path.join(temporary, evidencePath), { recursive: true });
    run();
    const target = path.join(temporary, evidencePath, "observations.json.gz"), original = readFileSync(target);
    unlinkSync(target);
    assert.throws(run, /ENOENT/);
    writeFileSync(target, original);
    const indexFile = path.join(temporary, evidencePath, "index.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    index.inventoryRuns--;
    writeFileSync(indexFile, JSON.stringify(index));
    assert.throws(run, /integrity mismatch/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
