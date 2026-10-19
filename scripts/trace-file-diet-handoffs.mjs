import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowReference } from "./trace-operational-outcomes.mjs";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const agentRole = value => /^copilot(?:-swe-agent)?(?:\[bot\])?$/i.test(value?.login ?? "")
  ? "copilot" : value?.type === "Bot" ? "other-bot" : value?.type === "User" ? "user-account" : "unknown";

export function projectTimeline(rows, repository) {
  assert.ok(Array.isArray(rows));
  return rows.flatMap(row => {
    const kinds = ["assigned", "unassigned", "connected", "disconnected", "cross-referenced",
      "copilot_work_started", "copilot_work_finished", "closed", "reopened", "merged", "commented"];
    if (!kinds.includes(row.event)) return [];
    assert.ok(instant(row.created_at), `Missing ${row.event} timestamp`);
    const event = { type: row.event, at: row.created_at, actorRole: agentRole(row.actor),
      app: row.performed_via_github_app?.slug ?? null };
    if (["assigned", "unassigned"].includes(row.event)) event.assigneeRole = agentRole(row.assignee);
    const subject = row.subject ?? row.source?.issue;
    if (subject) {
      const owner = subject.repository?.full_name
        ?? subject.repository_url?.replace("https://api.github.com/repos/", "");
      if (owner === repository) event.target = {
        number: subject.number, title: subject.title,
        kind: subject.type === "pull_request" || subject.pull_request ? "pull-request" : "issue",
      };
    }
    if (row.event === "commented") {
      assert.equal(typeof row.body, "string");
      event.bodySha256 = sha256(row.body);
      event.url = row.html_url;
      event.workflowReference = parseWorkflowReference(row.body, repository);
      event.assignmentRequested = /Issue Monster selected this for Copilot/.test(row.body);
      event.expiry = row.body.match(/^This issue was automatically closed because it expired on ([^\s]+)\./)?.[1] ?? null;
      if (event.expiry) {
        assert.ok(instant(event.expiry));
        event.expiryExplanation = row.body.split("\n")[0];
      }
      if (!event.assignmentRequested && !event.expiry && !event.workflowReference) return [];
    }
    return [event];
  });
}

export function summarizeHandoffs(proof) {
  return proof.issues.map(issue => {
    const targets = new Set(issue.timeline.events.filter(event => event.target?.kind === "pull-request")
      .map(event => event.target.number));
    const pulls = proof.pullRequests.filter(pull => targets.has(pull.number));
    return {
      issue: issue.number, complete: issue.timeline.complete,
      requestedAssignmentComments: issue.timeline.events.filter(event => event.assignmentRequested).length,
      copilotAssignments: issue.timeline.events.filter(event => event.type === "assigned" && event.assigneeRole === "copilot").length,
      automaticExpiryComments: issue.timeline.events.filter(event => event.expiry && event.app === "github-actions").length,
      linkedAssignmentFailureReports: new Set(issue.timeline.events.filter(event => event.target?.kind === "issue"
        && /Issue Monster failed to assign agent/.test(event.target.title)).map(event => event.target.number)).size,
      currentBodyMatchedFailureReports: proof.failureReports.filter(report => report.errors.some(error => error.issue === issue.number)).length,
      pullRequests: pulls.map(pull => ({ number: pull.number, state: pull.state, mergedAt: pull.mergedAt,
        creatorRole: pull.creatorRole, complete: pull.timeline.complete,
        workStarted: pull.timeline.events.filter(event => event.type === "copilot_work_started").length,
        workFinished: pull.timeline.events.filter(event => event.type === "copilot_work_finished").length })),
    };
  });
}

export function projectAssignmentAudit(audit, requests, jobLog, issue) {
  assert.ok(Number.isSafeInteger(issue) && issue > 0);
  const queued = requests.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(item => item.type === "assign_to_agent" && item.issue_number === issue)
    .map(item => ({ type: item.type, issue: item.issue_number, agent: item.agent }));
  const lines = jobLog.split("\n");
  const errors = lines.flatMap((line, index) => {
    if (!line.includes(`Agent assignment failed for copilot on issue #${issue} `)
      || !line.includes("Skipping due to ignore-if-error=true")) return [];
    return [{ at: line.split(" ")[0], cause: lines.slice(index + 1, index + 3)
      .some(item => item.includes("Error details: Bad credentials")) ? "bad-credentials" : "authentication-or-permission",
    ignored: true }];
  });
  return { runId: audit.overview.run_id, issue, workflowConclusion: audit.overview.conclusion,
    agentErrorCount: audit.metrics.error_count, gatewayErrorCount: audit.mcp_server_health.total_errors,
    queued, errors, assignmentStatus: queued.length && errors.length ? "failed" : "unverified",
    requestsSha256: sha256(requests), jobLogSha256: sha256(jobLog), observedAt: new Date().toISOString() };
}

