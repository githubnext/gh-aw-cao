#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DAY_MS = 86_400_000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const PLAN_MARKER = /<!-- dependabot-update-plan:repository=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) -->/;

export const definition = {
  schemaVersion: 3,
  slug: "dependabot-update-planner",
  repository: "githubnext/gh-aw-cao",
  workflowName: "Dependabot / Update Planner",
  sourcePath: ".github/workflows/dependabot-update-planner.md",
  adoption: {
    commit: "7f31a746d534f128d92221edcad975972c361c0f",
    adoptedAt: "2026-09-17T08:48:00Z",
    baselineCommit: "3ff44e26cf119464e22e1678457c4019f3d002b2",
    baselineAt: "2026-09-15T17:38:18Z",
  },
  evaluation: {
    mode: "attainment-only",
  },
  evidence: {
    key: "dependabot-plan-consumption",
    repositories: ["githubnext/gh-aw-cao"],
    opportunity: "A durable, target-bound Dependabot plan issue created during the observation window.",
    filters: [
      "Issue title ends with the canonical Dependency update plan subject or its body contains the exact repository marker.",
      "Pull requests and issues without a valid target repository marker or subject are excluded.",
      "Consumption signals must occur no later than fourteen days after plan creation.",
    ],
    collection: "At the immutable window cutoff, list Dependabot plan issues and collect their bounded child issues, comments, and timeline events through read-only GitHub APIs.",
    window: {
      durationDays: 14,
      cadenceDays: 14,
      maturationDays: 14,
    },
    zeroRule: "Complete evidence for one or more mature plans with no accepted consumption signal records zero.",
    missingRule: "No eligible plan, immature evidence, inaccessible or paginated evidence, or an ambiguous plan identity records missing rather than zero.",
  },
  model: {
    architecture: "Direct opportunity-normalized outcome attainment with disaggregated signal diagnostics.",
    recommendation: "Use consumed plan share as primary; retain signal shares separately because they identify different forms of active use.",
    presentation: {
      label: "Dependabot plan consumption",
      betterLabel: "More mature plans actively consumed",
    },
  },
  summary: {
    nativeLabel: "Share of mature Dependabot plans actively consumed",
  },
  metrics: [
    {
      id: "consumed-plan-share",
      name: "Consumed plan share",
      role: "primary",
      formula: "plans with assignment, external participation, checklist progress, a linked pull request, or closure / eligible mature plans",
      direction: "increase",
      presentation: { name: "Consumed plans", legendLabel: "Consumed plans", transform: "identity" },
    },
    ...[
      ["assigned-plan-share", "Assigned plan share", "plans with an assignment / eligible mature plans", "Assigned"],
      ["participated-plan-share", "Participated plan share", "plans with external participation / eligible mature plans", "Participation"],
      ["progressed-plan-share", "Progressed plan share", "plans with completed checklist progress / eligible mature plans", "Progress"],
      ["linked-plan-share", "Linked pull request share", "plans cross-referenced by a pull request / eligible mature plans", "Linked PR"],
      ["closed-plan-share", "Closed plan share", "closed plans / eligible mature plans", "Closed"],
    ].map(([id, name, formula, legendLabel]) => ({
      id,
      name,
      role: "diagnostic",
      formula,
      direction: "increase",
      presentation: { name, legendLabel, transform: "identity" },
    })),
  ],
  validationExamples: {
    targetAttained: {
      valid: true,
      opportunityCount: 1,
      consumedCount: 1,
      assignedCount: 1,
      participatedCount: 1,
      progressedCount: 1,
      linkedCount: 1,
      closedCount: 1,
    },
    targetMissed: {
      valid: true,
      opportunityCount: 1,
      consumedCount: 0,
      assignedCount: 0,
      participatedCount: 0,
      progressedCount: 0,
      linkedCount: 0,
      closedCount: 0,
    },
    missing: { valid: false, opportunityCount: 0 },
    malformed: { valid: true, opportunityCount: "one", consumedCount: 1 },
  },
};

