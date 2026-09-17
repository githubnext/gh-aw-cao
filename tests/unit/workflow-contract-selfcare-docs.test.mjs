import assert from "node:assert/strict";
import test from "node:test";
import { workflow } from "./workflow-contract.helpers.mjs";

// SelfCare workers that audit documentation, diagrams, and SVG assets.

test("SVG visual audit covers every tracked SVG in both color schemes", () => {
  const source = workflow("svg-visual-audit.md");
  const compiled = workflow("svg-visual-audit.lock.yml");

  assert.match(source, /git ls-files '\*\.svg'/);
  assert.match(source, /colorScheme: "light"/);
  assert.match(source, /colorScheme: "dark"/);
  assert.match(source, /4\.5:1/);
  assert.match(source, /overlap between a `<text>` element and its own descendant `<tspan>`/);
  assert.match(source, /create-check-run:/);
  assert.match(source, /upload-artifact:/);
  assert.match(source, /python3 -m http\.server 4321/);
  assert.match(source, /--bind 127\.0\.0\.1/);
  assert.match(source, /http:\/\/127\.0\.0\.1:4321\//);
  assert.match(source, /--retry-connrefused/);
  assert.doesNotMatch(source, /host\.docker\.internal/);
  assert.doesNotMatch(source, /^\s+- local$/m);
  assert.doesNotMatch(source, /^env:\n\s+NO_PROXY:/m);
  assert.doesNotMatch(compiled, /^  NO_PROXY:/m);
  assert.match(source, /Never claim success if any manifest entry was skipped/);
});

test("multi-device docs tester runs daily and covers browser and appearance compatibility", () => {
  const source = workflow("multi-device-docs-tester.md");
  const compiled = workflow("multi-device-docs-tester.lock.yml");

  assert.match(source, /schedule: daily/);
  assert.doesNotMatch(source, /pull_request:|workflow_dispatch:|inputs\.devices/);
  assert.match(compiled, /cron: "\d+ \d+ \* \* \*"  # Friendly format: daily \(scattered\)/);
  assert.doesNotMatch(compiled, /^  pull_request:/m);
  assert.match(source, /playwright@1\.63\.0-alpha-2026-08-05 install --with-deps webkit/);
  assert.equal(
    (source.match(/PLAYWRIGHT_BROWSERS_PATH: \$\{\{ runner\.temp \}\}\/gh-aw\/playwright-browsers/g) || []).length,
    2,
  );
  assert.match(compiled, /PLAYWRIGHT_BROWSERS_PATH: \$\{\{ runner\.temp \}\}\/gh-aw\/playwright-browsers/);
  assert.match(source, /^      cat > "\$EXPR_GITHUB_WORKSPACE\/\.playwright\/webkit\.config\.json" <<'EOF'\n      \{\}\n      EOF$/m);
  assert.match(source, /for BROWSER in chrome webkit/);
  assert.match(source, /colorScheme: "light"/);
  assert.match(source, /colorScheme: "dark"/);
  assert.match(source, /currentSrc/);
  assert.doesNotMatch(source, /create-check-run:|create_check_run|action_required/);
  assert.match(source, /create-issue:/);
  assert.match(source, /multi-device-docs\/screenshots/);
});

test("SelfCare data acquisition audit refreshes its specification", () => {
  const source = workflow("self-care-data-acquisition-audit.md");
  const compiled = workflow("self-care-data-acquisition-audit.lock.yml");

  assert.match(source, /on:\n\s+bots: \["github-actions\[bot\]", "cao-githubnext-gh-aw-cao-write\[bot\]"\]/);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: data-acquisition-audit/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /draft: true/);
  assert.match(
    source,
    /allowed-files:\n\s+- "specs\/data-acquisition-audit\.md"\n\s+- "specs\/data-acquisition-audit-history\.md"/,
  );
  assert.match(source, /Inspect JavaScript and embedded JavaScript/);
  assert.match(compiled, /specs\/data-acquisition-audit\.md/);
  assert.match(compiled, /specs\/data-acquisition-audit-history\.md/);
});

test("SelfCare runs every 20 minutes", () => {
  const source = workflow("self-care.md");
  const compiled = workflow("self-care.lock.yml");

  assert.match(source, /schedule: every 20 minutes/);
  assert.match(source, /engine: copilot/);
  assert.doesNotMatch(source, /model: copilot\/gpt-5\.4/);
  assert.match(source, /self-care-dashboard-data-schema` and `self-care-glossary`.*preceding 24 hours/);
  assert.match(source, /ten most recent runs of each workflow/);
  assert.match(source, /self-care-pages-health.*no run of that workflow is queued, in progress, or started during the preceding six hours/);
  assert.match(source, /at most the 20 most recent Pages Health workflow runs/);
  assert.match(compiled, /cron: "[0-5]?\d\/20 \* \* \* \*"  # Friendly format: every 20 minutes \(scattered\)/);
  assert.doesNotMatch(compiled, /GH_AW_INFO_MODEL: "copilot\/gpt-5\.4"/);
});

test("SelfCare accessibility checker audits the served docs site with axe-core evidence", () => {
  const source = workflow("self-care-accessibility-checker.md");
  const liveGuard = "if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}";

  assert.match(source, /^name: "SelfCare \/ Accessibility"$/m);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /package: self-care/);
  assert.match(source, /worker: accessibility-checker/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /engine:\n\s+id: pi\n\s+model: copilot\/gpt-5\.4/);
  assert.match(source, /cli-proxy: true/);
  assert.match(source, /playwright:\n\s+version: "0\.1\.18"/);
  assert.match(source, /npm pack axe-core@4\.13\.0/);
  assert.match(source, /npm run docs:preview -- --host 127\.0\.0\.1 --port <port>/);
  assert.match(source, /Do not use a generic flat static server rooted at `dist\/` as the primary preview mechanism/);
  assert.match(source, /Astro preview performs the base-path routing/);
  assert.match(source, /WCAG 2\.2 Level AA/);
  assert.match(source, /playwright-cli` is a pre-installed CLI binary already on `PATH`/);
  assert.match(source, /never call `missing_tool` for it based on assumption alone/);
  assert.match(source, /node_modules\/\.bin\/playwright install chromium/);
  assert.match(source, /Node Playwright package launch preflight/);
  assert.match(source, /preflight-node\.log/);
  assert.match(source, /colorScheme: "light"/);
  assert.match(source, /colorScheme: "dark"/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /safe-outputs:\n\s+allowed-domains:\n\s+- githubnext\.github\.io\n\s+create-issue:/);
  assert.match(source, /create-issue:\n\s+target-repo:.*\n\s+deduplicate-by-title: true\n\s+title-prefix: "\[self-care:accessibility-checker\] "/);
  assert.match(source, /labels: \[self-care, self-care:accessibility-checker\]/);
  assert.match(source, /close-older-key: self-care-accessibility-checker/);
  assert.match(source, /Begin the issue body directly with a concise, unheaded executive summary/);
  assert.match(source, /select the single most important action with the highest expected return on investment/);
  assert.match(source, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(source, /<details><summary><b>All Findings and Evidence<\/b><\/summary>/);
  assert.equal(source.split(liveGuard).length - 1, 7);
  assert.doesNotMatch(source, /^\s+(create-pull-request|add-comment|create-discussion|push-to-pull-request-branch):/m);
});

test("docs diagram generator creates one validated theme-aware SVG pair", () => {
  const source = workflow("docs-explanatory-diagrams.md");

  assert.match(source, /schedule: weekly/);
  assert.match(source, /public\/assets\/\*-light\.svg/);
  assert.match(source, /public\/assets\/\*-dark\.svg/);
  assert.match(source, /data-visual-kind=\"diagram\"/);
  assert.match(source, /check-svg-visual-language\.mjs/);
  assert.match(source, /colorScheme: \"light\"/);
  assert.match(source, /colorScheme: \"dark\"/);
  assert.match(source, /create-pull-request:/);
  assert.match(source, /Call `noop`/);
});

test("SelfCare docs build-time investigator rotates evidenced recommendations", () => {
  const source = workflow("self-care-docs-build-time-investigator.md");

  assert.match(source, /^name: "SelfCare \/ Docs Build Time"$/m);
  assert.match(source, /on:\n\s+bots: \["github-actions\[bot\]", "cao-githubnext-gh-aw-cao-write\[bot\]"\]/);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: docs-build-time-investigator/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /at most the latest 20 completed `docs\.yml` runs from the last 14 days/);
  assert.match(source, /median and p90 durations/);
  assert.match(source, /repo-memory:\n\s+branch-name: memory\/self-care-docs-build-time/);
  assert.match(source, /githubnext__gh-aw-cao__docs-build-time-suggestions\.json/);
  assert.match(source, /Advance `next_category` after every complete evaluation/);
  assert.match(source, /Call `create_issue` exactly once/);
  assert.match(source, /Otherwise call `noop` exactly once/);
  assert.match(source, /title-prefix: "\[self-care:docs-build-time-investigator\] "/);
  assert.doesNotMatch(source, /^\s+(create-pull-request|add-comment|create-discussion|push-to-pull-request-branch):/m);
});

test("SelfCare glossary worker maintains Astro documentation from daily change evidence", () => {
  const source = workflow("self-care-glossary.md");

  assert.match(source, /^name: "SelfCare \/ Glossary"$/m);
  assert.match(source, /package: self-care\n\s+role: worker\n\s+worker: glossary/);
  assert.match(source, /safe_output_mode` is `live`/);
  assert.match(source, /most recent completed successful run of `self-care-glossary`/);
  assert.match(source, /preceding 24 hours/);
  assert.match(source, /at most 50 pull requests merged into the default branch/);
  assert.match(source, /at most 100 default-branch commits/);
  assert.match(source, /normative repository definition plus one implementation use/);
  assert.match(source, /Preserve the existing Astro-compatible YAML frontmatter exactly/);
  assert.match(source, /allowed-files:\n\s+- "docs\/glossary\.md"/);
  assert.match(source, /labels: \[self-care, self-care:glossary\]/);
  assert.match(source, /title-prefix: "\[self-care:glossary\] "/);
  assert.match(source, /draft: true/);
  assert.match(source, /npm run docs:build/);
  assert.match(source, /Call `create_pull_request` exactly once/);
  assert.match(source, /Call `noop` exactly once/);
  assert.doesNotMatch(source, /^evals:/m);
  assert.doesNotMatch(source, /^\s+(contents|actions|pull-requests): write$/m);
});
