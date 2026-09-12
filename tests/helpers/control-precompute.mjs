import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function controlProgram() {
  return join(root, ".github", "workflows", "shared", "control.mjs");
}

export function controlPolicy({
  scope = {},
  inventory = {},
  packagePolicy = {},
  workerPolicy = {},
} = {}) {
  return JSON.stringify({
    version: 1,
    "gh-aw-version": "v0.89.9",
    "control-plane": {
      scope: { "allowed-owners": ["acme"], ...scope },
      inventory,
      packages: {
        dependabot: {
          mode: "review",
          "max-repositories": 1,
          "rollout-percent": 100,
          ...packagePolicy,
          ...(workerPolicy === null ? {} : {
            workers: {
              "release-train-updater": {
                workflow: "dependabot-release-train-updater",
                ...workerPolicy,
              },
            },
          }),
        },
      },
    },
  });
}

export function controlEnvironment(overrides = {}) {
  const values = {
    ...process.env,
    BUNDLE: "dependabot",
    ROLE: "worker",
    WORKER: "release-train-updater",
    TARGET_REPO: "acme/target",
    REQUESTED_MODE: "review",
    REQUESTED_MAX_REPOS: "",
    REQUESTED_ROLLOUT_PERCENT: "",
    DISPATCH_MAX: "1",
    SAFE_OUTPUT_REPO: "acme/control",
    CORRELATION_ID: "123-1",
    CENTRAL_REPO: "acme/control",
    CONTROL_PLANE_RUN_URL: "https://github.com/acme/control/actions/runs/123",
    ORCHESTRATOR_CREDITS: "250",
    WORKER_CREDITS_PER_TARGET: "600",
    AGGREGATE_CREDIT_LIMIT: "1100",
    MONTHLY_CREDIT_BUDGET: "0",
    GITHUB_REPOSITORY: "acme/control",
    GITHUB_SERVER_URL: "https://github.com",
    WORKFLOW_SHA: "1111111111111111111111111111111111111111",
    GITHUB_WORKFLOW_REF: "acme/control/.github/workflows/dependabot.lock.yml@main",
    CONTROL_POLICY: controlPolicy(),
    ...overrides,
  };
  return {
    ...values,
    CAO_PACKAGE: overrides.CAO_PACKAGE ?? values.BUNDLE,
    CAO_ROLE: overrides.CAO_ROLE ?? values.ROLE,
    CAO_WORKER: overrides.CAO_WORKER ?? (values.ROLE === "orchestrator" ? "" : values.WORKER),
    CAO_TARGET_REPOSITORY: overrides.CAO_TARGET_REPOSITORY ?? values.TARGET_REPO,
    CAO_REQUESTED_MODE: overrides.CAO_REQUESTED_MODE ?? values.REQUESTED_MODE,
    CAO_REQUESTED_MAX_REPOSITORIES: overrides.CAO_REQUESTED_MAX_REPOSITORIES ?? values.REQUESTED_MAX_REPOS,
    CAO_REQUESTED_ROLLOUT_PERCENT: overrides.CAO_REQUESTED_ROLLOUT_PERCENT ?? values.REQUESTED_ROLLOUT_PERCENT,
    CAO_DISPATCH_MAX: overrides.CAO_DISPATCH_MAX ?? values.DISPATCH_MAX,
    CAO_SAFE_OUTPUT_REPOSITORY: overrides.CAO_SAFE_OUTPUT_REPOSITORY ?? values.SAFE_OUTPUT_REPO,
    CAO_CORRELATION_ID: overrides.CAO_CORRELATION_ID ?? values.CORRELATION_ID,
    CAO_CENTRAL_REPOSITORY: overrides.CAO_CENTRAL_REPOSITORY ?? values.CENTRAL_REPO,
    CAO_CONTROL_PLANE_RUN_URL: overrides.CAO_CONTROL_PLANE_RUN_URL ?? values.CONTROL_PLANE_RUN_URL,
    CAO_ORCHESTRATOR_CREDITS: overrides.CAO_ORCHESTRATOR_CREDITS ?? values.ORCHESTRATOR_CREDITS,
    CAO_WORKER_CREDITS_PER_TARGET: overrides.CAO_WORKER_CREDITS_PER_TARGET ?? values.WORKER_CREDITS_PER_TARGET,
    GITHUB_WORKFLOW_SHA: overrides.GITHUB_WORKFLOW_SHA ?? values.WORKFLOW_SHA,
  };
}