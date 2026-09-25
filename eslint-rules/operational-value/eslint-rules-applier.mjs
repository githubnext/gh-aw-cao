#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

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
      "The request is an immutable adoption-request transaction written by the applier to campaign memory.",
      "The transaction identifies a supported target repository, rule key, issue number, and recording time during the observation window.",
      "Matured observations include only requests with thirty days to mature before the immutable repository cutoff.",
      "Duplicate requests for the same target repository and rule key count once.",
    ],
    collection: "Read one immutable campaign-memory archive and one immutable target-repository archive per cutoff, then inspect adoption-request transactions and repository state for the requested warning rule, dedicated npm script, and separate non-gating CI job.",
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectSnapshot(files, ruleKey) {
  const configFiles = files.filter((file) => (
    /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[A-Za-z]+)?)$/.test(file.path)
  ));
  const rulePattern = new RegExp(
    `["']${escapeRegExp(ruleKey)}["']\\s*:\\s*(?:["']warn["']|1\\b|\\[\\s*(?:["']warn["']|1\\b))`,
    "i",
  );
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
    const jobIdentity = `${lines[jobStart]}\n${block.match(/^\s+name:\s*(.+)$/im)?.[1] ?? ""}`;
    const runSteps = block.match(/^\s+(?:-\s+)?run:/gm) ?? [];
    return /eslint[- :]?factory/i.test(jobIdentity)
      && runSteps.length === 1
      && /continue-on-error:\s*true/i.test(block);
  }));
  return {
    warningRule,
    dedicatedScript,
    separateCiJob,
    complete: warningRule && dedicatedScript && separateCiJob,
  };
}

function resolveCommit(repository, cutoff, ref) {
  const fields = [["until", cutoff], ["per_page", "1"]];
  if (ref) fields.push(["sha", ref]);
  const commits = JSON.parse(api(`repos/${repository}/commits`, fields));
  const commit = commits[0]?.sha;
  if (!/^[0-9a-f]{40}$/i.test(commit ?? "")) {
    throw new Error(`No immutable commit found for ${repository} at ${cutoff}`);
  }
  return commit;
}

function archiveFiles(repository, commit, include) {
  const archive = gunzipSync(api(`repos/${repository}/tarball/${commit}`, [], null));
  const files = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`Malformed archive for ${repository} at ${commit}`);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const relative = fullName.includes("/") ? fullName.slice(fullName.indexOf("/") + 1) : fullName;
    const type = String.fromCharCode(header[156] || 48);
    const contentStart = offset + 512;
    if ((type === "0" || type === "\0") && include(relative)) {
      files.push({
        path: relative,
        content: archive.subarray(contentStart, contentStart + size).toString("utf8"),
      });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function collectSnapshot(repository, commit) {
  return archiveFiles(repository, commit, (file) => (
    /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[A-Za-z]+)?)$/.test(file)
    || file === "package.json"
    || file.endsWith("/package.json")
    || /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/.test(file)
  ));
}

function collectTransactions(commit) {
  const files = archiveFiles(CONTROL_REPOSITORY, commit, (file) => (
    /(?:^|\/)transactions\/applier__[a-z0-9_.-]+__[a-z0-9_.-]+\.jsonl$/.test(file)
  ));
  return files.flatMap((file) => file.content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let transaction;
    try {
      transaction = JSON.parse(line);
    } catch {
      throw new Error(`Malformed campaign-memory transaction at ${file.path}:${index + 1}`);
    }
    return transaction;
  })).filter((transaction) => transaction?.schema === "cao.eslint-rules.transaction"
    && transaction.schema_version === 1
    && transaction.worker === "applier"
    && transaction.kind === "adoption-request");
}

