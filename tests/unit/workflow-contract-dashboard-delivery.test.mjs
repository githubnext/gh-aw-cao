import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { generatedJobs, root, script, workflow } from "./workflow-contract.helpers.mjs";

// Dashboard, activity, and documentation delivery workflow contracts.

test("shared activity cache restores into activation and agent jobs", () => {
  const source = workflow("shared/activity-cache.md");

  assert.match(source, /jobs:\n\s+activation:\n\s+pre-steps:/);
  assert.match(source, /\n\s+agent:\n\s+pre-steps:/);
  assert.equal((source.match(/actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/g) || []).length, 2);
  assert.equal((source.match(/path: \|/g) || []).length, 2);
  assert.equal((source.match(/key: cao-activity-v3-lookup-/g) || []).length, 2);
  assert.equal((source.match(/restore-keys: \|[\s\S]*?cao-activity-v3-/g) || []).length, 2);
  assert.doesNotMatch(source, /cao-activity-(?!v3-)/);
  assert.doesNotMatch(source, /actions\/cache\/save@/);
  assert.doesNotMatch(source, /Install SQLite|apt-get install.*sqlite3/);

  for (const name of [
    "cao-evolution-failures-investigator.md",
    "optimization-ai-credit-auditor.md",
    "optimization-ai-credit-optimizer.md",
    "optimization-token-optimizer.md",
    "self-care-open-source-failures.md",
  ]) {
    assert.match(workflow(name), /uses: shared\/activity-cache\.md/, name);
  }
});

