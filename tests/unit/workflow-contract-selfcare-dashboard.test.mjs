import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root, workflow } from "./workflow-contract.helpers.mjs";

// SelfCare workers that audit and improve the dashboard.

test("dashboard view assessment issues are ready for agent assignment", () => {
  const source = workflow("dashboard-views.yml");
  const issueReporter = source.slice(source.indexOf("} else {", source.indexOf("if (isPullRequest)")));

  assert.match(issueReporter, /github\.rest\.issues\.create/);
  assert.match(issueReporter, /labels: \['self-care'\]/);
  assert.match(issueReporter, /\*\*Action:\*\* Assign this issue to Copilot/);
  assert.match(issueReporter, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(issueReporter, /npm run test:e2e:dashboard-views/);
});

test("SelfCare dashboard data schema worker tracks every deployed source with Data Health inference", () => {
  const source = workflow("self-care-dashboard-data-schema.md");

  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: dashboard-data-schema/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao\/sources/);
  assert.match(source, /deriveDataHealthSources/);
  assert.match(source, /manifest\.sources\.sort\(\)/);
  assert.match(source, /allowed-files:\n\s+- "specs\/dashboard-data\.md"/);
  assert.match(source, /if-no-changes: ignore/);
  assert.match(source, /labels: \[self-care, self-care:dashboard-data-schema\]/);
  assert.doesNotMatch(source, /npm (?:install|ci)|npx /);
});

