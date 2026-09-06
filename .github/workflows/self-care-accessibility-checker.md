---
emoji: "♿"
name: "SelfCare / Accessibility"
description: Audits the Central Agentic Ops documentation web interface for accessibility barriers using axe-core, keyboard traversal, and rendered-page evidence
on:
  bots: ["github-actions[bot]", "cao-githubnext-gh-aw-cao-write[bot]"]
  workflow_dispatch:
    inputs:
      target_repo:
        required: true
        type: string
      safe_output_repo:
        required: true
        type: string
      safe_output_mode:
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
      pages:
        description: "Optional comma-separated site paths to audit (defaults to a representative sample discovered from the build output)"
        required: false
        type: string
  permissions:
    contents: read
    actions: read

checkout:
  repository: ${{ inputs.target_repo }}
  github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
  fetch-depth: 0
  current: true

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

environment: central-agentic-ops

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: self-care
      role: worker
      worker: accessibility-checker

  - uses: shared/worker.md
permissions:
  contents: read
  actions: read
  copilot-requests: write
  issues: read

tracker-id: self-care-accessibility-checker
max-ai-credits: 400
max-daily-ai-credits: -1
engine:
  id: pi
  model: copilot/gpt-5.4
strict: true
timeout-minutes: 30
concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true
run-name: "SelfCare accessibility · ${{ inputs.target_repo }} · ${{ inputs.safe_output_mode || 'review' }}"
runtimes:
  node:
    version: "24"
network:
  allowed:
    - defaults
    - github
    - node
    - chrome
    - playwright
    - local
tools:
  cli-proxy: true
  timeout: 120  # Accessibility sweeps include preview startup and per-page axe-core runs
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [repos, actions]
  playwright:
    version: "0.1.18"
  bash:
    - "*"
safe-outputs:
  allowed-domains:
    - githubnext.github.io
  create-issue:
    target-repo: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
    title-prefix: "[self-care:accessibility-checker] "
    labels: [self-care, self-care:accessibility-checker]
    close-older-issues: true
    close-older-key: self-care-accessibility-checker
    max: 1
    expires: 14d

pre-agent-steps:
  - name: Install documentation dependencies
    if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}
    run: timeout 10m npm ci --ignore-scripts
  - name: Build documentation
    if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}
    run: timeout 10m npm run docs:build
  - name: Fetch the axe-core accessibility engine
    if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}
    env:
      EXPR_GITHUB_WORKSPACE: ${{ github.workspace }}
    run: |
      set -euo pipefail
      mkdir -p "$EXPR_GITHUB_WORKSPACE/.a11y"
      cd "$EXPR_GITHUB_WORKSPACE/.a11y"
      timeout 5m npm pack axe-core@4.13.0 --pack-destination . > axe-pack.log 2>&1
      tar -xzf axe-core-4.13.0.tgz package/axe.min.js
      mv package/axe.min.js axe.min.js
      rm -rf package axe-core-4.13.0.tgz
  - name: Configure Playwright CLI launch options
    if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}
    env:
      EXPR_GITHUB_WORKSPACE: ${{ github.workspace }}
    run: |
      mkdir -p "$EXPR_GITHUB_WORKSPACE/.playwright"
      cat > "$EXPR_GITHUB_WORKSPACE/.playwright/cli.config.json" <<'EOF'
      {
        "browser": {
          "launchOptions": {
            "chromiumSandbox": false,
            "args": ["--no-sandbox", "--disable-setuid-sandbox"]
          }
        }
      }
      EOF
  - name: Playwright browser launch preflight
    if: ${{ inputs.target_repo == 'githubnext/gh-aw-cao' && (inputs.safe_output_mode || 'review') == 'live' }}
    env:
      EXPR_GITHUB_WORKSPACE: ${{ github.workspace }}
    run: |
      set +e
      playwright-cli -s=preflight-chrome open about:blank \
        --browser=chrome \
        --config="$EXPR_GITHUB_WORKSPACE/.playwright/cli.config.json" \
        > "$EXPR_GITHUB_WORKSPACE/.playwright/preflight-chrome.log" 2>&1
      PREFLIGHT_STATUS=$?
      playwright-cli -s=preflight-chrome close >> "$EXPR_GITHUB_WORKSPACE/.playwright/preflight-chrome.log" 2>&1
      set -e
      if [ $PREFLIGHT_STATUS -ne 0 ]; then
        echo "Playwright preflight failed; agent will report the infrastructure blocker."
      fi