test("dashboard authoring corpus workflow generates only validated training examples", () => {
  const source = workflow("dashboard-authoring-corpus.md");
  const dashboardIrSkill = readFileSync(
    join(root, ".github", "skills", "generate-dashboard-ir", "SKILL.md"),
    "utf8",
  );
  const dashboardAuthoringSkill = readFileSync(
    join(root, ".github", "skills", "dashboard-authoring", "SKILL.md"),
    "utf8",
  );

  assert.match(source, /^intent: Improve model reliability/m);
  assert.match(
    source,
    /^skills:\n\s+- \.github\/skills\/dashboard-authoring\n\s+- \.github\/skills\/generate-dashboard-ir$/m,
  );
  assert.match(source, /Use the installed `generate-dashboard-ir` skill/);
  assert.match(source, /npm ci --prefix dashboard\/site --ignore-scripts/);
  assert.match(source, /npm --prefix dashboard\/site run validate:corpus/);
  assert.match(source, /Scope every view to the synthetic workflow with a `workflow` filter/);
  assert.match(source, /Use an attainment-only baseline with null value and cutoff/);
  assert.match(source, /create-pull-request:[\s\S]*?allowed-files:\n\s+- "\.github\/skills\/generate-dashboard-ir\/corpus\/index\.json"\n\s+- "\.github\/skills\/generate-dashboard-ir\/corpus\/examples\/\*\.json"\n\s+- "\.github\/skills\/generate-dashboard-ir\/corpus\/examples\/\*\.dashboard\.yml"/);
  assert.doesNotMatch(source, /allowed-files:\n(?:\s+- .*\n)*\s+- "(?!\.github\/skills\/generate-dashboard-ir\/corpus\/)/);
  assert.match(dashboardIrSkill, /^---\nname: generate-dashboard-ir\n/);
  assert.match(dashboardIrSkill, /specification as the semantic authority/);
  assert.match(dashboardIrSkill, /validator entry point as the syntax and structural validation authority/);
  assert.match(dashboardIrSkill, /Do not introduce a new intermediate language/);
  assert.match(dashboardIrSkill, /Read the specification and `dashboard\/site\/dashboard\.json`/);
  assert.match(dashboardIrSkill, /Reuse an established built-in view pattern/);
  assert.match(dashboardIrSkill, /Return only the validated complete Dashboard Language YAML document/);
  assert.match(dashboardAuthoringSkill, /Pass the intent and operational-value contract to `generate-dashboard-ir`/);
  assert.match(dashboardAuthoringSkill, /Store an operation package's production Dashboard Language document at `<package>\/dashboard\.json`/);
  assert.match(dashboardAuthoringSkill, /destination is `\.github\/aw\/dashboards\/<package>\.json`/);
  assert.match(dashboardAuthoringSkill, /bundles installed `\.github\/aw\/dashboards\/\*\.json` documents into the single deployed `dashboard\.json`/);
  assert.match(dashboardAuthoringSkill, /Do not add package pages directly to `dashboard\/site\/dashboard\.json`/);
  assert.doesNotMatch(dashboardAuthoringSkill, /Select only the Dashboard Language sources and fields/);
  assert.doesNotMatch(dashboardAuthoringSkill, /corpus\/index\.json/);
  assert.match(dashboardIrSkill, /## Corpus procedure/);
});

test("dashboard CI runs the package quality gates", () => {
  const source = workflow("cid.yml");
  const jobs = generatedJobs(source);
  const lintUnit = jobs.get("lint-unit");
  const playwrightIntegration = jobs.get("playwright-integration");
  const ingestionScale = jobs.get("ingestion-scale");
  const lighthousePerformance = jobs.get("lighthouse-performance");
  const lighthouseComment = jobs.get("lighthouse-comment");

  assert.match(source, /dashboard\/site\/\*\*/);
  assert.match(source, /working-directory: dashboard\/site/);
  assert.match(source, /cache-dependency-path: dashboard\/site\/package-lock\.json/);
  assert.deepEqual(
    [...jobs.keys()],
    ["lint-unit", "playwright-integration", "ingestion-scale", "lighthouse-performance", "lighthouse-comment"]
  );
  assert.deepEqual(lintUnit.needs, []);
  assert.deepEqual(playwrightIntegration.needs, []);
  assert.deepEqual(ingestionScale.needs, []);
  // The synthetic ingestion payload is slow, so the gate stays on main.
  assert.match(ingestionScale.block, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(ingestionScale.block, /run: npm run test:e2e:dashboard-ingestion/);
  assert.deepEqual(lighthousePerformance.needs, []);
  assert.deepEqual(lighthouseComment.needs, ["lighthouse-performance"]);
  for (const command of ["npm run typecheck", "npm run lint", "npm test"]) {
    assert.match(lintUnit.block, new RegExp(`run: ${command.replaceAll(".", "\\.")}`));
  }
  assert.doesNotMatch(lintUnit.block, /playwright|test:e2e/i);
  assert.match(playwrightIntegration.block, /uses: actions\/cache@/);
  assert.match(playwrightIntegration.block, /path: ~\/\.cache\/ms-playwright/);
  assert.match(playwrightIntegration.block, /hashFiles\('dashboard\/site\/package-lock\.json'\)/);
  assert.match(playwrightIntegration.block, /npx playwright install --with-deps chromium/);
  assert.match(playwrightIntegration.block, /run: npm run test:e2e/);
  assert.doesNotMatch(playwrightIntegration.block, /run: npm (?:run (?:typecheck|lint)|test)$/m);
  assert.match(lighthousePerformance.block, /npm run test:performance/);
  assert.match(lighthousePerformance.block, /status.*42/);
  assert.doesNotMatch(lighthousePerformance.block, /pull-requests: write/);
  assert.match(lighthousePerformance.block, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(lighthousePerformance.block, /name: dashboard-lighthouse-performance/);
  assert.match(lighthousePerformance.block, /path: dashboard\/site\/test-results\/lighthouse\//);
  assert.match(lighthousePerformance.block, /if: always\(\)/);
  assert.match(
    lighthouseComment.block,
    /if: >-\s+always\(\).*github\.event_name == 'pull_request'.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/s
  );
  assert.doesNotMatch(source, /^\s+pull_request_target:/m);
  assert.match(lighthouseComment.block, /issues: write/);
  assert.match(lighthouseComment.block, /pull-requests: read/);
  assert.doesNotMatch(lighthouseComment.block, /pull-requests: write/);
  assert.match(lighthouseComment.block, /uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(lighthouseComment.block, /continue-on-error: true/);
  assert.match(lighthouseComment.block, /if: steps\.download\.outcome == 'success'/);
  assert.match(lighthouseComment.block, /Array\.isArray\(summary\.results\)/);
  assert.match(lighthouseComment.block, /Lighthouse summary has an unexpected shape; skipping PR feedback/);
  assert.match(lighthouseComment.block, /Array\.isArray\(result\.failures\)/);
  assert.match(lighthouseComment.block, /Lighthouse summary contains unexpected results; skipping malformed entries/);
  assert.match(lighthouseComment.block, /Lighthouse summary contains no usable results; skipping PR feedback/);
  assert.match(lighthouseComment.block, /error instanceof Error \? error\.message : String\(error\)/);
  assert.match(lighthouseComment.block, /head: `\$\{headOwner\}:\$\{headBranch\}`/);
  assert.match(lighthouseComment.block, /using event pull request/);
  assert.match(lighthouseComment.block, /### 📉🚦 Dashboard Lighthouse performance degraded/);
  assert.match(lighthouseComment.block, /### 📈🚦 Dashboard Lighthouse performance results/);
  assert.match(lighthouseComment.block, /const sections = validResults\.map/);
  assert.match(lighthouseComment.block, /All \$\{validResults\.length\} scenarios meet their configured thresholds/);
  assert.match(lighthouseComment.block, /github\.paginate\(github\.rest\.issues\.listComments/);
  assert.match(lighthouseComment.block, /comments\.filter\(\(comment\)/);
  assert.match(lighthouseComment.block, /existing\.slice\(1\)/);
  assert.match(lighthouseComment.block, /issues\.deleteComment/);
  assert.match(lighthouseComment.block, /issues\.updateComment/);
  assert.match(lighthouseComment.block, /issues\.createComment/);
});

test("Dashboard package builds artifacts and deploys Pages in one workflow", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const activityManifest = readFileSync(join(root, "activity", "aw.yml"), "utf8");
  const dashboardManifest = readFileSync(join(root, "dashboard", "aw.yml"), "utf8");
  const rootPackage = parse(rootManifest);
  const dashboardPackage = parse(dashboardManifest);
  const canonicalPolicyResolver = readFileSync(join(root, ".github", "workflows", "shared", "policy.mjs"), "utf8");
  const activityWorkflow = readFileSync(join(root, ".github", "workflows", "cao-activity.yml"), "utf8");
  const activityIndexJob = activityWorkflow.match(/\n  index:\n([\s\S]*?)\n  cache:\n/)?.[1];
  const activityCacheJob = activityWorkflow.match(/\n  cache:\n([\s\S]*)/)?.[1];
  const siteBuildScript = readFileSync(join(root, "dashboard", "site", "scripts", "build.mjs"), "utf8");
  const dashboardWorkflow = readFileSync(join(root, ".github", "workflows", "cao-dashboard.yml"), "utf8");
  const dashboardBuildJob = dashboardWorkflow.match(/\n  build:\n([\s\S]*?)\n  cache:\n/)?.[1];
  const dashboardCacheJob = dashboardWorkflow.match(/\n  cache:\n([\s\S]*?)\n  deploy:\n/)?.[1];
  const dashboardDeployJob = dashboardWorkflow.match(/\n  deploy:\n([\s\S]*)/)?.[1];
  const aicUsage = readFileSync(join(root, "dashboard", "report", "aic-usage.mjs"), "utf8");
  const deployedWorkflows = readFileSync(join(root, "activity", "index.mjs"), "utf8");
  const activityCollector = readFileSync(join(root, "activity", "collect-logs.sh"), "utf8");
  const activityLogs = readFileSync(join(root, "activity", "logs.mjs"), "utf8");
  const activityRunner = readFileSync(join(root, "activity", "run-activity.mjs"), "utf8");
  const operationalValues = readFileSync(join(root, "dashboard", "report", "operational-values.mjs"), "utf8");
  const reportAssets = ["aic-usage.mjs", "activity-collectors.mjs", "bundle-dashboards.mjs", "compose-dashboard-documents.mjs", "configure-site.mjs", "dashboard-language-sources.mjs", "operational-value-history.mjs", "operational-values.mjs", "records.mjs", "text-utils.mjs"];
  const activityEntrypoints = new Set(["activity-collectors.mjs"]);
  const buildEntrypoints = new Set(["bundle-dashboards.mjs", "configure-site.mjs"]);
  const normalizeInclude = (entry, sourcePrefix = "") => typeof entry === "string"
    ? { source: entry, destination: entry, kind: "action-workflow" }
    : { ...entry, source: `${sourcePrefix}${entry.source}` };

  assert.ok(rootPackage.includes.includes("dashboard/aw.yml"));
  assert.match(dashboardManifest, /name: CAO Dashboard/);
  assert.match(rootManifest, /^\s+- dashboard\/aw\.yml$/m);
  assert.match(dashboardManifest, /^\s+- \.github\/workflows\/cao-dashboard\.yml$/m);
  assert.doesNotMatch(dashboardManifest, /cao-dashboard-build|dispatch-workflow/);
  assert.doesNotMatch(dashboardManifest, /destination: \.github\/cao\//);
  assert.match(dashboardManifest, /source: local-server\.mjs\n\s+destination: \.github\/aw\/dashboard\/local-server\.mjs/);
  assert.match(canonicalPolicyResolver, /export function parsePolicy/);
  assert.match(deployedWorkflows, /REPORT_RUN_WINDOW_DAYS/);
  assert.match(activityWorkflow, /REPORT_RUN_WINDOW_DAYS: "30"/);
  assert.doesNotMatch(dashboardWorkflow, /workflow_call:|cao-dashboard-build|dispatch-workflow/);
  assert.match(dashboardWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(dashboardWorkflow, /DISPATCH_WORKFLOW: activity\.yml|Dispatch activity refresh|inputs\.mode/);
  assert.match(dashboardBuildJob, /actions: read[\s\S]*?contents: read/);
  assert.match(dashboardWorkflow, /Restore collected activity data[\s\S]*?id: activity-cache[\s\S]*?actions\/cache\/restore@[0-9a-f]{40}[\s\S]*?restore-keys: \|[\s\S]*?cao-activity-v3-/);
  assert.doesNotMatch(dashboardWorkflow, /fail-on-cache-miss: true/);
  assert.match(dashboardWorkflow, /Restore collected activity data[\s\S]*?path: \|[\s\S]*?gh-aw-logs\.sqlite[\s\S]*?gh-aw-logs-shards[\s\S]*?payload-hashes\.json[\s\S]*?control-settings\.json[\s\S]*?inventory-sources\.json/);
  assert.match(dashboardWorkflow, /Resolve fallback activity run[\s\S]*?if: steps\.activity-cache\.outputs\.cache-matched-key == ''[\s\S]*?listWorkflowRuns\(\{[\s\S]*?workflow_id: 'cao-activity\.yml'[\s\S]*?branch: context\.payload\.repository\.default_branch[\s\S]*?status: 'success'[\s\S]*?per_page: 1[\s\S]*?core\.setOutput\('run-id', String\(run\.id\)\)/);
  assert.match(dashboardWorkflow, /Download fallback activity data[\s\S]*?if: steps\.activity-cache\.outputs\.cache-matched-key == ''[\s\S]*?actions\/download-artifact@[0-9a-f]{40}[\s\S]*?name: cao-activity-index[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity[\s\S]*?repository: \$\{\{ github\.repository \}\}[\s\S]*?github-token: \$\{\{ github\.token \}\}[\s\S]*?run-id: \$\{\{ steps\.activity-artifact-run\.outputs\.run-id \}\}/);
  assert.doesNotMatch(activityWorkflow, /workflow_call:/);
  assert.match(activityWorkflow, /workflow_dispatch:[\s\S]*?request-id:/);
  assert.match(activityWorkflow, /push:\n\s+branches: \[main\]\n\s+paths:\n\s+- \.github\/workflows\/cao\.json\n\s+- \.github\/workflows\/cao-activity\.yml/);
  assert.match(activityWorkflow, /run-name: CAO Activity \/ \$\{\{ inputs\.request-id \|\| github\.run_id \}\}/);
  assert.match(activityWorkflow, /Resolve activity cache key[\s\S]*?cao-activity-v3-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(activityIndexJob, /permissions:\n\s+actions: read\n\s+contents: read/);
  assert.doesNotMatch(activityIndexJob, /actions\/cache\/save@/);
  assert.match(activityIndexJob, /Upload activity snapshot[\s\S]*?retention-days: 1/);
  assert.match(activityCacheJob, /needs: index[\s\S]*?actions: write[\s\S]*?contents: none/);
  assert.match(activityCacheJob, /Download activity snapshot[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity[\s\S]*?Save activity cache/);
  assert.doesNotMatch(activityCacheJob, /GH_AW_GITHUB_READ_APP_PRIVATE_KEY|gh aw logs/);
  assert.match(dashboardWorkflow, /key: cao-activity-v3-lookup-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.doesNotMatch(activityWorkflow, /(?:key|restore-keys): cao-activity-(?!v3-)/);
  assert.doesNotMatch(dashboardWorkflow, /(?:key|restore-keys): cao-activity-(?!v3-)/);
  assert.match(dashboardWorkflow, /Restore collected activity data[\s\S]*?Resolve fallback activity run[\s\S]*?Download fallback activity data[\s\S]*?Validate restored activity data[\s\S]*?Assemble Dashboard Language site/);
  assert.match(dashboardWorkflow, /Validate restored activity data[\s\S]*?ACTIVITY_DATABASE: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?REPORT_GH_AW_LOGS_SHARDS: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards[\s\S]*?REPORT_PAYLOAD_HASHES: \$\{\{ runner\.temp \}\}\/cao-activity\/payload-hashes\.json[\s\S]*?REPORT_CONTROL_SETTINGS: \$\{\{ runner\.temp \}\}\/cao-activity\/control-settings\.json[\s\S]*?REPORT_INVENTORY_SOURCES: \$\{\{ runner\.temp \}\}\/cao-activity\/inventory-sources\.json[\s\S]*?const activityFiles = \[[\s\S]*?process\.env\.ACTIVITY_DATABASE[\s\S]*?process\.env\.REPORT_PAYLOAD_HASHES[\s\S]*?process\.env\.REPORT_CONTROL_SETTINGS[\s\S]*?process\.env\.REPORT_INVENTORY_SOURCES[\s\S]*?process\.env\.REPORT_GH_AW_LOGS_SHARDS/);
  assert.match(dashboardWorkflow, /Required activity data file is missing[\s\S]*?fs\.statSync[\s\S]*?Required activity data file is empty[\s\S]*?Restored activity cache directory contents/);
  assert.match(activityWorkflow, /name: Save activity cache[\s\S]*?path: \|[\s\S]*?gh-aw-logs\.sqlite[\s\S]*?gh-aw-logs-shards[\s\S]*?control-settings\.json[\s\S]*?inventory-sources\.json/);
  assert.match(dashboardWorkflow, /name: Assess activity database health[\s\S]*?await exec\.exec\(process\.execPath,[\s\S]*?'doctor'[\s\S]*?'--database'[\s\S]*?process\.env\.ACTIVITY_DATABASE/);
  assert.doesNotMatch(dashboardWorkflow, /control-settings\.mjs|ACTIVITY_ROOT/);
  assert.doesNotMatch(dashboardWorkflow, /Discover deployed agentic workflows|Collect AI Credit usage|Collect operational-value observations|Collect durable dashboard records/);
  assert.match(activityRunner, /control-settings\.mjs[\s\S]*?\.github\/workflows\/shared\/control\.mjs[\s\S]*?\.github\/workflows\/cao\.json[\s\S]*?controlSettingsPath/);
  assert.match(activityRunner, /REPORT_CONTROL_SETTINGS[\s\S]*?path\.join\(runnerTemp, "cao-activity", "control-settings\.json"\)/);
  assert.doesNotMatch(dashboardWorkflow, /^\s+run:/m);
  assert.equal((dashboardWorkflow.match(/actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/g) || []).length, 8);
  assert.match(dashboardWorkflow, /Install dashboard build dependencies[\s\S]*?await exec\.exec\('npm', \[[\s\S]*?'ci'[\s\S]*?'--prefix'[\s\S]*?process\.env\.DASHBOARD_SITE_ROOT[\s\S]*?'--ignore-scripts'/);
  assert.match(dashboardWorkflow, /Assemble Dashboard Language site[\s\S]*?await exec\.exec\('npm', \[[\s\S]*?'--prefix'[\s\S]*?process\.env\.DASHBOARD_SITE_ROOT[\s\S]*?'run'[\s\S]*?'build'[\s\S]*?process\.env\.REPORT_OUTPUT[\s\S]*?controlSettings/);
  assert.match(dashboardWorkflow, /DASHBOARD_COMMIT_SHA: \$\{\{ github\.workflow_sha \}\}[\s\S]*?process\.env\.DASHBOARD_COMMIT_SHA/);
  assert.match(dashboardWorkflow, /core\.info\('Resolved dashboard source layout: installed'\)[\s\S]*?core\.info\('Resolved dashboard source layout: source'\)/);
  assert.match(dashboardWorkflow, /core\.info\(`Standalone Pages deployment: \$\{deploy \? 'enabled' : 'disabled'\}`\)/);
  assert.match(dashboardWorkflow, /core\.info\('Dashboard build dependencies installed'\)[\s\S]*?core\.info\(`Restored activity data validation completed \(\$\{activityFiles\.length\} files\)`\)[\s\S]*?core\.info\('Activity database health assessment completed'\)[\s\S]*?core\.info\('Dashboard site build completed'\)[\s\S]*?core\.info\(`Dashboard artifact assembly completed \(\$\{collectedFiles\.length\} collected data files\)`\)/);
  assert.doesNotMatch(dashboardWorkflow, /core\.(?:info|error)\(`[^`]*\$\{activityFile\}/);
  assert.match(siteBuildScript, /from "esbuild"/);
  assert.match(dashboardWorkflow, /const collectedFiles = \[[\s\S]*?'inventory-sources\.json'[\s\S]*?'gh-aw-logs\.sqlite'[\s\S]*?'payload-hashes\.json'[\s\S]*?for \(const fileName of collectedFiles\)[\s\S]*?fs\.copyFileSync[\s\S]*?gh-aw-logs-shards[\s\S]*?recursive: true/);
  assert.doesNotMatch(dashboardWorkflow, /REPORT_DASHBOARD_SOURCES|\/sources\.json/);
  assert.doesNotMatch(dashboardManifest, /redirects\.mjs/);
  assert.doesNotMatch(dashboardWorkflow, /legacy dashboard redirects|redirects\.mjs/);
  assert.match(dashboardWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(dashboardCacheJob, /needs: build[\s\S]*?permissions:[\s\S]*?actions: write/);
  assert.match(dashboardCacheJob, /Download dashboard artifact[\s\S]*?name: central-agentic-ops-dashboard[\s\S]*?path: dist\/cao[\s\S]*?Delete previous dashboard cache/);
  assert.match(dashboardCacheJob, /Delete previous dashboard cache[\s\S]*?cache\.key === process\.env\.DASHBOARD_CACHE_KEY[\s\S]*?cache\.ref === process\.env\.GITHUB_REF[\s\S]*?deleteActionsCacheById[\s\S]*?cache_id: cache\.id/);
  assert.match(dashboardCacheJob, /Save dashboard cache[\s\S]*?actions\/cache\/save@[0-9a-f]{40}[\s\S]*?path: dist\/cao[\s\S]*?key: central-agentic-ops-dashboard/);
  assert.match(dashboardWorkflow, /Resolve dashboard deployment policy[\s\S]*?policy\['control-plane'\]\?\.packages\?\.dashboard\?\.deploy[\s\S]*?typeof configuredDeploy !== 'boolean'[\s\S]*?const deploy = configuredDeploy \?\? true[\s\S]*?core\.setOutput\('deploy', String\(deploy\)\)/);
  assert.ok(dashboardBuildJob);
  assert.ok(dashboardCacheJob);
  assert.ok(dashboardDeployJob);
  assert.doesNotMatch(dashboardBuildJob, /actions: write|pages: write|id-token: write|configure-pages|upload-pages-artifact|deploy-pages/);
  assert.match(dashboardDeployJob, /actions: read[\s\S]*?id-token: write[\s\S]*?pages: write/);
  assert.match(dashboardDeployJob, /Download dashboard artifact[\s\S]*?name: central-agentic-ops-dashboard[\s\S]*?Configure Pages[\s\S]*?Upload Pages artifact[\s\S]*?Deploy Pages/);
  assert.match(dashboardWorkflow, /deploy:\n\s+needs: build\n\s+if: needs\.build\.outputs\.deploy == 'true'/);
  assert.match(dashboardWorkflow, /name: CAO Dashboard/);
  assert.match(dashboardWorkflow, /workflow_dispatch:[\s\S]*?push:[\s\S]*?\.github\/aw\/dashboard\/\*\*[\s\S]*?\.github\/workflows\/cao\.json[\s\S]*?dashboard\/\*\*/);
  assert.doesNotMatch(dashboardWorkflow, /workflow_run:/);
  assert.doesNotMatch(dashboardWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(dashboardWorkflow, /\.github\/aw\/dashboards\/\*\*/);
  assert.match(dashboardWorkflow, /"\*\/dashboard\.json"/);
  assert.match(dashboardWorkflow, /github\.event_name == 'push' && github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(dashboardWorkflow, /enablement: false/);
  assert.match(dashboardWorkflow, /pages: write/);
  assert.match(dashboardWorkflow, /id-token: write/);
  assert.doesNotMatch(dashboardWorkflow, /schedule:/);
  assert.equal((dashboardWorkflow.match(/actions\/upload-pages-artifact@/g) || []).length, 1);
  assert.equal((dashboardWorkflow.match(/actions\/deploy-pages@/g) || []).length, 1);
  assert.doesNotMatch(activityWorkflow, /actions\/setup-go|go build|go clean|gh-aw-operational-value/);
  assert.doesNotMatch(dashboardWorkflow, /pages-aic|REPORT_AIC_CACHE/);
  assert.match(activityCollector, /--artifacts usage \\\s+--start-date/);
  assert.match(aicUsage, /const FIREWALL_HORIZON_DAYS = 30/);
  assert.match(activityCollector, /--start-date "-\$\{window_days\}d"/);
  assert.match(activityCollector, /--cache-before "-\$\{window_days\}d"/);
  assert.match(activityCollector, /--count "\$run_limit"/);
  assert.match(activityCollector, /--max-github-api-rate-limit "\$rate_limit"/);
  assert.match(activityCollector, /--max-storage "\$max_storage"/);
  assert.match(activityCollector, /--repo "\$target_repository"/);
  assert.match(activityCollector, /--prune-older-runs/);
  assert.equal((activityCollector.match(/gh aw logs/g) || []).length, 1);
  assert.doesNotMatch(activityLogs, /gh aw logs --audit|runGhAw/);
  assert.doesNotMatch(aicUsage, /spawn|runGhAw|"aw", "logs"|--stdin|mapWithConcurrency|REPORT_AIC_CONCURRENCY/);
  assert.doesNotMatch(activityWorkflow, /REPORT_AIC_CONCURRENCY/);
  assert.match(activityWorkflow, /REPORT_AIC_CACHE: \$\{\{ runner\.temp \}\}\/cao-gh-aw-logs/);
  assert.doesNotMatch(activityWorkflow, /REPORT_AIC_CACHE: \$\{\{ runner\.temp \}\}\/cao-activity\//);
  assert.match(activityWorkflow, /Collect dashboard inventory[\s\S]*?inventory-sources\.mjs[\s\S]*?Download agentic workflow logs/);
  assert.match(dashboardWorkflow, /const collectedFiles = \[[\s\S]*?'inventory-sources\.json'[\s\S]*?for \(const fileName of collectedFiles\)[\s\S]*?fs\.copyFileSync/);
  assert.match(activityWorkflow, /REPORT_GH_AW_LOGS_SHARDS: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards/);
  assert.match(activityWorkflow, /Set up Node\.js[\s\S]*?node-version: 24/);
  assert.doesNotMatch(activityWorkflow, /Install SQLite|apt-get install.*sqlite3/);
  assert.match(activityWorkflow, /Ingest activity database[\s\S]*?gh-aw-logs\.sqlite[\s\S]*?ingest-jsonl[\s\S]*?--input-dir "\$REPORT_GH_AW_LOGS_SHARDS"/);
  assert.match(activityWorkflow, /Hash activity payloads[\s\S]*?hash-payloads[\s\S]*?--database "\$ACTIVITY_DATABASE"[\s\S]*?--shard-dir "\$REPORT_GH_AW_LOGS_SHARDS"[\s\S]*?--output "\$RUNNER_TEMP\/cao-activity\/payload-hashes\.json"/);
  assert.equal((activityWorkflow.match(/path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards/g) || []).length, 3);
  assert.doesNotMatch(activityCacheJob, /Save activity cache[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/m);
  assert.match(activityManifest, /source: cao\.mjs[\s\S]*?destination: \.github\/aw\/activity\/cao\.mjs/);
  assert.match(dashboardManifest, /source: site\/src\/data\/package\.json[\s\S]*?destination: \.github\/aw\/dashboard\/site\/src\/data\/package\.json/);
  assert.match(dashboardManifest, /source: site\/src\/main\.js[\s\S]*?destination: \.github\/aw\/dashboard\/site\/src\/main\.js/);
  assert.match(dashboardManifest, /source: site\/src\/components\/refresh-error\.js[\s\S]*?destination: \.github\/aw\/dashboard\/site\/src\/components\/refresh-error\.js/);
  assert.match(dashboardManifest, /source: site\/src\/data\/storage\/sqlite-indexeddb\.js[\s\S]*?destination: \.github\/aw\/dashboard\/site\/src\/data\/storage\/sqlite-indexeddb\.js/);
  assert.match(aicUsage, /Processing \$\{logs\.length\} cached gh-aw log records/);
  assert.doesNotMatch(activityWorkflow, /REPORT_VALUE_CACHE/);
  assert.doesNotMatch(activityWorkflow, /REPORT_VALUE_REPLAY_CACHE/);
  assert.match(dashboardWorkflow, /actions\/cache\/restore@[0-9a-f]{40}/);
  assert.equal((activityWorkflow.match(/actions\/cache\/restore@/g) || []).length, 1);
  assert.equal((activityWorkflow.match(/actions\/cache\/save@/g) || []).length, 1);
  assert.doesNotMatch(activityWorkflow, /dashboard-operational-values/);
  assert.match(activityWorkflow, /Resolve gh-aw compiler version[\s\S]*control\.mjs compiler-version \.github\/workflows\/cao\.json/);
  assert.match(activityWorkflow, /uses: github\/gh-aw-actions\/setup-cli@[0-9a-f]{40}/);
  assert.match(activityWorkflow, /version: \$\{\{ steps\.gh-aw-compiler\.outputs\.version \}\}/);
  assert.match(activityWorkflow, /control-settings\.mjs" \\\n\s+\.github\/workflows\/shared\/control\.mjs/);
  assert.doesNotMatch(deployedWorkflows, /fetch\(|api\.github\.com|gh api|spawn\(/);
  assert.match(deployedWorkflows, /Build activity index from local workflow inventory/);
  assert.match(deployedWorkflows, /usageArtifactGaps/);
  assert.match(deployedWorkflows, /run\.conclusion === "action_required"\) result\.actionRequired \+= 1/);
  assert.match(deployedWorkflows, /event: firstValue\(run\.event, run\.trigger, null\)/);
  assert.doesNotMatch(deployedWorkflows, /\["failure", "timed_out", "startup_failure", "action_required"\]/);
  assert.match(operationalValues, /workflow\.operationalValue !== true/);
  assert.match(operationalValues, /REPORT_GH_AW_LOGS_SHARDS is required/);
  assert.match(operationalValues, /run\?\.graders\?\.results/);
  assert.doesNotMatch(operationalValues, /runGhAw|gh run|gh aw logs|graders", "operational-value", "report"/);
  assert.match(dashboardManifest, /source: site\/index\.html\n\s+destination: \.github\/aw\/dashboard\/site\/index\.html/);
  assert.match(dashboardManifest, /source: site\/favicon\.svg\n\s+destination: \.github\/aw\/dashboard\/site\/favicon\.svg/);
  assert.match(dashboardManifest, /source: site\/dashboard\.json\n\s+destination: \.github\/aw\/dashboard\/site\/dashboard\.json/);
  assert.match(dashboardManifest, /source: site\/src\/presenter\.js\n\s+destination: \.github\/aw\/dashboard\/site\/src\/presenter\.js/);
  assert.match(dashboardManifest, /source: site\/src\/loading-progress\.js\n\s+destination: \.github\/aw\/dashboard\/site\/src\/loading-progress\.js/);
  for (const assetName of ["data-operations.js", "data-processor.js", "data-worker.js"]) {
    assert.match(dashboardManifest, new RegExp(`source: site/src/${assetName.replace(".", "\\.")}\\n\\s+destination: \\.github/aw/dashboard/site/src/${assetName.replace(".", "\\.")}`));
  }
  for (const assetName of reportAssets) {
    const assetPath = join(root, "dashboard", "report", assetName);
    assert.ok(existsSync(assetPath), `missing report script ${assetName}`);
    assert.match(dashboardManifest, new RegExp(`destination: \\.github/aw/dashboard/report/${assetName.replace(".", "\\.")}`));
    if (activityEntrypoints.has(assetName)) {
      assert.match(activityRunner, new RegExp(`dashboardReportRoot[\\s\\S]*?${assetName.replace(".", "\\.")}`));
    }
    if (buildEntrypoints.has(assetName)) {
      assert.match(siteBuildScript, new RegExp(`\\.\\./\\.\\./report/${assetName.replace(".", "\\.")}`));
    }
    execFileSync(process.execPath, ["--check", assetPath]);
  }
});

test("Activity package owns the shared collected-data cache contract", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));
  const activityManifest = parse(readFileSync(join(root, "activity", "aw.yml"), "utf8"));
  const workflow = readFileSync(join(root, ".github", "workflows", "cao-activity.yml"), "utf8");
  const activityCollector = readFileSync(join(root, "activity", "collect-logs.sh"), "utf8");
  const readme = readFileSync(join(root, "activity", "README.md"), "utf8");
  const packageDocument = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.equal(activityManifest.name, "CAO Activity");
  assert.deepEqual(activityManifest.includes, [
    ".github/workflows/cao-activity.yml",
  ]);
  assert.deepEqual(activityManifest.resources, [
    { source: "cao.mjs", destination: ".github/aw/activity/cao.mjs" },
    { source: "actions-context.mjs", destination: ".github/aw/activity/actions-context.mjs" },
    { source: "actions-log.mjs", destination: ".github/aw/activity/actions-log.mjs" },
    { source: "control-settings.mjs", destination: ".github/aw/activity/control-settings.mjs" },
    { source: "collect-logs.sh", destination: ".github/aw/activity/collect-logs.sh" },
    {
      source: "token-intervention-lifecycle.mjs",
      destination: ".github/aw/activity/token-intervention-lifecycle.mjs",
    },
    { source: "gh-aw-logs.mjs", destination: ".github/aw/activity/gh-aw-logs.mjs" },
    { source: "inventory.mjs", destination: ".github/aw/activity/inventory.mjs" },
    { source: "inventory-sources.mjs", destination: ".github/aw/activity/inventory-sources.mjs" },
  ]);
  assert.ok(rootManifest.includes.includes("activity/aw.yml"));
  assert.match(workflow, /schedule:[\s\S]*?cron:/);
  assert.doesNotMatch(workflow, /workflow_call:/);
  assert.match(workflow, /Resolve dashboard control settings[\s\S]*?\.github\/workflows\/shared\/control\.mjs/);
  assert.doesNotMatch(workflow, /Resolve CAO control source|\.github\/aw\/packages|\.cao-runtime/);
  assert.match(workflow, /uses: github\/gh-aw-actions\/setup-cli@[0-9a-f]{40}/);
  assert.match(workflow, /node "\$activity_root\/control-settings\.mjs" \\\n\s+\.github\/workflows\/shared\/control\.mjs/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*?request-id:/);
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /actions\/cache\/restore@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/cache\/save@[0-9a-f]{40}/);
  assert.equal((workflow.match(/path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards/g) || []).length, 3);
  assert.equal((workflow.match(/\$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json/g) || []).length, 4);
  assert.match(activityCollector, /--drain3-weights "\$drain3_weights_path"/);
  assert.match(activityCollector, /mv "\$generated_weights" "\$drain3_weights_path"/);
  assert.match(workflow, /REPORT_GH_AW_LOGS_SHARDS: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards/);
  assert.match(workflow, /REPORT_AIC_CACHE: \$\{\{ runner\.temp \}\}\/cao-gh-aw-logs/);
  assert.doesNotMatch(workflow, /issues: read/);
  assert.equal((workflow.match(/pull-requests: read/g) || []).length, 3);
  assert.match(workflow, /Generate GitHub App token for activity[\s\S]*?GH_AW_GITHUB_READ_APP_ID[\s\S]*?GH_AW_GITHUB_READ_APP_PRIVATE_KEY/);
  assert.match(workflow, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.equal((workflow.match(/steps\.activity-app-token\.outputs\.token \|\| github\.token/g) || []).length, 3);
  assert.doesNotMatch(workflow, /github-script|ACTIVITY_INDEXER|ACTIVITY_LOGS|ACTIVITY_RUNNER|GITHUB_TELEMETRY|cao-gh\.jsonl/);
  assert.match(workflow, /Restore activity cache[\s\S]*?Download agentic workflow logs[\s\S]*?Upload activity snapshot[\s\S]*?cache:[\s\S]*?needs: index[\s\S]*?Download activity snapshot[\s\S]*?Save activity cache/);
  assert.match(workflow, /Collect dashboard inventory[\s\S]*?activity\/inventory-sources\.mjs[\s\S]*?\.github\/aw\/activity\/inventory-sources\.mjs/);
  assert.match(workflow, /bash "\$collector"/);
  assert.match(activityCollector, /gh aw logs --audit/);
  assert.match(workflow, /Ingest activity database[\s\S]*?gh-aw-logs\.sqlite[\s\S]*?ingest-jsonl/);
  assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/gm) || []).length, 1);
  assert.match(workflow, /cao-activity-v3-\$\{\{ github\.run_id \}\}-/);
  assert.equal(packageDocument.scripts["activity:local"], undefined);
  assert.equal(packageDocument.scripts["activity:local:node"], undefined);
  assert.equal(packageDocument.scripts["activity:run-workflow:local"], undefined);
  assert.match(readme, /gh-aw-logs-shards/);
});

test("Documentation Pages deploys docs with the latest dashboard artifact", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "docs.yml"), "utf8");
  const dashboardWorkflow = readFileSync(join(root, ".github", "workflows", "cao-dashboard.yml"), "utf8");
  const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf8");

  assert.equal(existsSync(join(root, ".github", "workflows", "dashboard-build.yml")), false);
  assert.equal(existsSync(join(root, ".github", "workflows", "documentation-pages.yml")), false);
  assert.equal(existsSync(join(root, ".github", "workflows", "documentation-build.yml")), false);

  assert.doesNotMatch(workflow, /dashboard-build|needs: dashboard/);
  assert.match(workflow, /name: Restore node_modules[\s\S]*?id: node-modules-cache[\s\S]*?actions\/cache\/restore@[0-9a-f]{40}[\s\S]*?path: node_modules[\s\S]*?key: \$\{\{ runner\.os \}\}-node-24-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
  assert.match(workflow, /name: Install dependencies\n\s+if: steps\.node-modules-cache\.outputs\.cache-hit != 'true'\n\s+run: npm ci/);
  assert.match(workflow, /name: Save node_modules[\s\S]*?if: steps\.node-modules-cache\.outputs\.cache-hit != 'true'[\s\S]*?actions\/cache\/save@[0-9a-f]{40}[\s\S]*?path: node_modules[\s\S]*?key: \$\{\{ steps\.node-modules-cache\.outputs\.cache-primary-key \}\}/);
  assert.match(workflow, /run: npm run docs:build/);
  assert.match(workflow, /schedule:\n\s+- cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /inputs\.mode|"mode":/);
  assert.match(workflow, /workflow_run:[\s\S]*?workflows:[\s\S]*?- CAO Dashboard[\s\S]*?types:[\s\S]*?- completed/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /Restore cached CAO Dashboard[\s\S]*?id: dashboard-cache[\s\S]*?actions\/cache\/restore@[0-9a-f]{40}[\s\S]*?path: dist\/cao[\s\S]*?key: central-agentic-ops-dashboard/);
  assert.match(workflow, /Find latest CAO Dashboard run[\s\S]*?if: steps\.dashboard-cache\.outputs\.cache-hit != 'true'[\s\S]*?actions\/workflows\/cao-dashboard\.yml\/runs\?branch=\$DEFAULT_BRANCH&status=success&per_page=20[\s\S]*?\.workflow_runs\[0\]\.id/);
  assert.match(workflow, /Mount latest CAO Dashboard artifact[\s\S]*?if: steps\.dashboard-cache\.outputs\.cache-hit != 'true'[\s\S]*?name: central-agentic-ops-dashboard[\s\S]*?path: dist\/cao[\s\S]*?run-id: \$\{\{ steps\.dashboard-run\.outputs\.run-id \}\}/);
  assert.doesNotMatch(workflow, /gh aw add|DASHBOARD_PACKAGE/);
  assert.equal((workflow.match(/actions\/upload-pages-artifact@/g) || []).length, 1);
  assert.equal((workflow.match(/actions\/deploy-pages@/g) || []).length, 1);
  assert.doesNotMatch(dashboardWorkflow, /workflow_call:/);
  assert.match(dashboardWorkflow, /workflow_dispatch:/);
  assert.match(dashboardWorkflow, /gh-aw-logs-shards[\s\S]*?recursive: true/);
  assert.match(dashboardWorkflow, /name: central-agentic-ops-dashboard/);
  assert.match(dashboardWorkflow, /core\.exportVariable\('DASHBOARD_LAYOUT', 'source'\)/);
  assert.match(dashboardWorkflow, /core\.exportVariable\('DASHBOARD_LAYOUT', 'installed'\)/);
  assert.match(dashboardWorkflow, /push:|deploy-pages|upload-pages-artifact/);
  assert.match(astroConfig, /base: "\/gh-aw-cao"/);
  assert.match(astroConfig, /rewriteDocsLinks, \{ base: "\/gh-aw-cao" \}/);
  assert.match(astroConfig, /githubnext\/gh-aw-cao\/edit\/main/);
  assert.match(astroConfig, /href: "https:\/\/github\.com\/githubnext\/gh-aw-cao"/);
  assert.match(astroConfig, /label: "Control plane status", link: "\/cao\/"/);
});

test("mobile dashboard integration downloads deployed dashboard data", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "actions.yml"), "utf8");
  const packageDocument = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.match(workflow, /pull_request:[\s\S]*?dashboard\/\*\*/);
  assert.match(workflow, /concurrency:\n\s+group: mobile-dashboard-integration-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/);
  assert.match(workflow, /deployed-data:[\s\S]*?if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /mobile:[\s\S]*?if: github\.event_name != 'push'/);
  assert.match(workflow, /include: \$\{\{ fromJSON\(github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /refs\/heads\/main' && '[^']*Pixel 7[^']*' \|\| '\[\{"browser":"webkit","device":"iPhone 15"\}\]'/);
  assert.match(workflow, /name: Test deployed dashboard data ingestion\n\s+run: node --test tests\/integration\/dashboard-deployed-data\.test\.mjs/);
  assert.match(workflow, /DASHBOARD_DATA_URL: https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao\/payload-hashes\.json/);
  assert.match(workflow, /Test mobile dashboard with restricted memory[\s\S]*?MOBILE_MEMORY_MB: 256/);
  assert.match(workflow, /Test mobile dashboard with throttled network[\s\S]*?MOBILE_NETWORK_DOWNLOAD_KBPS: 1600/);
  assert.match(workflow, /Test mobile dashboard with restricted memory and network[\s\S]*?MOBILE_MEMORY_MB: 256[\s\S]*?MOBILE_NETWORK_LATENCY_MS: 150/);
  assert.match(workflow, /Upload mobile analysis evidence[\s\S]*?if: always\(\)[\s\S]*?path: test-results\/[\s\S]*?retention-days: 1/);
  assert.match(workflow, /mobile-analysis-comment:[\s\S]*?permissions:[\s\S]*?pull-requests: write/);
  assert.match(workflow, /github\.event_name == 'pull_request'[\s\S]*?Comment with mobile analysis[\s\S]*?mobile-dashboard-analysis/);
  assert.match(workflow, /\| Visible target size \| Visible reflow \| Zoom \| Visible accessible names \|/);
  assert.match(workflow, /no visible targets/);
  assert.match(workflow, /existsSync\('mobile-analysis'\)/);
  assert.match(workflow, /width min.*height min/);
  const playwrightConfig = readFileSync(join(root, "playwright.mobile.config.mjs"), "utf8");
  assert.match(playwrightConfig, /preserveOutput: "always"/);
  assert.match(playwrightConfig, /--max-old-space-size=\$\{memoryMb\}/);
  assert.match(packageDocument.scripts["dashboard:local:mobile"], /DASHBOARD_DATA_URL=https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao\/payload-hashes\.json/);
  assert.match(packageDocument.scripts["dashboard:local:mobile"], /MOBILE_DEVICE='Pixel 7'/);
  assert.match(packageDocument.scripts["dashboard:local:mobile"], /MOBILE_MEMORY_MB=256/);
  assert.match(packageDocument.scripts["dashboard:local:mobile"], /playwright\.mobile\.config\.mjs/);
  const mobileTest = readFileSync(join(root, "tests", "e2e", "dashboard-mobile-live.spec.mjs"), "utf8");
  assert.match(mobileTest, /Network\.emulateNetworkConditions/);
  assert.match(mobileTest, /Performance\.getMetrics/);
  assert.match(mobileTest, /HeapProfiler\.collectGarbage/);
  assert.match(mobileTest, /Memory\.getDOMCounters/);
  assert.match(mobileTest, /VmRSS/);
  assert.match(mobileTest, /payload-hashes\.json/);
  assert.match(mobileTest, /gh-aw-logs-shards\\\/\[A-Za-z0-9\._-\]\+\\\.jsonl/);
  assert.match(mobileTest, /inventory-sources\.json/);
  assert.match(mobileTest, /for \(const \[name\] of shards\)[\s\S]*?pipeline\(response\.body, createWriteStream\(shardPath\)\)/);
  assert.doesNotMatch(mobileTest, /fetch\(dataUrl\)/);
  assert.doesNotMatch(mobileTest, /logsResponse\.text\(\)/);
  assert.match(mobileTest, /mobile-dashboard\.png/);
  assert.match(mobileTest, /minimumTargetSize/);
  assert.match(mobileTest, /horizontal page scrolling/);
  assert.match(workflow, /Peak process PSS \| Peak JS heap \| Retained JS heap \| Source payload/);
  const deployedDataTest = readFileSync(join(root, "tests", "integration", "dashboard-deployed-data.test.mjs"), "utf8");
  assert.match(deployedDataTest, /Object\.keys\(manifest\)[\s\S]*?gh-aw-logs-shards\/[\s\S]*?ingestCachedGhAwJsonl\(indexedDB, shard\.body/);
  assert.doesNotMatch(deployedDataTest, /response\.text\(\)/);
  assert.match(deployedDataTest, /event\.source === "firewall"/);
  for (const source of ["workflows", "runs", "events"]) {
    assert.match(deployedDataTest, new RegExp(`readCollection\\(indexedDB, "${source}"\\)`));
  }
  assert.doesNotMatch(workflow, /actions\/cache|cao-dashboard-/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
});

test("Documentation site uses stock Starlight without external themes", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const astroConfig = readFileSync(join(root, "astro.config.mjs"), "utf8");
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

  assert.deepEqual(Object.keys(dependencies).filter((name) => name.startsWith("starlight-theme-")), []);
  assert.doesNotMatch(astroConfig, /starlight-theme-/);
});

test("Dashboard inventory links multiline orchestrator worker lists", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "central-agentic-ops-inventory-"));
  const outputPath = join(temporaryRoot, "control-plane.json");
  try {
    execFileSync(process.execPath, [join(root, "activity", "inventory.mjs")], {
      env: { ...process.env, REPORT_ROOT: root, REPORT_INVENTORY: outputPath },
    });
    const inventory = JSON.parse(readFileSync(outputPath, "utf8"));
    const dependabotBundle = inventory.bundles.find((bundle) => bundle.id === "dependabot");
    const registeredPackageIds = Object.keys(
      JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"))["control-plane"].packages,
    ).sort();
    assert.deepEqual(inventory.packages.map((entry) => entry.id), registeredPackageIds);
    assert.equal(inventory.packages.find((entry) => entry.id === "repo-assist")?.name, "Repo Assist");
    assert.equal(dependabotBundle.readmePath, "dependabot/README.md");
    assert.match(dependabotBundle.readme, /^# Dependabot Package\n/);
    assert.match(dependabotBundle.readme, /## Safety Boundaries/);
    assert.deepEqual(inventory.bundles.map((bundle) => ({
      id: bundle.id,
      workers: bundle.workers.map((worker) => worker.id),
    })), [
      { id: "cao-evolution", workers: ["cao-evolution-integrity", "cao-evolution-reliability", "cao-evolution-efficiency", "cao-evolution-catalog-advisor", "cao-evolution-failures-investigator", "cao-evolution-compiler-security"] },
      { id: "dependabot", workers: ["dependabot-release-train-updater"] },
      {
        id: "eslint-rules",
        workers: [
          "eslint-rules-inventory",
          "eslint-rules-miner",
          "eslint-rules-refiner",
          "eslint-rules-applier",
          "eslint-rules-librarian",
        ],
      },
      {
        id: "eu-cra-compliance",
        workers: [
          "eu-cra-compliance-scope-classifier",
          "eu-cra-compliance-security-requirements-auditor",
          "eu-cra-compliance-supply-chain-sbom-auditor",
          "eu-cra-compliance-vulnerability-handling-auditor",
          "eu-cra-compliance-article-14-reporting-readiness",
          "eu-cra-compliance-conformity-release-evidence",
        ],
      },
      {
        id: "optimization",
        workers: [
          "optimization-ai-credit-auditor",
          "optimization-ai-credit-optimizer",
          "optimization-agents-md-curator",
          "optimization-skills-curator",
          "optimization-token-optimizer",
        ],
      },
      {
        id: "repo-assist",
        workers: [
          "repo-assist-issue-triage",
          "repo-assist-issue-fix",
          "repo-assist-maintenance",
          "repo-assist-pr-upkeep",
        ],
      },
      {
        id: "self-care",
        workers: [
          "self-care-accessibility-checker",
          "self-care-code-improvement",
          "self-care-dashboard-data-schema",
          "self-care-dashboard-debug-logging",
          "self-care-dashboard-performance",
          "self-care-data-acquisition-audit",
          "self-care-dashboard-language-refactor",
          "self-care-dashboard-review",
          "self-care-docs-build-time-investigator",
          "self-care-experimental-views",
          "self-care-glossary",
          "self-care-open-source-failures",
          "self-care-pages-health",
          "self-care-primer-brand-checker",
          "self-care-reactive-ui-expert",
        ],
      },
      {
        id: "software-development-practices",
        workers: [
          "software-development-practices-github-well-architected",
          "software-development-practices-nist-ssdf",
        ],
      },
      { id: "uk-ai-advisory", workers: ["uk-ai-advisory-operational-resilience"] },
    ]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