export function collectHandoffs(cohort, request) {
  const repository = cohort.study.repository;
  assert.equal(repository, "github/gh-aw");
  assert.equal(cohort.study.workflow, "daily-file-diet");
  assert.ok(cohort.candidates.length <= 10);
  const timeline = number => {
    const rows = [];
    let complete = false;
    let pages = 0;
    for (let page = 1; page <= 3; page++) {
      const batch = request(`repos/${repository}/issues/${number}/timeline?per_page=100&page=${page}`);
      assert.ok(Array.isArray(batch));
      rows.push(...batch);
      pages++;
      if (batch.length < 100) { complete = true; break; }
    }
    return { complete, pages, events: projectTimeline(rows, repository) };
  };
  const issues = cohort.candidates.map(candidate => ({ number: candidate.number,
    creatorRunId: candidate.runId, timeline: timeline(candidate.number) }));
  const related = issues.flatMap(issue => issue.timeline.events.flatMap(event => event.target ? [event.target] : []));
  const pullNumbers = [...new Set(related.filter(item => item.kind === "pull-request").map(item => item.number))];
  const failureNumbers = [...new Set(related.filter(item => item.kind === "issue"
    && /Issue Monster failed to assign agent/.test(item.title)).map(item => item.number))];
  assert.ok(pullNumbers.length <= 20 && failureNumbers.length <= 30, "Handoff expansion budget exceeded");
  const failureReports = failureNumbers.map(number => {
    const issue = request(`repos/${repository}/issues/${number}`);
    assert.equal(issue.number, number);
    assert.equal(typeof issue.body, "string");
    return { number, url: issue.html_url, bodySha256: sha256(issue.body),
      workflowReference: parseWorkflowReference(issue.body, repository),
      errors: [...issue.body.matchAll(/^- Issue #(\d+) \(agent: ([^)]+)\): ([^\n]+)/gm)]
        .map(match => ({ issue: Number(match[1]), agent: match[2],
          message: /Bad credentials/i.test(match[3]) ? "Bad credentials" : "Other assignment error",
          messageSha256: sha256(match[3]) })) };
  });
  const pullRequests = pullNumbers.map(number => {
    const pull = request(`repos/${repository}/pulls/${number}`);
    assert.equal(pull.number, number);
    const checks = request(`repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`);
    return { number, url: pull.html_url, title: pull.title, state: pull.state,
      mergedAt: pull.merged_at, headSha: pull.head.sha, creatorRole: agentRole(pull.user),
      timeline: timeline(number), checks: { complete: checks.total_count === checks.check_runs.length,
        total: checks.total_count, observedAt: new Date().toISOString(),
        items: checks.check_runs.map(check => ({ name: check.name, headSha: check.head_sha,
          status: check.status, conclusion: check.conclusion })) } };
  });
  return { schemaVersion: 1, repository, workflow: cohort.study.workflow,
    observedAt: new Date().toISOString(), issues, failureReports, pullRequests,
    limitation: "Comment requests are not execution receipts; user-account actors may be humans or automation. Failure reports preserve current bodies, not their edit history. Explicit connections are not proof of accepted refactoring or causation." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, output, ...args] = process.argv.slice(2);
  if (!["--acquire", "--replay"].includes(mode) || !source
    || (mode === "--acquire" && (!output || args.length % 4
      || args.some((value, index) => index % 4 === 0 && value !== "--audit")))
    || (mode === "--replay" && (output || args.length))) {
    throw new Error("usage: trace-file-diet-handoffs.mjs --acquire COHORT.json.gz NEW.json.gz [--audit AUDIT.json RUN_CACHE ISSUE] | --replay ARCHIVE.json.gz");
  }
  let proof;
  if (mode === "--acquire") {
    assert.ok(!existsSync(output), "Refusing to replace a handoff observation");
    let requests = 0;
    proof = collectHandoffs(readCensusJson(source), endpoint => {
      assert.ok(++requests <= 100, "Handoff request budget exceeded");
      return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024 }));
    });
    proof.sourceProofSha256 = sha256(readFileSync(source));
    proof.acquisition = { requests, requestLimit: 100, timelinePageLimit: 3 };
    proof.assignmentAudits = [];
    for (let index = 0; index < args.length; index += 4) {
      const audit = JSON.parse(readFileSync(args[index + 1], "utf8"));
      assert.ok(proof.issues.some(issue => issue.number === Number(args[index + 3])), "Audit target outside cohort");
      assert.ok(proof.issues.find(issue => issue.number === Number(args[index + 3])).timeline.events.some(event =>
        event.workflowReference?.runId === String(audit.overview.run_id)
        && event.workflowReference.workflowId === "issue-monster"), "Audit run is not a linked assignment request");
      proof.assignmentAudits.push(projectAssignmentAudit(audit,
        readFileSync(path.join(args[index + 2], "safeoutputs.jsonl"), "utf8"),
        readFileSync(path.join(args[index + 2], "workflow-logs/3_safe_outputs.txt"), "utf8"), Number(args[index + 3])));
    }
    writeCensusJson(output, proof);
  } else {
    proof = readCensusJson(source);
    assert.equal(proof.schemaVersion, 1);
    assert.equal(proof.repository, "github/gh-aw");
    assert.equal(proof.workflow, "daily-file-diet");
  }
  console.log(JSON.stringify({ issues: summarizeHandoffs(proof), assignmentAudits: proof.assignmentAudits ?? [] }, null, 2));
}