---

{{#runtime-import? .github/cao/self-care.md}}

# SelfCare Accessibility Checker

Read `/tmp/gh-aw/agent/control-precompute.json` first. This worker is authorized only when its precomputed `target_repo` is exactly `githubnext/gh-aw-cao` and its precomputed `safe_output_mode` is `live`. If either condition is false, call `noop` once with the denied scope and stop without auditing or publishing findings.

You are an accessibility specialist. Audit this repository's web interface — the Astro documentation site — for accessibility barriers, and publish one prioritized report issue.

## Context

- Repository: ${{ inputs.target_repo }}
- Triggered by: @${{ github.actor }}
- Workflow run: [§${{ github.run_id }}](https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }})
- Requested pages: ${{ inputs.pages || 'auto-discovered sample' }}
- Working directory: ${{ github.workspace }}
- Standard: WCAG 2.2 Level AA

Judge accessibility from rendered browser evidence — the accessibility tree, computed styles, focus state, and axe-core results — never from source markup alone.

## Step 1: Serve the built documentation site

Dependencies were installed from the lockfile and the site was built before the agent started. Do not reinstall dependencies and do not rebuild the site.

Discover the repository's documented preview command and site base path from `package.json` and the Astro configuration, then start the prepared site on an available local port. For this repository, use `npm run docs:preview -- --host 127.0.0.1 --port <port>` so Astro serves the configured base path. Do not use a generic flat static server rooted at `dist/` as the primary preview mechanism; it serves `dist/index.html` but returns 404 for `/gh-aw-cao/` because Astro preview performs the base-path routing. Capture the server log and poll the derived site URL for up to 120 seconds before continuing. Do not assume a port, directory name, or base path.

Before browsing, inspect `${{ github.workspace }}/.playwright/preflight-chrome.log`. `playwright-cli` is a pre-installed CLI binary already on `PATH` in this sandbox — the preflight log records a real launch of it before the agent started. A successful preflight log confirms `playwright-cli` is available; never call `missing_tool` for it based on assumption alone. Only report `playwright-cli` as unavailable if you actually invoke it (for example `playwright-cli -s=audit open about:blank --config "${{ github.workspace }}/.playwright/cli.config.json"`) and it fails with a command-not-found or launch error. If the browser truly cannot start, or the preview server never responds, stop the audit and report the blocker as an infrastructure problem in Step 5 with the exact failing command and error output, rather than as an accessibility finding.

## Step 2: Select pages

If `${{ inputs.pages }}` is set, audit exactly those paths. Otherwise enumerate the generated HTML pages under the documentation build output and select a representative sample of at most eight pages that covers:

- the site landing page;
- a getting-started or tutorial page;
- a long reference page containing tables, code blocks, or diagrams; and
- a page containing images or SVG illustrations.

List the exact URLs you audited in the report.

## Step 3: Run the audit

Playwright is available through `playwright-cli`. Use `${{ github.workspace }}/.playwright/cli.config.json` and one named browser session reused for every page. Do not use Playwright MCP tool names and do not create standalone test projects.

For each selected page, in both `colorScheme: "light"` and `colorScheme: "dark"`:

1. Emulate the color scheme before navigation, navigate with `waitUntil: 'domcontentloaded'` and a 30-second timeout, and confirm the applied scheme with `matchMedia`.
2. Inject the bundled axe-core engine from `${{ github.workspace }}/.a11y/axe.min.js` (read the file and add it as a page script — do not download it at run time) and run it against the WCAG 2.0/2.1/2.2 A and AA rule tags. Record each violation's rule id, impact, WCAG criterion, and failing node selectors.
3. Check what axe-core cannot detect automatically:
   - **Keyboard**: tab through the page and verify every interactive control is reachable, operable, and free of focus traps; verify a working skip-to-content mechanism.
   - **Focus visibility**: confirm each focused control has a visible, sufficiently contrasting focus indicator.
   - **Structure**: verify one `h1`, a heading hierarchy without skipped levels, correct landmark regions, and unique accessible names for repeated navigation.
   - **Names and alternatives**: verify links and buttons have descriptive accessible names, and that informative images, SVGs, and diagrams carry meaningful text alternatives while decorative ones are correctly hidden.
   - **Contrast**: verify text and non-text contrast in the rendered scheme, treating a scheme-inappropriate image or diagram palette as a barrier.
   - **Reflow and zoom**: at a 320 CSS-pixel-wide viewport, verify no horizontal document overflow and no clipped content.
   - **Motion**: verify animated content respects `prefers-reduced-motion`.

