#!/usr/bin/env node

// Live probe for the control-plane target read contract: a target-scoped read
// App token must be able to read the target's repository metadata, Dependabot
// alerts, code-scanning and secret-scanning alerts, check runs, and commit
// statuses. Only HTTP outcomes and sample counts are reported; alert contents
// are never printed.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { controlSettings, loadPolicyFile } from "../.github/workflows/shared/policy.mjs";

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const FEATURE_DISABLED = /not enabled|disabled|no analysis found|advanced security must be enabled/i;

export const TARGET_READ_PROBES = Object.freeze([
  Object.freeze({ id: "dependabot_alerts", permission: "vulnerability_alerts", path: "dependabot/alerts?state=open&per_page=1" }),
  Object.freeze({ id: "code_scanning_alerts", permission: "security_events", path: "code-scanning/alerts?state=open&per_page=1" }),
  Object.freeze({ id: "secret_scanning_alerts", permission: "secret_scanning_alerts", path: "secret-scanning/alerts?state=open&per_page=1" }),
  Object.freeze({ id: "check_runs", permission: "checks", path: "commits/{ref}/check-runs?per_page=1" }),
  Object.freeze({ id: "statuses", permission: "statuses", path: "commits/{ref}/status?per_page=1" }),
]);

export function classifyProbe(status, message = "") {
  if (status >= 200 && status < 300) return "readable";
  if ((status === 403 || status === 404) && FEATURE_DISABLED.test(message)) return "feature-disabled";
  if (status === 401 || status === 403 || status === 404) return "denied";
  return "error";
}

function sampleCount(body) {
  if (Array.isArray(body)) return body.length;
  return Number.isSafeInteger(body?.total_count) ? body.total_count : null;
}

export function assertTargetInScope(settings, target) {
  const normalized = String(target || "").toLowerCase();
  const repositories = (settings.allowed_repositories ?? []).map((repository) => repository.toLowerCase());
  const owners = (settings.allowed_owners ?? []).map((owner) => owner.toLowerCase());
  const inScope = repositories.length > 0
    ? repositories.includes(normalized)
    : owners.includes(normalized.split("/")[0]);
  if (!inScope) throw new Error(`${target} is outside the control-plane scope`);
}

async function request(fetchImpl, apiUrl, token, path) {
  const response = await fetchImpl(`${apiUrl}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: ["Bearer", token].join(" "),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function probeTargetReadAccess({ target, token, apiUrl, fetchImpl = globalThis.fetch }) {
  if (!REPOSITORY_PATTERN.test(target || "")) throw new Error("target must use OWNER/REPO form");
  if (!token) throw new Error("a target-scoped read token is required");
  if (!apiUrl) throw new Error("the GitHub API URL is required");
  const base = String(apiUrl).replace(/\/+$/, "");

  const repository = await request(fetchImpl, base, token, `repos/${target}`);
  const report = {
    target,
    repository: {
      outcome: classifyProbe(repository.status, repository.body?.message),
      status: repository.status,
      visibility: repository.body?.visibility ?? null,
    },
    probes: [],
    ok: false,
  };
  if (report.repository.outcome !== "readable") return report;

  const ref = encodeURIComponent(repository.body?.default_branch || "HEAD");
  for (const probe of TARGET_READ_PROBES) {
    const response = await request(fetchImpl, base, token, `repos/${target}/${probe.path.replace("{ref}", ref)}`);
    const outcome = classifyProbe(response.status, response.body?.message);
    report.probes.push({
      id: probe.id,
      permission: probe.permission,
      status: response.status,
      outcome,
      sample_count: outcome === "readable" ? sampleCount(response.body) : null,
    });
  }
  report.ok = report.probes.every(({ outcome }) => outcome === "readable" || outcome === "feature-disabled");
  return report;
}

export function formatProbeSummary(report) {
  const lines = [
    `### Target read access: \`${report.target}\``,
    "",
    `Repository metadata: **${report.repository.outcome}** (HTTP ${report.repository.status}${report.repository.visibility ? `, ${report.repository.visibility}` : ""})`,
    "",
    "| Evidence | App permission | HTTP | Outcome |",
    "| --- | --- | --- | --- |",
    ...report.probes.map((probe) => `| ${probe.id} | ${probe.permission} | ${probe.status} | ${probe.outcome} |`),
    "",
    report.ok ? "✅ The read App can read every target evidence source." : "❌ The read App cannot read every target evidence source.",
  ];
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const policy = loadPolicyFile(process.env.CAO_POLICY_PATH || ".github/workflows/cao.json");
  assertTargetInScope(controlSettings(policy, process.env.GITHUB_REPOSITORY), process.env.CAO_PROBE_TARGET);
  if (process.argv.includes("--scope-only")) process.exit(0);
  const report = await probeTargetReadAccess({
    target: process.env.CAO_PROBE_TARGET,
    token: process.env.CAO_PROBE_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatProbeSummary(report));
  }
  if (!report.ok) process.exitCode = 1;
}
