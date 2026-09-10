import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controlPolicy } from "../helpers/control-precompute.mjs";
import { main } from "../../.github/cao/src/control.mjs";

test("CAO admission uses the github-script Octokit singleton", async () => {
  const directory = mkdtempSync(join(tmpdir(), "central-ops-actions-"));
  const githubOutput = join(directory, "github-output");
  const stepSummary = join(directory, "step-summary");
  writeFileSync(githubOutput, "");
  writeFileSync(stepSummary, "");
  const oldEnv = { ...process.env };
  const oldExitCode = process.exitCode;
  const oldGithub = globalThis.github;
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
        throw new Error(`unexpected request: ${route}`);
      },
    },
  };

  try {
    Object.assign(process.env, {
      CAO_PACKAGE: "dependabot",
      CAO_ROLE: "orchestrator",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/control",
      GITHUB_STEP_SUMMARY: stepSummary,
      RUNNER_TEMP: directory,
      GITHUB_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
    });
    process.exitCode = 0;

    await main(actions, ["admit"]);

    assert.equal(process.exitCode, 0);
    assert.deepEqual(
      calls.map(({ route }) => route),
      [
        "GET /repos/acme/control/contents/.github/workflows/cao.json",
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
    process.exitCode = oldExitCode;
    rmSync(directory, { recursive: true, force: true });
  }
});