const metricFields = {
  "consumed-plan-share": "consumedCount",
  "assigned-plan-share": "assignedCount",
  "participated-plan-share": "participatedCount",
  "progressed-plan-share": "progressedCount",
  "linked-plan-share": "linkedCount",
  "closed-plan-share": "closedCount",
};

function boundedShare(numerator, denominator) {
  if (!Number.isInteger(denominator) || denominator < 1
      || !Number.isInteger(numerator) || numerator < 0 || numerator > denominator) {
    return null;
  }
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

export function scoreMetric(id, evidence) {
  const field = metricFields[id];
  if (!field || evidence?.valid !== true) return null;
  return boundedShare(evidence[field], evidence.opportunityCount);
}

function api(endpoint, fields = []) {
  const output = execFileSync("gh", [
    "api", "--method", "GET", "--paginate", "--slurp", endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const pages = JSON.parse(output);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub API returned malformed paginated evidence for ${endpoint}`);
  }
  return pages;
}

function onePage(endpoint, fields = []) {
  const pages = api(endpoint, fields);
  if (pages.length !== 1) {
    throw new Error(`GitHub API evidence exceeded its bounded page for ${endpoint}`);
  }
  return pages[0];
}

function parseTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function targetOf(issue) {
  const marker = String(issue.body ?? "").match(PLAN_MARKER)?.[1];
  const subject = String(issue.title ?? "").match(/Dependency update plan for ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)?.[1];
  if (marker && subject && marker.toLowerCase() !== subject.toLowerCase()) return null;
  return marker ?? subject ?? null;
}

function isPublisher(login, issueAuthor) {
  return login === issueAuthor
    || login === "github-actions[bot]"
    || login === "dependabot[bot]"
    || /^cao-.*\[bot\]$/.test(login);
}

function signalFromTimeline(events, cutoff, kind) {
  return events.some((event) => {
    const at = parseTime(event.created_at);
    if (at === null || at > cutoff) return false;
    if (kind === "assigned") return event.event === "assigned";
    if (kind === "linked") return event.event === "cross-referenced" && event.source?.issue?.pull_request;
    if (kind === "closed") return event.event === "closed";
    if (kind === "completed") return event.event === "closed" && event.state_reason === "completed";
    return false;
  });
}

function externalParticipation(comments, cutoff, issueAuthor) {
  return comments.some((comment) => {
    const at = parseTime(comment.created_at);
    const login = String(comment.user?.login ?? "");
    return at !== null && at <= cutoff && login && !isPublisher(login, issueAuthor);
  });
}

function collectPlan(repository, issue) {
  const createdAt = parseTime(issue.created_at);
  if (createdAt === null) throw new Error(`Plan issue ${issue.number} has an invalid creation timestamp`);
  const cutoff = createdAt + definition.evidence.window.maturationDays * DAY_MS;
  const children = onePage(`repos/${repository}/issues/${issue.number}/sub_issues`, [["per_page", "100"]]);
  if (children.length > 12) throw new Error(`Plan issue ${issue.number} exceeds the twelve-child evidence bound`);

  let assigned = false;
  let participated = false;
  let progressed = false;
  let linked = false;
  let closed = false;
  const issueNumbers = [issue.number, ...children.map(({ number }) => number)];
  for (const number of issueNumbers) {
    const record = number === issue.number ? issue : children.find((child) => child.number === number);
    const comments = onePage(`repos/${repository}/issues/${number}/comments`, [["per_page", "100"]]);
    const timeline = onePage(`repos/${repository}/issues/${number}/timeline`, [["per_page", "100"]]);
    assigned ||= signalFromTimeline(timeline, cutoff, "assigned");
    participated ||= externalParticipation(comments, cutoff, String(record?.user?.login ?? ""));
    linked ||= signalFromTimeline(timeline, cutoff, "linked");
    if (number !== issue.number) {
      progressed ||= signalFromTimeline(timeline, cutoff, "completed");
    } else {
      closed ||= signalFromTimeline(timeline, cutoff, "closed");
    }
  }
  return {
    assigned,
    participated,
    progressed,
    linked,
    closed,
    consumed: assigned || participated || progressed || linked || closed,
    issueNumbers,
  };
}

function validRequest(request) {
  return request
    && typeof request.windowStart === "string"
    && typeof request.windowEnd === "string"
    && typeof request.observedAt === "string"
    && parseTime(request.windowStart) !== null
    && parseTime(request.windowEnd) !== null
    && parseTime(request.observedAt) !== null
    && parseTime(request.windowStart) < parseTime(request.windowEnd);
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests) || requests.length === 0 || requests.some((request) => !validRequest(request))) {
    throw new Error("collectBatch requires valid observation windows");
  }

  const grouped = new Map();
  for (const request of requests) {
    const repository = request.repository ?? definition.evidence.repositories[0];
    if (!REPOSITORY.test(repository)
        || !definition.evidence.repositories.some((item) => item.toLowerCase() === repository.toLowerCase())) {
      throw new Error(`Unsupported evidence repository: ${repository}`);
    }
    if (!grouped.has(repository)) grouped.set(repository, []);
    grouped.get(repository).push(request);
  }

  const issuesByRepository = new Map();
  for (const [repository, windows] of grouped) {
    const earliest = windows.map(({ windowStart }) => windowStart).sort()[0];
    const pages = api(`repos/${repository}/issues`, [
      ["state", "all"],
      ["labels", "dependabot"],
      ["since", earliest],
      ["per_page", "100"],
    ]);
    issuesByRepository.set(repository, pages.flat().filter((issue) => !issue.pull_request && targetOf(issue)));
  }

  const planEvidence = new Map();
  for (const [repository, issues] of issuesByRepository) {
    const windows = grouped.get(repository);
    for (const issue of issues) {
      const createdAt = parseTime(issue.created_at);
      const requested = createdAt !== null && windows.some((request) => (
        createdAt >= parseTime(request.windowStart)
        && createdAt < parseTime(request.windowEnd)
        && parseTime(request.observedAt) >= createdAt + definition.evidence.window.maturationDays * DAY_MS
      ));
      if (!requested) continue;
      planEvidence.set(`${repository.toLowerCase()}:${issue.number}`, collectPlan(repository, issue));
    }
  }

  return requests.map((request) => {
    const repository = request.repository ?? definition.evidence.repositories[0];
    const start = parseTime(request.windowStart);
    const end = parseTime(request.windowEnd);
    const observedAt = parseTime(request.observedAt);
    const candidates = issuesByRepository.get(repository).filter((issue) => {
      const createdAt = parseTime(issue.created_at);
      return createdAt !== null
        && createdAt >= start
        && createdAt < end
        && observedAt >= createdAt + definition.evidence.window.maturationDays * DAY_MS;
    });
    const plans = candidates.map((issue) => ({
      issue,
      signals: planEvidence.get(`${repository.toLowerCase()}:${issue.number}`),
    }));
    const count = (field) => plans.filter(({ signals }) => signals[field]).length;
    return {
      evidence: {
        valid: true,
        opportunityCount: plans.length,
        consumedCount: count("consumed"),
        assignedCount: count("assigned"),
        participatedCount: count("participated"),
        progressedCount: count("progressed"),
        linkedCount: count("linked"),
        closedCount: count("closed"),
        key: definition.evidence.key,
        repositories: [repository],
        opportunity: definition.evidence.opportunity,
        filters: definition.evidence.filters,
        collection: definition.evidence.collection,
        window: definition.evidence.window,
      },
      provenance: [
        { repository, kind: "github-issues", ref: `${request.windowStart}/${request.windowEnd}` },
        ...plans.flatMap(({ issue, signals }) => signals.issueNumbers.map((number) => ({
          repository,
          kind: number === issue.number ? "dependabot-plan-issue" : "dependabot-task-issue",
          ref: String(number),
        }))),
      ],
    };
  });
}
