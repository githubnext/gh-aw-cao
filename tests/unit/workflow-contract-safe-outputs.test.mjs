import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Safe-output reporting, issue, and pull request contracts.

test("operations creation guidance scopes detection and omits worker evals", () => {
  const packageSkill = readFileSync(join(root, "skills", "create-cao-package", "SKILL.md"), "utf8");

  assert.match(packageSkill, /safe-outputs\.threat-detection: false/);
  assert.match(packageSkill, /default new dispatchers to `hourly`/);
  assert.match(packageSkill, /`safe-outputs\.create-issue` or `safe-outputs\.create-pull-request`[\s\S]*?`labels: \[<package-slug>, <package-slug>:<worker-slug>\]`[\s\S]*?`title-prefix: "\[<package-slug>:<worker-slug>\] "`/);
  assert.match(packageSkill, /every created issue or pull request identifies both its owning operation and worker/);
  assert.match(packageSkill, /when `safe-outputs\.create-issue` is enabled, configure `deduplicate-by-title: true`/);
  assert.match(packageSkill, /canonical unprefixed subject that remains identical for the same unresolved repository work across reruns/);
  assert.match(packageSkill, /search all open package-worker issues in the safe-output repository and reuse or comment on matching work, or call `noop`/);
  assert.match(packageSkill, /every issue-creating worker configures `deduplicate-by-title: true`, explicit expiry, bounded `max`, stable subject, and existing-item reuse instructions/);
  assert.match(packageSkill, /Use `3d` for high-frequency telemetry, `7d` for fast-changing operational findings, `14d` for dependency and routine maintenance work, and `30d` only for compliance/);
  assert.match(packageSkill, /Dependabot worker issues expire after `14d`/);
  assert.match(packageSkill, /control-plane workflows inherit `noop\.report-as-issue: false` from `shared\/control\.md`/);
  assert.match(packageSkill, /must not redeclare an empty local `noop:` block because it overrides imported handler settings/);
  assert.match(packageSkill, /Standalone workflows that do not import shared control must configure `safe-outputs\.noop\.report-as-issue: false` explicitly/);
  assert.match(packageSkill, /Do not use sub-issue grouping as backlog control/);
  assert.match(packageSkill, /Expiration is lifecycle cleanup, not duplicate prevention/);
  assert.match(packageSkill, /A model instruction alone is not sufficient when a handler-level safeguard exists/);
  assert.match(packageSkill, /Pull requests:[\s\S]*stable branch or machine-readable body marker[\s\S]*search open pull requests/);
  assert.match(packageSkill, /Comments and reviews:[\s\S]*do not post the same finding or status again/);
  assert.match(packageSkill, /The orchestrator owns idempotent selection and dispatch\. Workers own idempotent repository outputs/);
  assert.match(packageSkill, /singleton package concurrency with `group: "\$\{\{ github\.workflow \}\}"` and `cancel-in-progress: true`/);
  assert.match(packageSkill, /unique worker, target repository, and effective mode tuple/);
  assert.match(packageSkill, /evaluate the potential follow-up actions/);
  assert.match(packageSkill, /single most important action with the highest expected return on investment/);
  assert.match(packageSkill, /<details><summary><b>Agent prompt<\/b><\/summary> \.\.\. <\/details>/);
  assert.match(packageSkill, /human can review the issue before using the prompt for an agentic run/);
  assert.match(packageSkill, /no `evals` configuration; use deterministic graders for worker measurement/);
  assert.match(packageSkill, /Confirm the orchestrator disables threat detection and every worker omits `evals`/);
  assert.match(packageSkill, /CAO operational packages require organization-billed Copilot inference/);
  assert.match(packageSkill, /gh api orgs\/<organization>\/copilot\/billing/);
  assert.match(packageSkill, /`total_seats: 0` with `seat_management_setting: unconfigured` as unavailable/);
  assert.match(packageSkill, /Pi or Codex workflow using a `copilot\/\*` model is Copilot-backed/);
  assert.match(packageSkill, /Do not use `aw\.yml` bootstrap `config`/);
});