test("SelfCare open source failures uses complete dashboard activity evidence", () => {
  const source = workflow("self-care-open-source-failures.md");

  assert.match(source, /^name: "SelfCare \/ Open Source Failures"$/m);
  assert.match(source, /tracker-id: self-care-open-source-failures/);
  assert.match(source, /uses: shared\/activity-cache\.md/);
  assert.match(source, /deployed-workflows\.json/);
  assert.match(source, /snapshot\.schemaVersion !== 1/);
  assert.match(source, /snapshot\.runHealth\?\.available !== true/);
  assert.match(source, /snapshot\.runHealth\?\.complete !== true/);
  assert.match(source, /snapshot\.runHealth\.windowHours < 168/);
  assert.match(source, /workflow\.visibility === "public"/);
  assert.match(source, /failures\.slice\(0, 100\)/);
  assert.match(source, /exactly `githubnext\/gh-aw-cao`/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /Do not discover repositories/);
  assert.match(source, /conclusion-only runs[\s\S]*?corroborating recurrence/);
  assert.match(source, /labels: \[self-care, self-care:open-source-failures\]/);
  assert.match(source, /title-prefix: "\[self-care:open-source-failures\] "/);
  assert.match(source, /max: 3/);
  assert.match(source, /select the single most important action with the highest expected return on investment/i);
  assert.match(source, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.doesNotMatch(source, /^evals:/m);
  assert.doesNotMatch(source, /^graders:/m);
});

test("SelfCare Primer brand checker audits the dashboard against retrieved guidance", () => {
  const source = workflow("self-care-primer-brand-checker.md");
  const compiled = workflow("self-care-primer-brand-checker.lock.yml");
  const liveGuard = "if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}";

  assert.match(source, /^name: "SelfCare \/ Primer"$/m);
  assert.match(source, /package: self-care/);
  assert.match(source, /worker: primer-brand-checker/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /skip-if-match: 'is:pr is:open in:title "Primer branding"'/);
  assert.match(source, /@primer\/brand-mcp@0\.74\.0/);
  assert.match(source, /cli-proxy: true/);
  assert.match(source, /dashboard\/site\/src\/styles\.js/);
  assert.match(source, /dashboard\/site\/src\/\*\*\/\*\.js/);
  assert.match(source, /uses: actions\/cache@/);
  assert.match(source, /path: ~\/\.cache\/ms-playwright/);
  assert.match(source, /npm exec --prefix dashboard\/site -- playwright install --with-deps chromium/);
  assert.match(source, /npm --prefix dashboard\/site run test:e2e/);
  assert.match(source, /create-pull-request:\n\s+target-repo:.*\n\s+title-prefix: "Primer branding: "\n\s+draft: true/);
  assert.match(source, /Always finish by calling exactly one safe-output tool/);
  assert.match(source, /no improvement is needed for any other reason, call `noop` once with a concise plain-text reason/);
  assert.match(source, /Never finish with only a textual response/);
  assert.equal(source.split(liveGuard).length - 1, 3);
  assert.match(compiled, /\\"noop\\":\{\\"max\\":1,\\"report-as-issue\\":\\"false\\"\}/);
});

test("SelfCare reactive UI expert applies the local reactive framework skill", () => {
  const source = workflow("self-care-reactive-ui-expert.md");
  const compiled = workflow("self-care-reactive-ui-expert.lock.yml");

  assert.match(source, /^name: "SelfCare \/ Reactive UI Expert"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: reactive-ui-expert/);
  assert.match(source, /skills:\n\s+- \.github\/skills\/reactive-ui/);
  assert.match(source, /\.github\/skills\/migrate-dashboard-view/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /\.github\/skills\/reactive-ui\/SKILL\.md/);
  assert.match(source, /dashboard\/site\/src\/reactive\.js/);
  assert.match(source, /stable keyed rendering/);
  assert.match(source, /state`, `derived`, `effect`, `batch`, `onCleanup`/);
  assert.match(source, /migrate one JavaScript-produced view source to a request-scoped Dashboard Language query/);
  assert.match(source, /Consider the other task types only when no eligible migration exists/);
  assert.match(source, /Define the query in `dashboard\.queries`/);
  assert.match(source, /data-processor\.js` and `data-worker\.js/);
  assert.match(source, /Run the focused impacted JavaScript tests/);
  assert.match(source, /npm --prefix dashboard\/site run lint/);
  assert.match(source, /npm run docs:build/);
  assert.match(source, /Call `noop` exactly once when no actionable non-duplicate candidate exists/);
  assert.match(source, /draft: true/);
  assert.match(compiled, /self-care-reactive-ui-expert/);
  assert.match(compiled, /\.github\/skills\/reactive-ui/);
});

test("SelfCare dashboard debug logging worker preserves the logging privacy boundary", () => {
  const source = workflow("self-care-dashboard-debug-logging.md");
  const compiled = workflow("self-care-dashboard-debug-logging.lock.yml");

  assert.match(source, /^name: "SelfCare \/ Dashboard Debug Logging"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: dashboard-debug-logging/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /Use `createDebug` from `dashboard\/site\/src\/debug\.js`/);
  assert.match(source, /Never log secrets, tokens, credentials, prompts, raw records, payload bodies/);
  assert.match(source, /disabled unless the `debug` query argument selects the category/);
  assert.match(source, /dashboard\/site\/src\/\*\*\/\*\.js/);
  assert.match(source, /npm --prefix dashboard\/site run typecheck/);
  assert.match(source, /Call `noop` exactly once/);
  assert.match(source, /draft: true/);
  assert.match(compiled, /self-care-dashboard-debug-logging/);
});

test("SelfCare dashboard reviewer checks deployments through stakeholder personas", () => {
  const source = workflow("self-care-dashboard-review.md");
  const compiled = workflow("self-care-dashboard-review.lock.yml");

  assert.match(source, /name: "SelfCare \/ Dashboard"/);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: dashboard-review/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /REPORT_INVENTORY=\/tmp\/gh-aw\/agent\/self-care-dashboard-review\/expected-inventory\.json/);
  assert.match(source, /githubnext\.github\.io\/gh-aw-cao\/cao\//);
  assert.match(source, /^  playwright:\s*$/m);
  assert.match(source, /version: "0\.1\.18"/);
  assert.match(source, /browsers: \[chromium\]/);
  assert.match(compiled, /npm install -g @playwright\/cli@0\.1\.18/);
  assert.match(compiled, /install_playwright_browsers\.sh" chromium/);
  assert.match(compiled, /PLAYWRIGHT_BROWSERS_PATH: \$\{\{ runner\.temp \}\}\/gh-aw\/playwright-browsers/);
  assert.doesNotMatch(source.match(/^env:\n(?:  .*\n)+/m)?.[0] ?? "", /PLAYWRIGHT_BROWSERS_PATH/);
  assert.match(source, /name: Playwright browser launch preflight[\s\S]*?PLAYWRIGHT_BROWSERS_PATH: \$\{\{ runner\.temp \}\}\/gh-aw\/playwright-browsers/);
  assert.doesNotMatch(compiled, /npx --yes playwright@.* install --with-deps chromium/);
  assert.match(source, /playwright-cli -s=preflight-chrome open about:blank[\s\S]*--browser=chromium/);
  assert.match(source, /toolsets: \[repos, issues, actions\]/);
  assert.match(source, /githubnext\.github\.io/);
  assert.match(source, /at most the latest 100 runs from the last 24 hours/);
  assert.match(source, /overview, dispatches, packages, repositories, workflows, runs, and coverage routes/);
  assert.match(source, /title-prefix: "\[self-care:dashboard-review\] "/);
  assert.match(source, /close-older-key: self-care-dashboard-review/);
  assert.match(source, /labels: \[self-care, self-care:dashboard-review\]/);
  assert.match(source, /central-agentic-ops-dashboard/);
  assert.match(source, /view-grader\.mjs/);
  assert.match(source, /dashboard-artifact/);
  assert.match(source, /successful trusted default-branch build/);
  assert.match(source, /normalized Shannon entropy/);
  assert.match(source, /Reject major page, navigation, information-architecture, or view redesigns/);
  assert.match(source, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(source, /Use `\$\{\{ github\.run_id \}\}` as the reproducible random seed/);
  assert.match(source, /Launch the `cfo-dashboard-reviewer`, `cso-dashboard-reviewer`, and `cto-dashboard-reviewer` agents in parallel/);
  assert.match(source, /unique Playwright session name/);
  assert.match(source, /3–5 non-repeating routes and visible interactions per persona/);
  assert.match(source, /representative question/);
  assert.match(source, /grade task efficiency as `efficient`, `workable`, `inefficient`, or `blocked`/);
  assert.match(source, /evidence-backed suggestions for dashboard structure or usability/);
  for (const persona of ["cfo", "cso", "cto"]) {
    assert.match(source, new RegExp(`## agent: \\\`${persona}-dashboard-reviewer\\\``));
  }
  assert.equal(source.match(/^model: small$/gm)?.length, 3);
  assert.doesNotMatch(source, /^\s+(create-pull-request|add-comment|create-discussion|push-to-pull-request-branch):/m);
});

test("SelfCare dashboard performance worker selects one highest-ROI small win", () => {
  const source = workflow("self-care-dashboard-performance.md");
  const dashboard = JSON.parse(readFileSync(join(root, "self-care", "dashboard.json"), "utf8"));
  const views = dashboard.dashboard.pages[0].views;

  assert.match(source, /^name: "SelfCare \/ Dashboard Performance"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: dashboard-performance/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /skip-if-match: 'is:pr is:open "gh-aw-workflow-id: self-care-dashboard-performance" in:body'/);
  assert.match(source, /cache-memory:\n\s+retention-days: 30\n\s+allowed-extensions: \["\.json"\]/);
  assert.match(source, /dashboard-performance-rotation\.json/);
  assert.match(source, /Rank candidates by highest evidence-backed impact per unit of effort/);
  assert.match(source, /Select exactly one highest-ranked actionable candidate/);
  assert.match(source, /at most three production files plus focused tests/);
  assert.match(source, /DASHBOARD_PERFORMANCE_OUTPUT_DIR="\$evidence_root\/before"/);
  assert.match(source, /upload-artifact:[\s\S]*?self-care-dashboard-performance-evidence\/\*\*/);
  assert.match(source, /labels: \[self-care, self-care:dashboard-performance\]/);
  assert.match(source, /title-prefix: "\[self-care:dashboard-performance\] "/);
  assert.match(source, /draft: true/);
  assert.match(source, /dashboard\/site\/index\.html/);
  assert.doesNotMatch(source, /allowed-files:[\s\S]*dashboard\/site\/test\/performance/);
  for (const persona of ["CFO", "CTO", "CSO"]) {
    assert.match(source, new RegExp(persona));
  }
  assert.ok(views.some(({ id }) => id === "self-care-dashboard-performance-runs"));
  assert.ok(views.some(({ id }) => id === "self-care-dashboard-performance-outcomes"));
  assert.ok(views
    .filter(({ id }) => id.startsWith("self-care-dashboard-performance"))
    .every((view) => view.data.filters.workflow.includes(".github/workflows/self-care-dashboard-performance.md")));
  assert.doesNotMatch(source, /^evals:/m);
  assert.doesNotMatch(source, /^graders:/m);
});

test("SelfCare experimental views worker exhaustively checks editable views across browsers and source shapes", () => {
  const source = workflow("self-care-experimental-views.md");
  const orchestrator = workflow("self-care.md");

  assert.match(source, /^name: "SelfCare \/ Experimental Views"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: experimental-views/);
  assert.match(source, /skip-if-match: 'is:pr is:open "gh-aw-workflow-id: self-care-experimental-views" in:body'/);
  assert.match(source, /browsers: \[chromium, webkit\]/);
  assert.match(source, /Require `\.github\/workflows\/cao\.json` to set `control-plane\.web\.experimental` to the Boolean `true`/);
  assert.match(source, /every source experimental navigation section and page to remain in the assembled `dashboard\.json`/);
  assert.match(source, /https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao\/dashboard\.json/);
  assert.match(source, /Navigate every deployed experimental route/);
  assert.match(source, /Do not infer availability from the policy setting alone/);
  assert.match(source, /Operations page shell, every editable view on that page/);
  assert.match(source, /navigation sections with `experimental: true`/);
  assert.match(source, /Ignore every view with `locked: true`/);
  assert.match(source, /Ignore all views on top-level pages in non-experimental navigation sections/);
  assert.match(source, /schema-valid empty, single-row, representative multi-row, missing-optional-field, and high-cardinality inputs/);
  assert.match(source, /document\.querySelectorAll\('\*'\)\.length/);
  assert.match(source, /`disclosure: supplemental`/);
  assert.match(source, /cap the initially rendered records/);
  assert.match(source, /accessible lazy\/virtualized list/);
  assert.match(source, /create-pull-request:/);
  assert.match(source, /draft: true/);
  assert.match(source, /Call `create_pull_request` exactly once/);
  assert.match(orchestrator, /dispatch `self-care-experimental-views` before inspecting run history or dispatching any other worker/);
  assert.match(orchestrator, /Do this on every selected repository run; this worker is not cadence-limited/);
});

test("SelfCare Pages health worker audits every deployed view on three profiles", () => {
  const source = workflow("self-care-pages-health.md");
  const dashboard = JSON.parse(readFileSync(join(root, "self-care", "dashboard.json"), "utf8"));
  const views = dashboard.dashboard.pages[0].views;

  assert.match(source, /^name: "SelfCare \/ Pages Health"$/m);
  assert.match(source, /^\s+workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^\s+schedule:/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: pages-health/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao\//);
  assert.doesNotMatch(source, /close-older-issues: true/);
  assert.doesNotMatch(source, /close-older-key: self-care-pages-health/);
  assert.match(source, /create-pull-request:/);
  assert.match(source, /labels: \[self-care, self-care:pages-health\]/);
  assert.match(source, /self-care-pages-health-evidence\/\*\*/);
  assert.match(source, /each of the `desktop`, `mobile`, and `low-bandwidth` profiles/);
  assert.match(source, /scrolls every deployed dashboard view/i);
  assert.match(source, /executive summary/i);
  assert.match(source, /containing exactly three numbered, evidence-backed, small JavaScript improvements/);
  assert.match(source, /Call `create_pull_request` exactly once/);
  assert.match(source, /Fix only the selected quick wins/);
  assert.ok(views.some(({ id }) => id === "self-care-pages-health-runs"));
  assert.ok(views.some(({ id }) => id === "self-care-pages-health-outcomes"));
  assert.ok(views
    .filter(({ id }) => id.startsWith("self-care-pages-health"))
    .every((view) => view.data.filters.workflow.includes(".github/workflows/self-care-pages-health.md")));
  assert.doesNotMatch(source, /^evals:/m);
  assert.doesNotMatch(source, /^graders:/m);
});

test("SelfCare code improvement preserves its focused dashboard component mission", () => {
  const source = workflow("self-care-code-improvement.md");
  const liveGuard = "if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}";

  assert.match(source, /^name: "SelfCare \/ Code Quality"$/m);
  assert.match(source, /package: self-care/);
  assert.match(source, /worker: code-improvement/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /allowed-files:\n\s+- "dashboard\/site\/src\/\*\.js"\n\s+- "dashboard\/site\/src\/\*\*\/\*\.js"\n\s+- "dashboard\/site\/test\/\*\*\/\*\.js"/);
  assert.match(source, /uses: actions\/cache@/);
  assert.match(source, /path: ~\/\.cache\/ms-playwright/);
  assert.match(source, /npm exec --prefix dashboard\/site -- playwright install --with-deps chromium/);
  assert.equal(source.split(liveGuard).length - 1, 4);
});

test("SelfCare view reuse worker generalizes one Dashboard Language view", () => {
  const source = workflow("self-care-dashboard-language-refactor.md");
  const liveGuard = "if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}";

  assert.match(source, /^name: "SelfCare \/ View Reuse"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: dashboard-language-refactor/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /branches on a built-in page identity, route, view ID, or one-off element name/);
  assert.match(source, /dashboard\/site\/dashboard\.json/);
  assert.match(source, /docs\/dashboard-language-specification\.md/);
  assert.match(source, /dashboard\/site\/src\/specification\.js/);
  assert.match(source, /at least one additional existing or test-fixture composition/);
  assert.match(source, /Update both `dashboard\/aw\.yml` and root `aw\.yml` only when a new runtime file must be packaged/);
  assert.match(source, /npm --prefix dashboard\/site run validate:corpus/);
  assert.match(source, /uses: actions\/cache@/);
  assert.match(source, /path: ~\/\.cache\/ms-playwright/);
  assert.match(source, /npm exec --prefix dashboard\/site -- playwright install --with-deps chromium/);
  assert.match(source, /labels: \[self-care, self-care:dashboard-language-refactor\]/);
  assert.match(source, /title-prefix: "\[self-care:dashboard-language-refactor\] "/);
  assert.equal(source.split(liveGuard).length - 1, 4);
});
