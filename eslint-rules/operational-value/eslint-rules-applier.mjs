#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DAY_MS = 86_400_000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_REPOSITORY = "githubnext/gh-aw-cao";

export const definition = {
  schemaVersion: 3,
  slug: "eslint-rules-applier",
  repository: "githubnext/gh-aw-cao",
  workflowName: "ESLint Factory / Applier",
  sourcePath: ".github/workflows/eslint-rules-applier.md",
  adoption: {
    commit: "5b53362284c6f4313fee469afc1b17cac600ec8e",
    adoptedAt: "2026-09-15T14:26:14Z",
    baselineCommit: "6ae7578945be96b0af82616a9a3b0fb9046899dc",
    baselineAt: "2026-09-15T14:24:33Z",
  },
  evaluation: {
    mode: "attainment-only",
  },
  evidence: {
    key: "eslint-rule-adoption",
    repositories: [
      "github/gh-aw",
      "github/gh-aw-actions",
      "github/gh-aw-firewall",
      "github/gh-aw-mcpg",
      "github/gh-aw-threat-detection",
      "githubnext/gh-aw-cao",
    ],
    opportunity: "A unique ESLint Factory adoption request for a target repository and rule key.",
    filters: [
      "The request is a non-pull-request issue labelled eslint-rules and eslint-rules:applier in the target or control repository.",
      "The request identifies both the target repository and rule key and was created during the observation window.",
      "Matured observations include only requests with thirty days to mature before the immutable repository cutoff.",
      "Duplicate requests for the same target repository and rule key count once.",
    ],
    collection: "List bounded adoption issues once per evidence repository, resolve the last target-repository commit at each immutable cutoff, and inspect one archive per repository and cutoff for the requested warning rule, dedicated npm script, and separate non-gating CI job.",
    window: {
      durationDays: 90,
      cadenceDays: 7,
      maturationDays: 30,
    },
    zeroRule: "One or more mature, valid requests with complete repository snapshots and no attained requested state records zero.",
    missingRule: "No eligible request, an unidentified target or rule, inaccessible or paginated issue evidence, or an unavailable repository snapshot records missing rather than zero.",
  },
  model: {
    architecture: "Direct opportunity-normalized outcome attainment with disaggregated repository-state diagnostics.",
    recommendation: "Use complete adoption share as primary and retain each required adoption dimension separately because partial adoption is operationally meaningful.",
    presentation: {
      label: "ESLint rule adoption",
      betterLabel: "More matured requests fully adopted",
    },
  },
  summary: {
    nativeLabel: "Share of matured ESLint adoption requests fully adopted",
  },
  metrics: [
    {
      id: "complete-adoption-share",
      name: "Complete adoption share",
      role: "primary",
      formula: "requests with warning-only rule, dedicated npm script, and separate non-gating CI job / eligible requests",
      direction: "increase",
      presentation: { name: "Complete adoption", legendLabel: "Complete adoption", transform: "identity" },
    },
    ...[
      ["warning-rule-share", "Warning-only rule share", "requests with the selected rule configured at warning severity / eligible requests", "Warning rule"],
      ["dedicated-script-share", "Dedicated script share", "requests with a dedicated ESLint Factory npm script / eligible requests", "Dedicated script"],
      ["separate-ci-job-share", "Separate non-gating CI job share", "requests whose dedicated script runs in a separate non-gating CI job / eligible requests", "Separate CI job"],
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
      completeCount: 1,
      warningRuleCount: 1,
      dedicatedScriptCount: 1,
      separateCiJobCount: 1,
    },
    targetMissed: {
      valid: true,
      opportunityCount: 1,
      completeCount: 0,
      warningRuleCount: 0,
      dedicatedScriptCount: 0,
      separateCiJobCount: 0,
    },
    missing: { valid: false, opportunityCount: 0 },
    malformed: { valid: true, opportunityCount: "one", completeCount: 1 },
  },
};