test("issue-creating workers use package and worker title prefixes and labels", () => {
  for (const name of readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".md"))) {
    const source = workflow(name);
    if (!/role: worker/.test(source) || !/create-issue:/.test(source)) continue;

    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1];
    assert.ok(frontmatter, `${name} must have frontmatter`);
    const config = parse(frontmatter);
    const controlImport = config.imports.find((entry) => entry.with?.role === "worker");
    assert.ok(controlImport?.with?.package, `${name} must declare its package slug`);
    assert.ok(controlImport?.with?.worker, `${name} must declare its worker slug`);
    assert.equal(
      config["safe-outputs"]["create-issue"]["title-prefix"],
      `[${controlImport.with.package}:${controlImport.with.worker}] `,
      name,
    );
    assert.deepEqual(
      config["safe-outputs"]["create-issue"].labels,
      [controlImport.with.package, `${controlImport.with.package}:${controlImport.with.worker}`],
      name,
    );
  }
});

test("workflow issue outputs are bounded, deduplicated, and centrally quiet on no-op", () => {
  const sharedSource = workflow("shared/control.md");
  const sharedFrontmatter = /^---\n([\s\S]*?)\n---/.exec(sharedSource)?.[1];
  assert.ok(sharedFrontmatter, "shared control must have frontmatter");
  assert.equal(parse(sharedFrontmatter)["safe-outputs"].noop["report-as-issue"], false);

  for (const name of readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".md"))) {
    const source = workflow(name);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1];
    assert.ok(frontmatter, `${name} must have frontmatter`);
    const config = parse(frontmatter);
    const safeOutputs = config["safe-outputs"] ?? {};
    const issue = safeOutputs["create-issue"];
    if (issue) {
      assert.equal(issue["deduplicate-by-title"], true, name);
      if (name === "dependabot-update-planner.md") {
        assert.equal(issue.expires, undefined, `${name} keeps one durable issue across refreshes`);
      } else {
        assert.match(String(issue.expires), /^[1-9][0-9]*d$/, name);
      }
      assert.ok(Number.isInteger(issue.max) && issue.max > 0, `${name} must bound create-issue max`);
      assert.ok(typeof issue["title-prefix"] === "string" && issue["title-prefix"].length > 0, `${name} must prefix issue titles`);
    }

    const importsControl = config.imports?.some((entry) => entry.uses === "shared/control.md");
    if (importsControl) {
      assert.equal(safeOutputs.noop, undefined, `${name} must inherit shared noop policy without overriding it`);
    } else if (safeOutputs.noop) {
      assert.equal(safeOutputs.noop["report-as-issue"], false, name);
    }
  }

  const project = JSON.parse(workflow("aw.json"));
  assert.equal(project.maintenance.action_failure_issue_expires, 24);
  assert.equal(parse(/^---\n([\s\S]*?)\n---/.exec(workflow("docs-explanatory-diagrams.md"))[1])["safe-outputs"].noop["report-as-issue"], false);
});

test("self-care pages health worker creates a fix PR instead of a report issue", () => {
  const source = workflow("self-care-pages-health.md");

  assert.match(source, /create-pull-request:/);
  assert.doesNotMatch(source, /create-issue:/);
  assert.match(source, /Call `create_pull_request` exactly once/);
  assert.match(source, /Fix only the selected quick wins/);
});