function transactionIdentity(transaction) {
  const repository = transaction?.target_repo;
  const ruleKey = transaction?.rule_key;
  const issueUrlNumber = String(transaction?.payload?.issue_url ?? transaction?.payload?.issue?.url ?? "")
    .match(/\/issues\/(\d+)(?:$|[?#])/)?.[1];
  const issueNumber = transaction?.payload?.issue_number
    ?? transaction?.payload?.issue?.number
    ?? transaction?.payload?.number
    ?? (issueUrlNumber ? Number(issueUrlNumber) : null);
  if (!REPOSITORY.test(repository ?? "")
      || typeof ruleKey !== "string" || ruleKey.length === 0
      || !Number.isInteger(issueNumber) || issueNumber < 1
      || parseTime(transaction.recorded_at) === null) return null;
  return { repository, ruleKey, issueNumber, recordedAt: transaction.recorded_at };
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests) || requests.length === 0 || requests.some((request) => !validRequest(request))) {
    throw new Error("collectBatch requires valid observation windows");
  }
  const supported = new Set(definition.evidence.repositories.map((repository) => repository.toLowerCase()));
  const normalized = requests.map((request) => {
    const repository = request.repository ?? null;
    if (repository !== null && (!REPOSITORY.test(repository) || !supported.has(repository.toLowerCase()))) {
      throw new Error(`Unsupported evidence repository: ${repository}`);
    }
    return { ...request, repository };
  });

  const snapshots = new Map();
  const transactionsByCutoff = new Map();
  for (const request of normalized) {
    const cutoff = parseTime(request.windowEnd);
    const interim = parseTime(request.observedAt)
      < parseTime(definition.adoption.adoptedAt)
        + (definition.evidence.window.durationDays + definition.evidence.window.maturationDays) * DAY_MS;
    const latestCreation = interim
      ? cutoff
      : cutoff - definition.evidence.window.maturationDays * DAY_MS;
    let memory = transactionsByCutoff.get(request.windowEnd);
    if (!memory) {
      try {
        const commit = resolveCommit(CONTROL_REPOSITORY, request.windowEnd, "memory/eslint-rules");
        memory = { commit, transactions: collectTransactions(commit) };
      } catch {
        memory = { commit: null, transactions: [] };
      }
      transactionsByCutoff.set(request.windowEnd, memory);
    }
    const targets = request.repository ? [request.repository] : definition.evidence.repositories;
    const candidates = new Map();
    for (const transaction of memory.transactions) {
      const identity = transactionIdentity(transaction);
      const recordedAt = parseTime(identity?.recordedAt);
      if (!identity || !targets.some((target) => target.toLowerCase() === identity.repository.toLowerCase())
          || !supported.has(identity.repository.toLowerCase())
          || recordedAt < parseTime(request.windowStart) || recordedAt >= latestCreation) continue;
      const key = `${identity.repository.toLowerCase()}:${identity.ruleKey.toLowerCase()}`;
      const existing = candidates.get(key);
      if (!existing || recordedAt < parseTime(existing.recordedAt)) candidates.set(key, identity);
    }

    for (const repository of new Set([...candidates.values()].map(({ repository }) => repository))) {
      const snapshotKey = `${repository.toLowerCase()}:${request.windowEnd}`;
      if (!snapshots.has(snapshotKey)) {
        try {
          const commit = resolveCommit(repository, request.windowEnd);
          snapshots.set(snapshotKey, { commit, files: collectSnapshot(repository, commit) });
        } catch (error) {
          snapshots.set(snapshotKey, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const unavailableRepositories = new Set();
    const outcomes = [...candidates.values()].flatMap((candidate) => {
      const snapshot = snapshots.get(`${candidate.repository.toLowerCase()}:${request.windowEnd}`);
      if (snapshot.error) {
        unavailableRepositories.add(candidate.repository);
        return [];
      }
      return [{
        candidate,
        outcome: inspectSnapshot(snapshot.files, candidate.ruleKey),
      }];
    });
    const count = (field) => outcomes.filter(({ outcome }) => outcome[field]).length;
    request.collection = {
      evidence: {
        valid: memory.commit !== null && unavailableRepositories.size === 0,
        opportunityCount: outcomes.length,
        completeCount: count("complete"),
        warningRuleCount: count("warningRule"),
        dedicatedScriptCount: count("dedicatedScript"),
        separateCiJobCount: count("separateCiJob"),
        maturityStatus: interim ? "interim" : "matured",
        dubious: interim,
        key: definition.evidence.key,
        repositories: targets,
        opportunity: definition.evidence.opportunity,
        filters: definition.evidence.filters,
        collection: definition.evidence.collection,
        window: definition.evidence.window,
      },
      provenance: [
        {
          repository: CONTROL_REPOSITORY,
          kind: "campaign-memory",
          ref: memory.commit ?? `memory/eslint-rules@${request.windowEnd}`,
        },
        ...outcomes.map(({ candidate }) => ({
          repository: CONTROL_REPOSITORY,
          kind: "eslint-adoption-issue",
          ref: String(candidate.issueNumber),
        })),
        ...[...new Set(outcomes.map(({ candidate }) => candidate.repository))].map((repository) => ({
          repository,
          kind: "git-commit",
          ref: snapshots.get(`${repository.toLowerCase()}:${request.windowEnd}`).commit,
        })),
        ...[...unavailableRepositories].map((repository) => ({
          repository,
          kind: "git-commit-unavailable",
          ref: request.windowEnd,
        })),
      ],
      ...(request.repository && candidates.size > 0 && unavailableRepositories.size === 0 ? {
        commit: snapshots.get(`${request.repository.toLowerCase()}:${request.windowEnd}`).commit,
      } : {}),
    };
  }
  return normalized.map(({ collection }) => collection);
}