const metricFields = {
  "complete-adoption-share": "completeCount",
  "warning-rule-share": "warningRuleCount",
  "dedicated-script-share": "dedicatedScriptCount",
  "separate-ci-job-share": "separateCiJobCount",
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

function api(endpoint, fields = [], encoding = "utf8") {
  return execFileSync("gh", [
    "api", "--method", "GET", endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

function paginated(endpoint, fields = []) {
  const pages = JSON.parse(execFileSync("gh", [
    "api", "--method", "GET", "--paginate", "--slurp", endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  }));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub API returned malformed paginated evidence for ${endpoint}`);
  }
  return pages.flat();
}

function parseTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
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

function issueIdentity(issue, repository) {
  const text = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  if (!new RegExp(`\\b${repository.replace("/", "\\/")}\\b`, "i").test(text)) return null;
  const ruleKey = text.match(/(?:rule[_ ]key|rule key)[\s`"']*[:=]\s*[`"']?([@A-Za-z0-9][@A-Za-z0-9._/-]*)/i)?.[1];
  return ruleKey ? { repository, ruleKey } : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectSnapshot(files, ruleKey) {
  const configFiles = files.filter((file) => (
    /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[A-Za-z]+)?)$/.test(file.path)
  ));
  const rulePattern = new RegExp(`${escapeRegExp(ruleKey)}[\\s\\S]{0,160}?(?:["']warn["']|\\b1\\b)`, "i");
  const warningRule = configFiles.some((file) => rulePattern.test(file.content));

  const scripts = [];
  for (const file of files.filter((candidate) => candidate.path.endsWith("/package.json")
    || candidate.path === "package.json")) {
    let manifest;
    try {
      manifest = JSON.parse(file.content);
    } catch {
      continue;
    }
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (/eslint[-:]?factory/i.test(name) && /\beslint\b/i.test(String(command))) scripts.push(name);
    }
  }
  const dedicatedScript = scripts.length > 0;
  const workflowFiles = files.filter((file) => (
    /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/.test(file.path)
  ));
  const separateCiJob = scripts.some((script) => workflowFiles.some((file) => {
    const source = file.content;
    const run = new RegExp(`(?:npm|pnpm|yarn)\\s+(?:run\\s+)?${escapeRegExp(script)}\\b`, "i");
    if (!run.test(source)) return false;
    const lines = source.split(/\r?\n/);
    const runIndex = lines.findIndex((line) => run.test(line));
    let jobStart = runIndex;
    while (jobStart > 0 && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[jobStart])) jobStart -= 1;
    let jobEnd = runIndex + 1;
    while (jobEnd < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[jobEnd])) jobEnd += 1;
    const block = lines.slice(jobStart, jobEnd).join("\n");
    return /continue-on-error:\s*true/i.test(block);
  }));
  return {
    warningRule,
    dedicatedScript,
    separateCiJob,
    complete: warningRule && dedicatedScript && separateCiJob,
  };
}

function resolveCommit(repository, cutoff) {
  const commits = JSON.parse(api(`repos/${repository}/commits`, [["until", cutoff], ["per_page", "1"]]));
  const commit = commits[0]?.sha;
  if (!/^[0-9a-f]{40}$/i.test(commit ?? "")) {
    throw new Error(`No immutable commit found for ${repository} at ${cutoff}`);
  }
  return commit;
}

