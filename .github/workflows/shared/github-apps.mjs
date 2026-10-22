import { spawnSync } from "node:child_process";

export const APP_PROFILES = Object.freeze([
  Object.freeze({
    role: "read",
    label: "read-only",
    variable: "GH_AW_GITHUB_READ_APP_ID",
    secret: "GH_AW_GITHUB_READ_APP_PRIVATE_KEY",
    permissions: Object.freeze({
      actions: "read",
      checks: "read",
      contents: "read",
      issues: "read",
      packages: "read",
      pull_requests: "read",
      secret_scanning_alerts: "read",
      security_events: "read",
      statuses: "read",
      vulnerability_alerts: "read",
    }),
  }),
  Object.freeze({
    role: "write",
    label: "write-capable",
    variable: "GH_AW_GITHUB_WRITE_APP_ID",
    secret: "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY",
    permissions: Object.freeze({
      actions: "write",
      administration: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    }),
  }),
]);

export function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function repositoryState(repo, runner = runGh) {
  const variables = new Set(runner([
    "api",
    `/repos/${repo}/actions/variables?per_page=100`,
    "--paginate",
    "--jq",
    ".variables[].name",
  ]).split("\n").filter(Boolean));
  const secrets = new Set(runner([
    "api",
    `/repos/${repo}/actions/secrets?per_page=100`,
    "--paginate",
    "--jq",
    ".secrets[].name",
  ]).split("\n").filter(Boolean));
  return { variables, secrets };
}

export function repositoryVariableValue(repo, name, runner = runGh) {
  return runner([
    "api",
    `/repos/${repo}/actions/variables/${name}`,
    "--jq",
    ".value",
  ]);
}