test("Dependabot worker maintains one agent-ready issue and never writes pull requests", () => {
  const source = workflow("dependabot-update-planner.md");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1];
  assert.ok(frontmatter, "Dependabot worker must have frontmatter");
  const outputs = parse(frontmatter)["safe-outputs"];

  assert.deepEqual(Object.keys(outputs).sort(), ["add-comment", "create-issue", "update-issue"]);
  assert.equal(outputs["create-issue"].max, 1);
  assert.equal(outputs["create-issue"]["deduplicate-by-title"], true);
  assert.equal(outputs["create-issue"].expires, undefined);
  assert.equal(outputs["update-issue"].body, true);
  assert.equal(outputs["update-issue"].max, 1);
  assert.equal(outputs["add-comment"]["pull-requests"], false);
  assert.equal(outputs["add-comment"].max, 1);
  assert.match(source, /Dependency update plan for <owner>\/<repository>/);
  assert.match(source, /Dependabot update plan refreshed\./);
  assert.match(source, /<summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(source, /complete every unchecked item/);
  assert.match(source, /repo-memory:/);
  assert.match(source, /issue-index\/<safe-output-owner>/);
  assert.match(source, /Do not call `search_issues`/);
  assert.match(source, /target\/\.github\/dependabot\.md/);
  assert.match(source, /Repository guidance/);
  assert.match(source, /Never create, update, push to, comment on, or otherwise mutate a pull request/);
});

test("workers with title prefixes provide unprefixed safe-output titles", () => {
  for (const name of readdirSync(workflowsDirectory).filter((entry) => entry.endsWith(".md"))) {
    const source = workflow(name);
    if (!/^\s+role: worker$/m.test(source) || !/^\s+title-prefix:/m.test(source)) continue;

    assert.match(source, /unprefixed/, name);
    assert.match(source, /configured `title-prefix`/, name);
    assert.match(source, /added automatically/, name);
    assert.match(source, /semantically equivalent category prefix/, name);
  }
});