function collectSnapshot(repository, commit) {
  const tree = JSON.parse(api(`repos/${repository}/git/trees/${commit}`, [["recursive", "1"]]));
  if (tree.truncated === true || !Array.isArray(tree.tree)) {
    throw new Error(`Repository tree is incomplete for ${repository} at ${commit}`);
  }
  const relevant = tree.tree.filter((entry) => entry.type === "blob" && (
    /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[A-Za-z]+)?)$/.test(entry.path)
    || entry.path === "package.json"
    || entry.path.endsWith("/package.json")
    || /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/.test(entry.path)
  ));
  return relevant.map((entry) => {
    const blob = JSON.parse(api(`repos/${repository}/git/blobs/${entry.sha}`));
    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new Error(`Repository blob is unavailable for ${repository}:${entry.path}`);
    }
    return { path: entry.path, content: Buffer.from(blob.content, "base64").toString("utf8") };
  });
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests) || requests.length === 0 || requests.some((request) => !validRequest(request))) {
    throw new Error("collectBatch requires valid observation windows");
  }
  const supported = new Set(definition.evidence.repositories.map((repository) => repository.toLowerCase()));
  const normalized = requests.map((request) => {
    const repository = request.repository ?? definition.evidence.repositories[0];
    if (!REPOSITORY.test(repository) || !supported.has(repository.toLowerCase())) {
      throw new Error(`Unsupported evidence repository: ${repository}`);
    }
    return { ...request, repository };
  });

  const earliest = normalized.map(({ windowStart }) => windowStart).sort()[0];
  const evidenceRepositories = new Set([
    CONTROL_REPOSITORY,
    ...normalized.map(({ repository }) => repository),
  ]);
  const issues = [];
  for (const evidenceRepository of evidenceRepositories) {
    const found = paginated(`repos/${evidenceRepository}/issues`, [
      ["state", "all"],
      ["labels", "eslint-rules,eslint-rules:applier"],
      ["since", earliest],
      ["per_page", "100"],
    ]);
    issues.push(...found.filter((issue) => !issue.pull_request).map((issue) => ({
      ...issue,
      evidenceRepository,
    })));
  }

  const snapshots = new Map();
  for (const request of normalized) {
    const cutoff = parseTime(request.windowEnd);
    const interim = parseTime(request.observedAt)
      < parseTime(definition.adoption.adoptedAt)
        + (definition.evidence.window.durationDays + definition.evidence.window.maturationDays) * DAY_MS;
    const latestCreation = interim
      ? cutoff
      : cutoff - definition.evidence.window.maturationDays * DAY_MS;
    const candidates = new Map();
    for (const issue of issues) {
      const createdAt = parseTime(issue.created_at);
      const identity = issueIdentity(issue, request.repository);
      if (createdAt === null || !identity
          || createdAt < parseTime(request.windowStart) || createdAt >= latestCreation) continue;
      const key = `${request.repository.toLowerCase()}:${identity.ruleKey.toLowerCase()}`;
      const existing = candidates.get(key);
      if (!existing || createdAt < parseTime(existing.created_at)) candidates.set(key, { ...issue, ...identity });
    }

    let snapshot;
    if (candidates.size > 0) {
      const snapshotKey = `${request.repository.toLowerCase()}:${request.windowEnd}`;
      snapshot = snapshots.get(snapshotKey);
      if (!snapshot) {
        const commit = resolveCommit(request.repository, request.windowEnd);
        snapshot = { commit, files: collectSnapshot(request.repository, commit) };
        snapshots.set(snapshotKey, snapshot);
      }
    }

    const outcomes = [...candidates.values()].map((candidate) => ({
      candidate,
      outcome: inspectSnapshot(snapshot.files, candidate.ruleKey),
    }));
    const count = (field) => outcomes.filter(({ outcome }) => outcome[field]).length;
    request.collection = {
      evidence: {
        valid: true,
        opportunityCount: outcomes.length,
        completeCount: count("complete"),
        warningRuleCount: count("warningRule"),
        dedicatedScriptCount: count("dedicatedScript"),
        separateCiJobCount: count("separateCiJob"),
        maturityStatus: interim ? "interim" : "matured",
        dubious: interim,
        key: definition.evidence.key,
        repositories: [request.repository],
        opportunity: definition.evidence.opportunity,
        filters: definition.evidence.filters,
        collection: definition.evidence.collection,
        window: definition.evidence.window,
      },
      provenance: [
        ...[...evidenceRepositories].map((repository) => ({
          repository,
          kind: "github-issues",
          ref: `${request.windowStart}/${request.windowEnd}`,
        })),
        ...outcomes.map(({ candidate }) => ({
          repository: candidate.evidenceRepository,
          kind: "eslint-adoption-issue",
          ref: String(candidate.number),
        })),
        ...(snapshot ? [{
          repository: request.repository,
          kind: "git-commit",
          ref: snapshot.commit,
        }] : []),
      ],
      ...(snapshot ? { commit: snapshot.commit } : {}),
    };
  }
  return normalized.map(({ collection }) => collection);
}