Record the page URL, color scheme, viewport, selector, and observed evidence for every finding. Deduplicate findings that share a root cause across pages into a single barrier with an affected-page list.

## Step 4: Prioritize

Classify each barrier as:

- **Blocker** — prevents a disabled user from completing a task (for example a keyboard trap, an unlabeled control, or an inaccessible navigation menu);
- **Serious** — a WCAG 2.2 AA failure with a usable workaround; or
- **Advisory** — a usability or best-practice improvement that is not a conformance failure.

Report only barriers you reproduced with browser evidence. Never report a page or check that was skipped as passing.

## Step 5: Report

Call `create_issue` exactly once, titled `Accessibility Audit - [Date]`. Each run supersedes the previous report, so make the issue self-contained. Publish the report even when no barriers were found, so the clean result and its coverage are recorded.

Provide only the unprefixed subject as the safe-output title. The configured `title-prefix` is added automatically; do not repeat it or add a semantically equivalent category prefix.

Apply the inherited worker report contract exactly:

- Begin the issue body directly with a concise, unheaded executive summary. In one or two short paragraphs, state the decision-relevant result, the most important barrier or clean result, key counts, and the recommended next action. Do not put workflow metadata or the `### Control Plane` section before this summary.
- Keep critical findings, a compact metrics line, and the recommended next action visible. Use a GitHub alert when a blocker, infrastructure failure, or clean result deserves emphasis; never use emoji severity markers.
- Put non-essential background, verbose supporting evidence, logs, the complete finding inventory, and per-page coverage inside `<details><summary><b>...</b></summary>...</details>` sections.
- Use `###` (h3) or lower for headings, never `#` or `##`.
- End with context and no more than three relevant workflow references. Do not add generated-by attribution because the safe-output system appends it.

```markdown
{One or two short, unheaded paragraphs summarizing the result, user impact, key counts, and best next action.}

> [!CAUTION]
> {Blocker status and immediate user impact. Omit this alert when there is no blocker.}

**Audit:** {pages} pages · light and dark · {blockers} blocker · {serious} serious · {advisory} advisory

### Critical Findings
{Keep each blocker and serious issue concise and visible: affected scope, WCAG criterion, one sentence of reproduced browser evidence, and remediation. State `None` when applicable.}

### Recommended Next Action
{Evaluate the possible remediations, select the single most important action with the highest expected return on investment, and explain why it should happen first.}

<details><summary><b>Agent prompt</b></summary>

{A clear, imperative prompt for an agentic run that performs only that selected action. Name the affected component, required accessibility outcome, relevant constraints, and evidence that will verify completion.}

</details>

<details><summary><b>All Findings and Evidence</b></summary>

{Complete deduplicated blocker, serious, and advisory inventory. For each barrier include affected pages, selector, WCAG criterion, color scheme and viewport, reproduced evidence, and concrete remediation.}

</details>

<details><summary><b>Coverage and Audit Notes</b></summary>

{Table of exact audited URLs by color scheme and viewport, skipped checks with reasons, preview or tooling limitations, and concise supporting logs. Never represent a skipped check as passing.}

</details>

### Control Plane
- Correlation ID: ${{ inputs.correlation_id }}
- Central repository: ${{ inputs.central_repo }}
- Control plane run: ${{ inputs.control_plane_run_url }}

**References:** [§${{ github.run_id }}](https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }})
```

If no barriers were found, replace the caution alert with a `[!NOTE]` clean-result alert, keep the zero counts and recommended follow-up visible, and preserve the coverage detail. If the browser or preview server never became available, use the same progressive-disclosure structure with a visible `[!WARNING]` infrastructure summary, zero coverage, and the next recovery action; put the exact failing commands and logs in the audit-notes detail and make no accessibility claims.

Keep the issue body substantive — never placeholder text — require the `self-care` label, and finish with exactly one `create_issue` output.
