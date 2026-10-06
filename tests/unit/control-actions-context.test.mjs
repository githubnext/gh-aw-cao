import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controlPolicy } from "../helpers/control-precompute.mjs";
import { main } from "../../.github/workflows/shared/control.mjs";

async function assertActionsAdmission(debug) {
  const directory = mkdtempSync(join(tmpdir(), "central-ops-actions-"));
  const githubOutput = join(directory, "github-output");
  const stepSummary = join(directory, "step-summary");
  writeFileSync(githubOutput, "");
  writeFileSync(stepSummary, "");
  const oldEnv = { ...process.env };
  const oldExitCode = process.exitCode;
  const oldGithub = globalThis.github;
  const oldContext = globalThis.context;
  const calls = [];
  const actions = {
    github: {
      async request(route, params) {
        calls.push({ route, params });
        if (route === "GET /repos/acme/control/contents/.github/workflows/cao.json") {
          return { data: { content: Buffer.from(controlPolicy()).toString("base64") } };
        }
        if (route === "GET /rate_limit") {
          return { data: { resources: { core: { limit: 5000, remaining: 5000, reset: 2_000_000_000 } } } };
        }
        if (route === "GET /repos/acme/control/collaborators/developer/permission") {
          return { data: { permission: "write", user: { login: "developer", type: "User" } } };
        }
        throw new Error(`unexpected request: ${route}`);
      },
    },
    context: {
      payload: {
        sender: { login: "developer", type: "User" },
        inputs: { safe_output_mode: "debug", target_repo: "acme/target", safe_output_repo: "acme/target" },
      },
    },
  };

  try {
    Object.assign(process.env, {
      CAO_CAMPAIGN: "dependabot",
      CAO_ROLE: "orchestrator",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/control",
      GITHUB_STEP_SUMMARY: stepSummary,
      RUNNER_TEMP: directory,
      GITHUB_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
      ...(debug ? {
        CAO_ROLE: "worker",
        CAO_WORKER: "update-planner",
        CAO_REQUESTED_MODE: "debug",
        CAO_TARGET_REPOSITORY: "acme/target",
        CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY: "acme/target",
        CAO_CORRELATION_ID: "",
        CAO_CENTRAL_REPOSITORY: "",
        CAO_CONTROL_PLANE_RUN_URL: "",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_ACTOR: "developer",
        GITHUB_TRIGGERING_ACTOR: "developer",
        GITHUB_EVENT_PATH: "missing-event-file",
      } : {}),
    });
    process.exitCode = 0;

    await main(actions, ["admit"]);

    assert.equal(process.exitCode, 0);
    assert.equal(globalThis.github, actions.github);
    assert.deepEqual(
      calls.map(({ route }) => route),
      [
        "GET /repos/acme/control/contents/.github/workflows/cao.json",
        ...(debug ? ["GET /repos/acme/control/collaborators/developer/permission"] : []),
        "GET /rate_limit",
      ],
    );
    assert.deepEqual(calls[0].params, { ref: "1111111111111111111111111111111111111111" });
    assert.match(readFileSync(githubOutput, "utf8"), /^authorized=true$/m);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in oldEnv)) delete process.env[key];
    }
    Object.assign(process.env, oldEnv);
    if (oldGithub === undefined) delete globalThis.github;
    else globalThis.github = oldGithub;
    if (oldContext === undefined) delete globalThis.context;
    else globalThis.context = oldContext;
    process.exitCode = oldExitCode;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const debug of [false, true]) {
  test(`CAO ${debug ? "debug" : "ordinary"} admission uses the github-script Octokit singleton`, () => assertActionsAdmission(debug));
}
