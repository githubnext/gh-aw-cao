import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  permission = "write",
  permissionFailure = false,
  sender = { login: "developer", type: "User" },
  eventInputs = {},
  runPrecompute = false,
  precomputeEnv = {},
  githubActions = true,
  env: extraEnv = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "central-ops-admission-"));
  const mockGh = join(directory, "gh");
  const policyFile = join(directory, "policy.json");
  const githubOutput = join(directory, "github-output");
  const stepSummary = join(directory, "step-summary");
  const eventFile = join(directory, "event.json");
  writeFileSync(eventFile, JSON.stringify({
    sender,
    inputs: {
      safe_output_mode: extraEnv.CAO_REQUESTED_MODE ?? "",
      target_repo: extraEnv.CAO_TARGET_REPOSITORY ?? "",
      safe_output_repo: extraEnv.CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY ?? "",
      ...eventInputs,
    },
  }));
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
  *collaborators/developer/permission*)
    [ "$MOCK_PERMISSION_FAILURE" != "true" ] || exit 1
    printf '{"permission":"%s","user":{"login":"developer","type":"User"}}\\n' "$MOCK_PERMISSION"
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(mockGh, 0o755);

  try {
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CAO_CAMPAIGN: "dependabot",
      CAO_ROLE: "orchestrator",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_ACTIONS: String(githubActions),
      GITHUB_REPOSITORY: "acme/control",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_ACTOR: "developer",
      GITHUB_TRIGGERING_ACTOR: "developer",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      CAO_CORRELATION_ID: "",
      CAO_CENTRAL_REPOSITORY: "",
      CAO_CONTROL_PLANE_RUN_URL: "",
      GITHUB_STEP_SUMMARY: stepSummary,
      MOCK_POLICY_FILE: policyFile,
      MOCK_POLICY_FAILURE: String(policyFailure),
      MOCK_RATE_LIMIT: String(rateLimit),
      MOCK_RATE_REMAINING: String(rateRemaining),
      MOCK_RATE_RESET: String(rateReset),
      MOCK_RATE_FAILURE: String(rateFailure),
      MOCK_PERMISSION: permission,
      MOCK_PERMISSION_FAILURE: String(permissionFailure),
      RUNNER_TEMP: realpathSync(directory),
      GITHUB_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
      ...extraEnv,
    };
    const result = spawnSync("node", [program, "admit"], { encoding: "utf8", env });
    const effectivePath = join(directory, "cao", "effective-policy.json");
    const effective = existsSync(effectivePath) ? JSON.parse(readFileSync(effectivePath, "utf8")) : null;
    const precomputeResult = runPrecompute && effective?.authorized
      ? spawnSync("node", [program, "precompute"], { encoding: "utf8", env: { ...env, ...precomputeEnv } })
      : null;
    return {
      result,
      effective,
      precomputeResult,
      precompute: precomputeResult?.status === 0
        ? JSON.parse(readFileSync("/tmp/gh-aw/agent/control-precompute.json", "utf8")) : null,
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

const debugEnv = {
  CAO_ROLE: "worker",
  CAO_WORKER: "update-planner",
  CAO_REQUESTED_MODE: "debug",
  CAO_TARGET_REPOSITORY: "acme/target",
  CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY: "acme/target",
  CAO_SAFE_OUTPUT_REPOSITORY: "acme/target",
};

test("CAO admits a human manual debug worker and precomputes without a dispatcher", () => {
  const { result, output, admission, effective, precomputeResult, precompute } = runAdmission({
    env: debugEnv, runPrecompute: true,
    policy: controlPolicy({ workerPolicy: { "max-mode": "review" } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.authorized, "true");
  assert.equal(effective.safe_output_mode, "debug");
  assert.equal(admission.debug_actor, "developer");
  assert.equal(admission.safe_outputs_staged, true);
  assert.equal(precomputeResult.status, 0, precomputeResult.stderr);
  assert.equal(precompute.safe_output_mode, "debug");
  assert.equal(precompute.safe_outputs_staged, true);
  assert.equal(precompute.launch_kind, "manual-debug");
  assert.equal(precompute.worker_max_mode, "review");
  assert.equal(precompute.safe_output_repo, "acme/target");
  assert.equal(precompute.correlation_id, "");
  assert.equal(precompute.central_repo, "acme/control");
  assert.equal(precompute.control_plane_run_url, "");
  assert.deepEqual(precompute.candidate_repositories, []);
  assert.deepEqual(precompute.worker_workflows, []);
  assert.match(precomputeResult.stdout, /"worker-dispatch-envelope","outcome":"not-required"/);
});

for (const [name, options, reason] of [
  ["orchestrator", { env: { CAO_ROLE: "orchestrator", CAO_WORKER: "" } }, "debug requires a manual workflow_dispatch worker run"],
  ["schedule", { env: { GITHUB_EVENT_NAME: "schedule" } }, "debug requires a manual workflow_dispatch worker run"],
  ["workflow call", { env: { GITHUB_EVENT_NAME: "workflow_call" } }, "debug requires a manual workflow_dispatch worker run"],
  ["non-Actions invocation", { githubActions: false }, "debug requires a manual workflow_dispatch worker run"],
  ["bot sender", { sender: { login: "developer", type: "Bot" } }, "debug requires the original human dispatch actor"],
  ["bot actor", { env: { GITHUB_ACTOR: "github-actions[bot]" } }, "debug requires the original human dispatch actor"],
  ["different sender", { sender: { login: "someone-else", type: "User" } }, "debug requires the original human dispatch actor"],
  ["different rerun actor", { env: { GITHUB_TRIGGERING_ACTOR: "someone-else" } }, "debug requires the original human dispatch actor"],
  ["read-only actor", { permission: "read" }, "debug actor must have write access to the control repository"],
  ["triage actor", { permission: "triage" }, "debug actor must have write access to the control repository"],
  ["unverifiable actor permission", { permissionFailure: true }, "debug actor write permission could not be verified"],
  ["missing event", { env: { GITHUB_EVENT_PATH: "" } }, "debug requires an authoritative dispatch event"],
  ["unstaged event mode", { eventInputs: { safe_output_mode: "live" } }, "debug inputs must match the authoritative dispatch event"],
  ["different event target", { eventInputs: { target_repo: "acme/other" } }, "debug inputs must match the authoritative dispatch event"],
  ["different event destination", { eventInputs: { safe_output_repo: "acme/other" } }, "debug inputs must match the authoritative dispatch event"],
  ["missing target", { env: { CAO_TARGET_REPOSITORY: "" } }, "debug worker target_repo is required"],
  ["different output destination", { env: { CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY: "acme/review" } }, "debug safe_output_repo must equal target_repo"],
  ["missing output destination", { env: { CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY: "" } }, "debug safe_output_repo must equal target_repo"],
  ["correlation ID", { env: { CAO_CORRELATION_ID: "123-1" } }, "debug must not carry a dispatcher envelope"],
  ["central repo", { env: { CAO_CENTRAL_REPOSITORY: "acme/control" } }, "debug must not carry a dispatcher envelope"],
  ["dispatcher URL", { env: { CAO_CONTROL_PLANE_RUN_URL: "https://github.com/acme/control/actions/runs/123" } }, "debug must not carry a dispatcher envelope"],
  ["outside owner", { env: { CAO_TARGET_REPOSITORY: "outside/target", CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY: "outside/target" } }, "target_repo owner is outside control-plane.scope.allowed-owners"],
  ["outside repository", { policy: controlPolicy({ scope: { "allowed-repositories": ["acme/other"] } }) }, "debug target_repo is not allowed"],
  ["disabled campaign", { policy: controlPolicy({ campaignPolicy: { enabled: false } }) }, "campaign-disabled"],
  ["disabled worker", { policy: controlPolicy({ workerPolicy: { enabled: false } }) }, "worker-disabled"],
  ["undeclared worker", { env: { CAO_WORKER: "not-declared" } }, "unknown worker: dependabot/not-declared"],
  ["raised repository ceiling", { env: { CAO_REQUESTED_MAX_REPOSITORIES: "2" } }, "max_repositories exceeds checked-in policy"],
]) {
  test(`CAO debug admission rejects ${name}`, () => {
    const { result, output } = runAdmission({ ...options, env: { ...debugEnv, ...options.env } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.authorized, "false");
    assert.equal(output.reason, reason);
  });
}

test("debug precompute rechecks actor permission instead of trusting a copied admission", () => {
  const { precomputeResult } = runAdmission({
    env: debugEnv, runPrecompute: true, precomputeEnv: { MOCK_PERMISSION: "read" },
  });
  assert.notEqual(precomputeResult.status, 0);
  assert.match(precomputeResult.stderr, /debug actor must have write access/);
});

for (const permission of ["maintain", "admin"]) {
  test(`debug admission accepts human ${permission} authority`, () => {
    const { output } = runAdmission({ env: debugEnv, permission });
    assert.equal(output.authorized, "true");
  });
}

test("CAO admission authorizes a declared campaign before activation", () => {
  const { result, admission, output, summary } = runAdmission();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "::group::Central Agentic Ops admission",
    '[cao] {"decision":"admission-inputs","outcome":"accepted","campaign":"dependabot","role":"orchestrator","worker":"none","target_requested":false,"mode_narrowing_requested":false,"repository_limit_requested":false,"rollout_narrowing_requested":false}',
    '[cao] {"decision":"policy-source","outcome":"loaded","source":"github.workflow_sha"}',
    '[cao] {"decision":"policy-document","outcome":"validated"}',
    '[cao] {"decision":"effective-policy","outcome":"authorized","reason":"authorized"}',
    '[cao] {"decision":"github-api-capacity","outcome":"available","required":100,"remaining":5000,"limit":5000}',
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
  assert.match(summary, /<details>\n<summary><h3>Central Agentic Ops admission<\/h3><\/summary>\n\nAuthorized campaign `dependabot` as `orchestrator`/);
  assert.match(summary, /- ✅ Runtime revision — The control and policy modules/);
  assert.match(summary, /- ✅ Run limits — Any supplied `max_repos`/);
  assert.equal((summary.match(/<details>/g) ?? []).length, 1);
  assert.equal((summary.match(/^- ✅ /gm) ?? []).length, 10);
  assert.equal(admission.schema_version, 1);
  assert.equal(admission.authorized, true);
  assert.equal(admission.reason, "authorized");
  assert.equal(admission.failed_check, null);
  assert.equal(admission.campaign, "dependabot");
  assert.equal(admission.role, "orchestrator");
  assert.deepEqual([...new Set(admission.checks.map(({ status }) => status))], ["passed"]);
});

test("CAO admission emits plain logs outside GitHub Actions", () => {
  const { result } = runAdmission({ githubActions: false });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "[CAO] Central Agentic Ops admission",
    '[cao] {"decision":"admission-inputs","outcome":"accepted","campaign":"dependabot","role":"orchestrator","worker":"none","target_requested":false,"mode_narrowing_requested":false,"repository_limit_requested":false,"rollout_narrowing_requested":false}',
    '[cao] {"decision":"policy-source","outcome":"loaded","source":"github.workflow_sha"}',
    '[cao] {"decision":"policy-document","outcome":"validated"}',
    '[cao] {"decision":"effective-policy","outcome":"authorized","reason":"authorized"}',
    '[cao] {"decision":"github-api-capacity","outcome":"available","required":100,"remaining":5000,"limit":5000}',
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

test("CAO admission ignores deprecated monthly campaign budgets", () => {
  const { result, output } = runAdmission({
    policy: controlPolicy({ campaignPolicy: { "monthly-ai-credit-budget": 1200 } }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, { authorized: "true", reason: "authorized", monthly_credit_budget: "0" });
});

test("CAO admission denies a disabled campaign without failing the workflow", () => {
  const { result, admission, output, summary } = runAdmission({
    policy: controlPolicy({ campaignPolicy: { enabled: false } }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(output, { authorized: "false", reason: "campaign-disabled", monthly_credit_budget: "0" });
  assert.match(summary, /Skipped campaign `dependabot` as `orchestrator`: campaign-disabled/);
  assert.match(summary, /- ✅ Workflow identity —/);
  assert.match(summary, /- ❌ Campaign —/);
  assert.match(summary, /- Worker —/);
  assert.doesNotMatch(summary, /- [✅❌] Worker —/);
  assert.equal(admission.authorized, false);
  assert.equal(admission.failed_check, "Campaign");
  assert.equal(admission.checks.find(({ check }) => check === "Workflow identity").status, "passed");
  assert.equal(admission.checks.find(({ check }) => check === "Campaign").status, "failed");
  assert.equal(admission.checks.find(({ check }) => check === "Worker").status, "not-evaluated");
  assert.match(result.stdout, /\[cao] {"decision":"effective-policy","outcome":"denied","reason":"campaign-disabled"}/);
  assert.match(result.stdout, /\[cao] {"decision":"github-api-capacity","outcome":"skipped","reason":"policy-denied"}/);
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
  assert.match(summary, /Skipped campaign `dependabot` as `orchestrator`: safe_output_mode exceeds checked-in policy/);
  assert.match(summary, /- ✅ Campaign —/);
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
  assert.match(summary, /Blocked campaign `dependabot` as `orchestrator` before activation/);
  assert.match(summary, /approximately \*\*60 minutes \(1\.00 hours\)\*\*/);
  assert.match(summary, /### What to do now/);
  assert.match(summary, /Do not rerun before/);
  assert.match(summary, /Making authenticated API requests with a GitHub App|GitHub's Actions authentication guide/);
  assert.match(summary, /fine-grained read and write PATs/);
  assert.match(summary, /GH_AW_GITHUB_READ_PAT/);
  assert.match(summary, /GH_AW_GITHUB_WRITE_PAT/);
  assert.match(summary, /docs\.github\.com\/en\/rest\/using-the-rest-api\/rate-limits-for-the-rest-api/);
  assert.match(result.stdout, /\[cao] {"decision":"github-api-capacity","outcome":"limited","required":100,"remaining":0,"limit":5000}/);
});

test("CAO admission diagnostics never include the API token", () => {
  const token = "cao-secret-sentinel-value";
  const { result } = runAdmission({ env: { CAO_API_TOKEN: token } });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(token));
});
