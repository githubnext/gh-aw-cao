import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controlPolicy, controlProgram } from "../helpers/control-precompute.mjs";

const program = controlProgram();

function runAdmission({
  policy = controlPolicy(),
  policyFailure = false,
  rateLimit = 5000,
  rateRemaining = 5000,
  rateReset = Math.floor(Date.now() / 1000) + 3600,
  rateFailure = false,
  githubActions = true,
  env: extraEnv = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "central-ops-admission-"));
  const mockGh = join(directory, "gh");
  const policyFile = join(directory, "policy.json");
  const githubOutput = join(directory, "github-output");
  const stepSummary = join(directory, "step-summary");
  writeFileSync(policyFile, policy);
  writeFileSync(githubOutput, "");
  writeFileSync(stepSummary, "");
  writeFileSync(mockGh, `#!/bin/sh
case "$*" in
  *contents/.github/workflows/cao.json*)
    [ "$MOCK_POLICY_FAILURE" != "true" ] || exit 1
    base64 < "$MOCK_POLICY_FILE"
    ;;
  *rate_limit*)
    [ "$MOCK_RATE_FAILURE" != "true" ] || exit 1
    printf '{"resources":{"core":{"limit":%s,"remaining":%s,"reset":%s}}}\n' \
      "$MOCK_RATE_LIMIT" "$MOCK_RATE_REMAINING" "$MOCK_RATE_RESET"
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(mockGh, 0o755);

  try {
    const result = spawnSync("node", [program, "admit"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CAO_PACKAGE: "dependabot",
        CAO_ROLE: "orchestrator",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_ACTIONS: String(githubActions),
        GITHUB_REPOSITORY: "acme/control",
        GITHUB_STEP_SUMMARY: stepSummary,
        MOCK_POLICY_FILE: policyFile,
        MOCK_POLICY_FAILURE: String(policyFailure),
        MOCK_RATE_LIMIT: String(rateLimit),
        MOCK_RATE_REMAINING: String(rateRemaining),
        MOCK_RATE_RESET: String(rateReset),
        MOCK_RATE_FAILURE: String(rateFailure),
        RUNNER_TEMP: realpathSync(directory),
        GITHUB_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
        ...extraEnv,
      },
    });
    return {
      result,
      admission: JSON.parse(readFileSync(join(directory, "cao", "admission.json"), "utf8")),
      output: Object.fromEntries(
        readFileSync(githubOutput, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      ),
      summary: readFileSync(stepSummary, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("CAO admission authorizes a declared package before activation", () => {
  const { result, admission, output, summary } = runAdmission();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "::group::Central Agentic Ops admission",
    "[CAO] Admission authorized.",
    "::endgroup::",
    "",
  ].join("\n"));
  assert.equal(result.stderr, [
    "[CAO policy] Parsing control policy.",
    "[CAO policy] Validated control policy.",
    "[CAO policy] Resolving effective policy.",
    "",
  ].join("\n"));
  assert.deepEqual(output, { authorized: "true", reason: "authorized", monthly_credit_budget: "0" });
  assert.match(summary, /<details>\n<summary><h3>Central Agentic Ops admission<\/h3><\/summary>\n\nAuthorized package `dependabot` as `orchestrator`/);
  assert.match(summary, /- ✅ Runtime revision — The control and policy modules/);
  assert.match(summary, /- ✅ Run limits — Any supplied `max_repos`/);
  assert.equal((summary.match(/<details>/g) ?? []).length, 1);
  assert.equal((summary.match(/^- ✅ /gm) ?? []).length, 10);
  assert.equal(admission.schema_version, 1);
  assert.equal(admission.authorized, true);
  assert.equal(admission.reason, "authorized");
  assert.equal(admission.failed_check, null);
  assert.equal(admission.package, "dependabot");
  assert.equal(admission.role, "orchestrator");
  assert.deepEqual([...new Set(admission.checks.map(({ status }) => status))], ["passed"]);
});

test("CAO admission emits plain logs outside GitHub Actions", () => {
  const { result } = runAdmission({ githubActions: false });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "[CAO] Central Agentic Ops admission",
    "[CAO] Admission authorized.",
    "",
  ].join("\n"));
  assert.equal(result.stderr, [
    "[CAO policy] Parsing control policy.",
    "[CAO policy] Validated control policy.",
    "[CAO policy] Resolving effective policy.",
    "",
  ].join("\n"));
});

test("CAO admission exports the authorized package budget", () => {
  const { result, output } = runAdmission({
    policy: controlPolicy({ packagePolicy: { "monthly-ai-credit-budget": 1200 } }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, { authorized: "true", reason: "authorized", monthly_credit_budget: "1200" });
});

test("CAO admission denies a disabled package without failing the workflow", () => {
  const { result, admission, output, summary } = runAdmission({
    policy: controlPolicy({ packagePolicy: { enabled: false } }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, { authorized: "false", reason: "package-disabled", monthly_credit_budget: "0" });
  assert.match(summary, /Skipped package `dependabot` as `orchestrator`: package-disabled/);
  assert.match(summary, /- ✅ Workflow identity —/);
  assert.match(summary, /- ❌ Package —/);
  assert.match(summary, /- Worker —/);
  assert.doesNotMatch(summary, /- [✅❌] Worker —/);
  assert.equal(admission.authorized, false);
  assert.equal(admission.failed_check, "Package");
  assert.equal(admission.checks.find(({ check }) => check === "Workflow identity").status, "passed");
  assert.equal(admission.checks.find(({ check }) => check === "Package").status, "failed");
  assert.equal(admission.checks.find(({ check }) => check === "Worker").status, "not-evaluated");
});

test("CAO admission denies a requested mode that exceeds checked-in policy and marks Mode input", () => {
  const { result, output, summary } = runAdmission({
    env: { CAO_REQUESTED_MODE: "live" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, {
    authorized: "false",
    reason: "safe_output_mode exceeds checked-in policy",
    monthly_credit_budget: "0",
  });
  assert.match(summary, /Skipped package `dependabot` as `orchestrator`: safe_output_mode exceeds checked-in policy/);
  assert.match(summary, /- ✅ Package —/);
  assert.match(summary, /- ✅ Worker —/);
  assert.match(summary, /- ✅ Target input —/);
  assert.match(summary, /- ❌ Mode input —/);
  assert.match(summary, /- Run limits —/);
  assert.doesNotMatch(summary, /- [✅❌] Run limits —/);
});

test("CAO admission fails closed when policy validation fails", () => {
  const { result, output } = runAdmission({ policy: "{" });

  assert.equal(result.status, 0);
  assert.deepEqual(output, {
    authorized: "false",
    reason: "control policy validation failed",
    monthly_credit_budget: "0",
  });
});

test("CAO admission fails closed when the authoritative policy cannot be read", () => {
  const { result, output } = runAdmission({ policyFailure: true });

  assert.equal(result.status, 0);
  assert.deepEqual(output, {
    authorized: "false",
    reason: "cannot read .github/workflows/cao.json at github.workflow_sha",
    monthly_credit_budget: "0",
  });
});

test("CAO admission blocks exhausted GitHub API capacity with reset and remediation guidance", () => {
  const rateReset = Math.floor(Date.now() / 1000) + 3600;
  const { result, output, summary } = runAdmission({ rateRemaining: 0, rateReset });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, {
    authorized: "false",
    reason: "github-api-capacity-insufficient",
    monthly_credit_budget: "0",
    github_api_status: "limited",
    github_api_limit: "5000",
    github_api_remaining: "0",
    github_api_required: "100",
    github_api_reset_at: new Date(rateReset * 1000).toISOString(),
  });
  assert.match(summary, /Blocked package `dependabot` as `orchestrator` before activation/);
  assert.match(summary, /approximately \*\*60 minutes \(1\.00 hours\)\*\*/);
  assert.match(summary, /### What to do now/);
  assert.match(summary, /Do not rerun before/);
  assert.match(summary, /Making authenticated API requests with a GitHub App|GitHub's Actions authentication guide/);
  assert.match(summary, /fine-grained PAT/);
  assert.match(summary, /GH_AW_GITHUB_TOKEN/);
  assert.match(summary, /docs\.github\.com\/en\/rest\/using-the-rest-api\/rate-limits-for-the-rest-api/);
});
