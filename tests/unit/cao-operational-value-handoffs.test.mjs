import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectHandoffs, projectAssignmentAudit, projectTimeline, summarizeHandoffs } from "../../scripts/trace-file-diet-handoffs.mjs";
import { readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const repository = "github/gh-aw";
const at = "2026-10-01T22:30:11Z";
const proofFile = fileURLToPath(new URL("../../docs/operational-value/proof/file-diet-handoffs.json.gz", import.meta.url));

test("request comments, actual assignments, connections and Copilot work are separate evidence stages", () => {
  const events = projectTimeline([
    { event: "commented", created_at: at, body: "Issue Monster selected this for Copilot", html_url: "comment" },
    { event: "assigned", created_at: at, actor: { login: "not-retained", type: "User" },
      assignee: { login: "Copilot", type: "Bot" } },
    { event: "connected", created_at: at, subject: { number: 64854, title: "Split",
      type: "pull_request", repository: { full_name: repository } } },
    { event: "copilot_work_started", created_at: at },
    { event: "copilot_work_finished", created_at: at },
  ], repository);
  assert.equal(events[0].assignmentRequested, true);
  assert.equal(events[0].assigneeRole, undefined);
  assert.equal(events[1].assigneeRole, "copilot");
  assert.equal(events[1].actorRole, "user-account");
  assert.equal(JSON.stringify(events).includes("not-retained"), false);
  assert.equal(events[2].target.number, 64854);
  assert.equal(events[2].target.kind, "pull-request");
  assert.deepEqual(events.slice(3).map(event => event.type), ["copilot_work_started", "copilot_work_finished"]);
  assert.throws(() => projectTimeline([{ event: "assigned" }], repository), /timestamp/);
});

test("green workflow and zero gateway errors cannot convert a queued assignment into successful execution", () => {
  const audit = { overview: { run_id: 1, conclusion: "success" },
    metrics: { error_count: 0 }, mcp_server_health: { total_errors: 0 } };
  const requests = '{"type":"assign_to_agent","issue_number":64770,"agent":"copilot"}\n';
  const log = `${at} Agent assignment failed for copilot on issue #64770 due to authentication/permission error. Skipping due to ignore-if-error=true.\n`
    + `${at} Error details: Bad credentials - https://docs.github.com/rest\n`;
  const result = projectAssignmentAudit(audit, requests, log, 64770);
  assert.equal(result.workflowConclusion, "success");
  assert.equal(result.assignmentStatus, "failed");
  assert.equal(result.errors[0].cause, "bad-credentials");
  assert.equal(result.errors[0].ignored, true);
  assert.equal(projectAssignmentAudit(audit, requests, "", 64770).assignmentStatus, "unverified");
  assert.equal(projectAssignmentAudit(audit, requests, log, 999).assignmentStatus, "unverified");
});

test("automatic expiry requires an explicit explanation, not a NOT_PLANNED state inference", () => {
  const body = "This issue was automatically closed because it expired on 2026-10-03T12:59:16.943Z.";
  const [event] = projectTimeline([{ event: "commented", created_at: "2026-10-03T14:19:21Z",
    body, performed_via_github_app: { slug: "github-actions" } }], repository);
  assert.equal(event.expiry, "2026-10-03T12:59:16.943Z");
  assert.equal(event.expiryExplanation, body);
  assert.equal(event.assignmentRequested, false);
});

test("the real cohort has 44 selection claims, one observed assignment, one directly connected unmerged PR and seven expirations", () => {
  const proof = readCensusJson(proofFile);
  const original = new URL("../../docs/operational-value/proof/file-diet.json.gz", import.meta.url);
  assert.equal(proof.sourceProofSha256, createHash("sha256").update(readFileSync(original)).digest("hex"));
  const summary = summarizeHandoffs(proof);
  assert.deepEqual(summary.map(item => item.requestedAssignmentComments), [6, 3, 12, 10, 0, 0, 13]);
  assert.deepEqual(summary.map(item => item.copilotAssignments), [0, 0, 0, 1, 0, 0, 0]);
  assert.ok(summary.every(item => item.complete && item.automaticExpiryComments === 1));
  assert.equal(proof.pullRequests.length, 1);
  const pull = proof.pullRequests[0];
  assert.equal(pull.creatorRole, "copilot");
  assert.equal(pull.mergedAt, null);
  assert.equal(pull.checks.complete, true);
  assert.ok(pull.checks.items.every(item => item.headSha === pull.headSha));
  assert.deepEqual(pull.checks.items.filter(item => item.conclusion === "failure").map(item => item.name).sort(),
    ["Unit tests (A-C)", "Unit tests (D-G)", "Unit tests (N-R)"]);
  assert.equal(proof.assignmentAudits.length, 2);
  assert.ok(proof.assignmentAudits.every(item => item.assignmentStatus === "failed"
    && item.workflowConclusion === "success" && item.agentErrorCount === 0 && item.gatewayErrorCount === 0));
  const failures = summary.find(item => item.issue === 62653);
  assert.equal(failures.linkedAssignmentFailureReports, 3);
  assert.equal(failures.currentBodyMatchedFailureReports, 0);
});

test("bounded timeline acquisition marks truncation rather than inventing complete negative evidence", () => {
  let calls = 0;
  const proof = collectHandoffs({ study: { repository, workflow: "daily-file-diet" },
    candidates: [{ number: 1, runId: "1" }] }, () => {
    calls++;
    return Array.from({ length: 100 }, () => ({ event: "labeled" }));
  });
  assert.equal(calls, 3);
  assert.equal(proof.issues[0].timeline.complete, false);
  assert.equal(summarizeHandoffs(proof)[0].complete, false);
});
