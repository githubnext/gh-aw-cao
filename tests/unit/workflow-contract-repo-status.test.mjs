import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { effectivePolicy, parsePolicy } from "../../.github/workflows/shared/policy.mjs";
import { controlPolicy, root, workflow } from "./workflow-contract.helpers.mjs";

const source = workflow("repo-status-cao.md");
const config = parse(source.split("---")[1]);
const compiled = parse(workflow("repo-status-cao.lock.yml"));
const destination = "${{ inputs.safe_output_repo || github.repository }}";

test("Daily Repo Status is opt-in, manual-only, and denied by its shipped policy", () => {
  assert.deepEqual(Object.keys(config.on).sort(), ["permissions", "workflow_dispatch"]);
  const inputs = config.on.workflow_dispatch.inputs;
  assert.equal(inputs.target_repo.required, true);
  assert.deepEqual(inputs.safe_output_mode.options, ["review"]);
  assert.equal(inputs.safe_output_mode.default, "review");
  assert.equal(compiled.on.schedule, undefined);
  assert.deepEqual(controlPolicy["control-plane"].workflows["repo-status-cao"], {
    enabled: false, mode: "review", "max-mode": "review", "max-repositories": 1,
  });
  const resolved = effectivePolicy(parsePolicy(JSON.stringify(controlPolicy)), {
    role: "standalone", workflowName: "repo-status-cao", controlRepository: "githubnext/gh-cao",
  });
  assert.equal(resolved.authorized, false);
  assert.equal(resolved.reason, "workflow-disabled");
  const manifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));
  assert.doesNotMatch(JSON.stringify(manifest), /repo-status-cao/);
});

test("Daily Repo Status imports standalone admission and binds every read to its explicit target", () => {
  assert.equal(config.engine, "copilot");
  const control = config.imports.find(entry => entry.uses === "shared/control.md");
  assert.deepEqual(control.with, {
    role: "standalone", workflow: "repo-status-cao",
    read_repository: "${{ inputs.target_repo }}",
    read_contents: "read", read_actions: "read", read_issues: "read", read_pull_requests: "read",
  });
  assert.equal(compiled.env.CAO_ROLE, "standalone");
  assert.equal(compiled.env.CAO_WORKFLOW, "repo-status-cao");
  assert.equal(compiled.env.CAO_CAMPAIGN, "__none__");
  assert.equal(config.if, "needs.pre_activation.outputs.cao_authorized == 'true' && inputs.target_repo != '' && inputs.safe_output_mode == 'review'");
  assert.match(compiled.jobs.activation.if, /needs.pre_activation.outputs.cao_authorized == 'true'/);
  assert.match(compiled.jobs.activation.if, /inputs.target_repo != ''/);
  assert.match(compiled.jobs.activation.if, /inputs.safe_output_mode == 'review'/);
  const steps = compiled.jobs.agent.steps;
  assert.equal(steps.find(step => step.id === "cao_target_read_scope").env.CAO_READ_REPOSITORY, "${{ inputs.target_repo }}");
  const readApp = steps.find(step => step.id === "cao_target_read_app_token");
  assert.equal(readApp.with.repositories, "${{ steps.cao_target_read_scope.outputs.repository }}");
  for (const permission of ["actions", "contents", "issues", "pull-requests"]) {
    assert.equal(readApp.with[`permission-${permission}`], "read");
  }
  assert.equal(compiled.jobs.agent.permissions.issues, "read");
  assert.equal(compiled.jobs.agent.permissions.contents, "read");
});

test("Daily Repo Status routes its only mutating output and older-report closure to review", () => {
  const outputs = config["safe-outputs"];
  assert.equal(outputs["create-issue"]["target-repo"], destination);
  assert.equal(outputs["create-issue"].max, 1);
  assert.equal(outputs["create-issue"]["deduplicate-by-title"], true);
  assert.equal(outputs["create-issue"]["close-older-issues"], true);
  assert.equal(outputs["create-issue"]["close-older-key"], "${{ format('repo-status-cao-{0}', inputs.target_repo) }}");
  assert.deepEqual(outputs["allowed-github-references"], []);
  assert.equal(outputs.mentions, false);
  assert.equal(outputs["report-failure-as-issue"], false);
  for (const diagnostic of ["missing-data", "missing-tool", "report-incomplete"]) {
    assert.equal(outputs[diagnostic]["create-issue"], false);
  }
  const steps = compiled.jobs.safe_outputs.steps;
  const handler = steps.find(step => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
  const handlerConfig = JSON.parse(handler.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
  assert.deepEqual(Object.keys(handlerConfig).sort(), [
    "create_issue", "mentions", "missing_data", "missing_tool", "noop", "report_incomplete",
  ]);
  assert.equal(handlerConfig.create_issue["target-repo"], destination);
  assert.equal(handlerConfig.create_issue.close_older_key, outputs["create-issue"]["close-older-key"]);
  assert.equal(handlerConfig.create_issue.close_older_issues, true);
  assert.equal(handlerConfig.create_issue.max, 1);
  assert.equal(handlerConfig.create_issue["allowed-repos"], undefined);
  assert.equal(steps.find(step => step.id === "safe-outputs-app-token").with.repositories, destination);
  const failure = compiled.jobs.conclusion.steps.find(step => step.env?.GH_AW_FAILURE_REPORT_AS_ISSUE);
  assert.equal(failure.env.GH_AW_FAILURE_REPORT_AS_ISSUE, "false");
});

test("Daily Repo Status preserves provenance and has explicit no-op, incomplete, and cutover contracts", () => {
  assert.match(source, /githubnext\/agentics\/workflows\/repo-status\.md at\nb4e175bab6674279e0fe158f7dc877b77bc9d92f/);
  assert.match(source, /Copyright \(c\) 2025 GitHub/);
  assert.match(source, /reconcile upstream updates manually/);
  assert.match(source, /\/tmp\/gh-aw\/agent\/control-precompute\.json/);
  assert.match(source, /empty admitted set is a `noop`/);
  assert.match(source, /`report_incomplete` and stop/);
  assert.match(source, /no live\n+delivery path/);
  assert.match(source, /never discover or dispatch more targets/);
  assert.match(source, /last 24 hours/);
  const guide = readFileSync(join(root, "docs", "repo-status.md"), "utf8");
  assert.match(guide, /gh aw add githubnext\/gh-cao\/\.github\/workflows\/repo-status-cao\.md@main/);
  assert.match(guide, /metadata remain unchanged/);
  assert.match(guide, /Do not run both versions/);
});
