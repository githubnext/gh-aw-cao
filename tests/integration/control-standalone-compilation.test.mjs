import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root } from "../helpers/control-precompute.mjs";

test("the pinned CLI installs and compiles standalone admission without campaign or worker declarations", () => {
  const directory = mkdtempSync(join(tmpdir(), "cao-standalone-compile-"));
  const workflows = join(directory, ".github", "workflows");
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.error?.message ?? ""}\n${result.stderr}`);
    return result;
  };
  try {
    mkdirSync(workflows, { recursive: true });
    cpSync(join(root, ".github", "workflows", "shared"), join(workflows, "shared"), { recursive: true });
    cpSync(join(root, "tests", "fixtures", "workflows", "fleet-audit.md"), join(workflows, "fleet-audit.md"));
    cpSync(join(root, ".github", "workflows", "cao.json"), join(workflows, "cao.json"));
    run("git", ["init", "--quiet"]);
    run("git", ["add", "--all"]);
    run("git", ["-c", "user.name=CAO Test", "-c", "user.email=cao-test@localhost",
      "commit", "--quiet", "--no-gpg-sign", "-m", "Standalone compilation fixture"]);
    const expectedVersion = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"))["gh-aw-version"];
    assert.ok(run("gh", ["aw", "version"]).stdout.includes(expectedVersion));
    const policyBefore = readFileSync(join(workflows, "cao.json"), "utf8");
    const controlBefore = readFileSync(join(workflows, "shared", "control.md"), "utf8");
    const fixtureBefore = readFileSync(join(workflows, "fleet-audit.md"), "utf8");
    run("gh", ["aw", "add", join(root, ".github", "workflows", "repo-status-cao.md")]);
    assert.equal(readFileSync(join(workflows, "cao.json"), "utf8"), policyBefore);
    assert.equal(readFileSync(join(workflows, "shared", "control.md"), "utf8"), controlBefore);
    assert.equal(readFileSync(join(workflows, "fleet-audit.md"), "utf8"), fixtureBefore);
    run("gh", ["aw", "compile", "--strict", "--no-check-update", "--schedule-seed", "githubnext/gh-cao"]);
    const compiled = parse(readFileSync(join(workflows, "fleet-audit.lock.yml"), "utf8"));
    assert.equal(compiled.env.CAO_ROLE, "standalone");
    assert.equal(compiled.env.CAO_WORKFLOW, "fleet-audit");
    assert.equal(compiled.env.CAO_CAMPAIGN, "__none__");
    const steps = compiled.jobs.pre_activation.steps;
    for (const id of ["cao_admission", "cao_precompute", "cao_precompute_validation"]) {
      const step = steps.find(step => step.id === id);
      assert.ok(step, `missing compiled ${id} step`);
      assert.equal(step.env.CAO_ROLE, "standalone");
      assert.equal(step.env.CAO_WORKFLOW, "fleet-audit");
      assert.equal(step.env.CAO_CAMPAIGN, "__none__");
    }
    assert.match(steps.find(step => step.id === "cao_precompute").env.CAO_SAFE_OUTPUT_REPOSITORY, /env.CAO_ROLE == 'standalone'/);
    assert.match(compiled.jobs.activation.if, /needs.pre_activation.outputs.cao_authorized/);
    const repoStatus = parse(readFileSync(join(workflows, "repo-status-cao.lock.yml"), "utf8"));
    assert.equal(repoStatus.env.CAO_ROLE, "standalone");
    assert.equal(repoStatus.env.CAO_WORKFLOW, "repo-status-cao");
    assert.match(repoStatus.jobs.activation.if, /inputs.safe_output_mode == 'review'/);
    const outputStep = repoStatus.jobs.safe_outputs.steps.find(step => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
    const outputs = JSON.parse(outputStep.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG);
    assert.equal(outputs.create_issue["target-repo"], "${{ inputs.safe_output_repo || github.repository }}");
    assert.equal(outputs.create_issue.close_older_key, "${{ format('repo-status-cao-{0}', inputs.target_repo) }}");
    assert.equal(outputs.create_report_incomplete_issue, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