test("workers inherit human-first progressive report disclosure", () => {
  const packageSkill = readFileSync(join(root, "skills", "create-cao-package", "SKILL.md"), "utf8");
  const sharedControl = workflow("shared/control.md");
  const workers = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name, workflow(name)])
    .filter(([, source]) => /^\s+role: worker$/m.test(source));

  assert.match(packageSkill, /when `safe-outputs\.create-issue` or `safe-outputs\.create-pull-request` is enabled, require every created issue or pull request body to follow the complete Worker Report Formatting contract/);
  assert.match(packageSkill, /mandatory for every worker that creates issues or pull requests and applies to the complete issue or pull request body/);
  assert.match(packageSkill, /Make the report delightful to read, precise, terse, and easy to scan/);
  assert.match(packageSkill, /Use plain language, short sentences, compact bullets, and descriptive labels/);
  assert.match(packageSkill, /Keep the entire visible report to a single screen at normal GitHub desktop viewing/);
  assert.match(packageSkill, /Show only the decision essentials; move everything else into progressive disclosure/);
  assert.match(packageSkill, /Start directly with a concise executive-summary paragraph/);
  assert.match(packageSkill, /Do not add a heading before this opening paragraph because the first paragraph is always the executive summary/);
  assert.match(packageSkill, /After the opening paragraph, use `###` for every main section and `####` for subsections; never use `#` or `##`/);
  assert.doesNotMatch(packageSkill, /Start with the h3 heading `### Summary`/);
  assert.match(packageSkill, /states what happened, the decision-relevant result, critical findings, and key metrics/);
  assert.match(packageSkill, /Immediately follow the summary with one clear `\*\*Action:\*\*` sentence naming who should do what next and the acceptance check/);
  assert.match(packageSkill, /non-essential background, verbose evidence, logs, secondary metrics, and per-item breakdowns in clearly named `<details><summary><b>\.\.\.<\/b><\/summary>/);
  assert.match(packageSkill, /`\> \[!NOTE\]` for neutral status/);
  assert.match(packageSkill, /`\> \[!WARNING\]` for warnings/);
  assert.match(packageSkill, /`\> \[!CAUTION\]` for high-risk or blocking findings/);
  assert.match(packageSkill, /Do not use emoji severity markers/);
  assert.match(sharedControl, /Begin directly with a short, plain-language executive summary/);
  assert.match(sharedControl, /do not add a heading for this opening summary/);
  assert.match(sharedControl, /Immediately follow it with one visible `\*\*Action:\*\*` sentence that says who should do what next and the acceptance check/);
  assert.match(sharedControl, /tell the maintainer to assign the issue to Copilot/);
  assert.match(sharedControl, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(sharedControl, /when no action is required, say `\*\*Action:\*\* None\.`/);
  assert.doesNotMatch(sharedControl, /### Executive Summary/);
  assert.match(sharedControl, /non-essential background, verbose supporting evidence, logs, secondary metrics, and per-item breakdowns inside clearly named `<details>/);
  assert.ok(workers.length > 0, "expected at least one worker workflow");
  for (const [name] of workers) {
    const generated = workflow(name.replace(/\.md$/, ".lock.yml"));
    assert.match(generated, /Begin directly with a short, plain-language executive summary/, name);
    assert.match(generated, /do not add a heading for this opening summary/, name);
    assert.match(generated, /Immediately follow it with one visible `\*\*Action:\*\*` sentence/, name);
    assert.match(generated, /tell the maintainer to assign the issue to Copilot/, name);
    assert.match(generated, /<details><summary><b>Agent prompt<\/b><\/summary>/, name);
    assert.doesNotMatch(generated, /### Executive Summary/, name);
    assert.match(generated, /non-essential background, verbose supporting evidence, logs, secondary metrics, and per-item breakdowns inside clearly named `<details>/, name);
  }
});

test("repository PR automation remains bounded and adapted to CAO", () => {
  const finisher = readFileSync(join(root, ".github", "skills", "pr-finisher", "SKILL.md"), "utf8");
  const sousChef = workflow("pr-sous-chef.md");
  const mattReviewer = workflow("mattpocock-skills-reviewer.md");
  const decisionGate = workflow("design-decision-gate.md");

  assert.match(finisher, /npm run check/);
  assert.match(finisher, /npm run compile:locks/);
  assert.doesNotMatch(finisher, /\bmake (?:fmt|lint|test|recompile)\b/);

  assert.match(sousChef, /push-to-pull-request-branch:/);
  assert.match(sousChef, /bash:\n\s+- "\*"/);
  assert.match(sousChef, /npm ci/);
  assert.match(sousChef, /browsers: \[chrome, chromium\]/);
  assert.match(sousChef, /Chrome for Testing/);
  assert.match(sousChef, /if and only if the pushed commit modifies one or more `\.lock\.yml` files/);
  assert.doesNotMatch(sousChef, /mention `@copilot`/);
  assert.match(sousChef, /fromJSON\(github\.event\.inputs\.aw_context \|\| '\{\}'\)\.item_number/);

  assert.equal([...mattReviewer.matchAll(/mattpocock\/skills\/[\w-]+@[0-9a-f]{40}/g)].length, 5);
  assert.match(mattReviewer, /emitted < 3000/);
  assert.doesNotMatch(mattReviewer, /\|\s*head -n 3000/);
  assert.match(mattReviewer, /fromJSON\(github\.event\.inputs\.aw_context \|\| '\{\}'\)\.item_number/);
  assert.match(mattReviewer, /reaction: none/);
  assert.match(mattReviewer, /slash_command:[\s\S]*?\n\s+name: matt\n\s+strategy: centralized/);
  assert.doesNotMatch(mattReviewer, /\n\s+pull_request:/);

  assert.match(decisionGate, /slash_command:\n\s+strategy: centralized\n\s+name: design-gate/);
  assert.doesNotMatch(decisionGate, /\n\s+(?:pull_request|workflow_dispatch):/);
  assert.match(decisionGate, /allowed-files:\n\s+- "adr\/\*\*"/);
  for (const section of ["Context", "Decision", "Alternatives Considered", "Consequences"]) {
    assert.match(decisionGate, new RegExp(`\`${section}\``));
  }
  assert.match(decisionGate, /Not inferable from current pull request evidence/);
});
