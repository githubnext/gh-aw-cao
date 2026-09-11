---
private: true
emoji: "📝"
name: Multi-Device Docs Tester
description: Tests documentation responsiveness and rendering across device sizes, browser engines, and color schemes
on:
  schedule: daily
concurrency:
  group: "${{ github.workflow }}"
  cancel-in-progress: true
  job-discriminator: "${{ github.run_id }}"
permissions:
  contents: read
  copilot-requests: write
  issues: read

tracker-id: multi-device-docs-tester
strict: true
timeout-minutes: 30
runtimes:
  node:
    version: "24"
tools:
  cli-proxy: true
  timeout: 120  # Multi-device runs include preview startup and Playwright tests
  playwright:
    version: "0.1.18"
  bash:
    - "*"
safe-outputs:
  upload-artifact:
    max-uploads: 3
    retention-days: 30
    skip-archive: true
    allowed-paths:
      - "/tmp/gh-aw/agent/multi-device-docs/screenshots/**"
    defaults:
      if-no-files: ignore
  create-issue:
    title-prefix: "[multi-device-docs] "
    deduplicate-by-title: true
    close-older-issues: true
    close-older-key: multi-device-docs-tester
    max: 1
    expires: 3d
  noop:
    report-as-issue: false

network:
  allowed:
    - node
    - chrome
    - playwright

pre-agent-steps:
  - name: Install documentation dependencies
    run: timeout 10m npm ci --ignore-scripts
  - name: Build documentation
    run: timeout 10m npm run docs:build
  - name: Install WebKit browser
    env:
      EXPR_GITHUB_WORKSPACE: ${{ github.workspace }}
      PLAYWRIGHT_BROWSERS_PATH: ${{ runner.temp }}/gh-aw/playwright-browsers
    run: |
      mkdir -p "$EXPR_GITHUB_WORKSPACE/.playwright"
      set +e
      timeout 10m npx --yes playwright@1.63.0-alpha-2026-08-05 install --with-deps webkit \
        > "$EXPR_GITHUB_WORKSPACE/.playwright/webkit-install.log" 2>&1
      WEBKIT_INSTALL_STATUS=$?
      set -e
      if [ $WEBKIT_INSTALL_STATUS -ne 0 ]; then
        echo "WebKit installation failed; agent will report the infrastructure blocker."
      fi
  - name: Configure Playwright CLI launch options
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
      cat > "$EXPR_GITHUB_WORKSPACE/.playwright/webkit.config.json" <<'EOF'
      {}
      EOF
  - name: Playwright browser launch preflight
    id: playwright-preflight
    env:
      EXPR_GITHUB_WORKSPACE: ${{ github.workspace }}
      PLAYWRIGHT_BROWSERS_PATH: ${{ runner.temp }}/gh-aw/playwright-browsers
    run: |
      UNAVAILABLE_BROWSERS=""
      set +e
      for BROWSER in chrome webkit; do
        PREFLIGHT_LOG="$EXPR_GITHUB_WORKSPACE/.playwright/preflight-$BROWSER.log"
        if [ "$BROWSER" = "webkit" ]; then
          CONFIG="$EXPR_GITHUB_WORKSPACE/.playwright/webkit.config.json"
        else
          CONFIG="$EXPR_GITHUB_WORKSPACE/.playwright/cli.config.json"
        fi
        playwright-cli -s="preflight-$BROWSER" open about:blank --browser="$BROWSER" --config="$CONFIG" > "$PREFLIGHT_LOG" 2>&1
        PREFLIGHT_STATUS=$?
        playwright-cli -s="preflight-$BROWSER" close >> "$PREFLIGHT_LOG" 2>&1 || true
        if [ $PREFLIGHT_STATUS -ne 0 ]; then
          UNAVAILABLE_BROWSERS="$UNAVAILABLE_BROWSERS,$BROWSER"
        fi
      done
      set -e
      if [ -n "$UNAVAILABLE_BROWSERS" ]; then
        echo "preflight_failed=1" >> "$GITHUB_OUTPUT"
        echo "unavailable_browsers=${UNAVAILABLE_BROWSERS#,}" >> "$GITHUB_OUTPUT"
        echo "Playwright preflight failed for ${UNAVAILABLE_BROWSERS#,}; agent will report infrastructure blocker separately."
      else
        echo "preflight_failed=0" >> "$GITHUB_OUTPUT"
      fi
features:
  gh-aw-detection: true
---

{{#runtime-import? .github/shared-instructions.md}}

# Multi-Device Documentation Testing

You are a documentation testing specialist. Your task is to comprehensively test the documentation site across multiple devices and form factors.

## Context

- Repository: ${{ github.repository }}
- Triggered by: @${{ github.actor }}
- Devices to test: mobile, tablet, and desktop
- Browser engines to test: Chrome and WebKit
- Color schemes to test: light and dark
- Working directory: ${{ github.workspace }}

Call `noop` if all tests pass or testing is blocked, and `create_issue` if documentation problems are found. If screenshots were captured, call `upload_artifact` before the final result output.

Playwright is available through `playwright-cli`. Use `${{ github.workspace }}/.playwright/cli.config.json` for Chrome and `${{ github.workspace }}/.playwright/webkit.config.json` for WebKit. Inspect `.playwright/preflight-chrome.log`, `.playwright/preflight-webkit.log`, and `.playwright/webkit-install.log` before testing. Report installation or browser startup errors as infrastructure blockers rather than documentation regressions.

## Your Mission

Discover how this repository builds and previews its documentation, start the preview server, and test layout responsiveness, accessibility, interactive elements, and visual rendering across all required device classes, browser engines, and color schemes. Use one named browser session per engine and reuse it for that engine's complete matrix.

## Step 1: Discover and Start the Documentation Site

Inspect committed package manifests, lockfiles, task definitions, and documentation configuration to determine:

- the documentation project root;
- the repository's package manager;
- the documented build and preview commands; and
- the local site base path.

The workflow has already installed dependencies reproducibly from the lockfile and built the documentation outside the agent firewall. Verify the expected dependency and build outputs exist, but do not reinstall dependencies or rebuild the site. Use the repository's discovered preview command to start the prepared site on an available local port. Capture the server log and wait up to 120 seconds for the derived site URL to respond. Do not assume a framework, directory name, script name, port, or URL base path.

If the repository does not define enough information to build and preview its documentation, call `noop` with the missing prerequisite and stop.

## Step 2: Compatibility Matrix

Test all of these device types:

**Mobile:** iPhone 12 (390x844), iPhone 12 Pro Max (428x926), Pixel 5 (393x851), Galaxy S21 (360x800)
**Tablet:** iPad (768x1024), iPad Pro 11 (834x1194), iPad Pro 12.9 (1024x1366)
**Desktop:** HD (1366x768), FHD (1920x1080), 4K (2560x1440)

Test every viewport in both Chrome and WebKit, first with `colorScheme: "light"` and then with `colorScheme: "dark"`. WebKit is a Safari compatibility signal, not proof of behavior on physical iOS hardware; describe it accurately in reports.

## Step 3: Run Browser Tests

Use `playwright-cli <command>` in bash. Do not use Playwright MCP tool names or create standalone scripts. For each engine, open the derived local site URL once in a named session with `--browser` and the matching config, then use `playwright-cli -s=<session> run-code` for color-scheme and viewport-specific checks. Use `page.emulateMedia({ colorScheme })` before navigation and verify the requested scheme with `matchMedia`.

Before device testing, inspect the browser preflight:

```bash
for PREFLIGHT_LOG in "${{ github.workspace }}"/.playwright/preflight-*.log; do
  if grep -qi "error\|failed\|operation not permitted" "$PREFLIGHT_LOG"; then
    echo "Playwright preflight failed before docs checks. See $PREFLIGHT_LOG"
    cat "$PREFLIGHT_LOG"
  fi
done
```

For each browser, color scheme, and viewport:

- navigate with `waitUntil: 'domcontentloaded'` and a 30-second timeout;
- verify the page has a title, one visible main-content region, and no horizontal document overflow;
- check for text or controls clipped outside the viewport;
- inspect every visible diagram, illustration, `<picture>`, `<img>`, SVG `<image>`, CSS background image, and data-URI image for a palette that conflicts with the rendered page color scheme;
- use rendered pixels and browser state such as `currentSrc`, `matchMedia`, and computed styles as evidence; do not infer appearance from source markup alone;
- inspect semantic headings, landmark regions, accessible names, focus visibility, and color-contrast problems that can be established from browser evidence;
- exercise visible same-origin navigation and interactive controls, including a menu or search control when present;
- verify internal navigation reaches the expected same-origin destination;
- capture a full-page screenshot under `/tmp/gh-aw/agent/multi-device-docs/screenshots/` using a filesystem-safe `{browser}-{scheme}-{device}.png` name, and record console errors, failed requests, and broken images.

Discover controls by role, accessible name, and visibility. Do not assume framework-specific classes, routes, or DOM structure. A feature that is absent is not a failure unless the repository's documentation or visible interface claims it exists.

## Step 4: Analyze Results

Organize findings as critical, warning, or passed. Report only reproducible documentation defects; keep infrastructure and test-harness failures separate. A browser/color-scheme combination that was not tested makes the run incomplete, never passed.

## Step 5: Report Results

### Scheduled Runs With NO Issues Found

Call `noop` to log completion:

```json
{
  "noop": {
    "message": "Multi-device documentation testing complete. All {matrix_count} browser, color-scheme, and device combinations passed."
  }
}
```

### Scheduled Runs With Issues Found

Create one issue titled "Multi-Device Docs Testing Report - [Date]" with:

```markdown
### Test Summary
- Triggered by: @${{ github.actor }}
- Workflow run: [§${{ github.run_id }}](https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }})
- Devices tested: {count}
- Browser engines tested: {count}
- Color schemes tested: {count}
- Test date: [Date]

### Results Overview
- Passed: {count}
- Warnings: {count}
- Critical: {count}

### Critical Issues
[List critical issues that block functionality or major accessibility problems - keep visible]

<details>
<summary>View All Warnings</summary>

[Minor issues and potential problems with device names and details]

</details>

<details>
<summary>View Detailed Compatibility Matrix</summary>

[Test results and findings grouped by browser, color scheme, and device]

</details>

### Accessibility Findings
[Key accessibility issues - keep visible as these are important]

### Recommendations
[Actionable recommendations for fixing issues - keep visible]
```

## Step 6: Cleanup

No manual server cleanup is required. The server process will be cleaned up automatically when the agent job exits.

## Summary

Always finish with exactly one result safe output: one `create_issue` or `noop`. An `upload_artifact` request containing captured screenshots may precede that final result output.

Before creating an issue, search all open `[multi-device-docs]` issues. Use the canonical unprefixed subject `Documentation device compatibility requires attention`; keep devices, dates, counts, severity, and run-specific measurements in the body. If an open issue already represents the findings, call `noop` instead of creating another issue.

### Output Format

Use `###` (h3) or lower for all report headers; never use `#` or `##` inside the report body. Wrap long lists, tables, and detailed findings in `<details><summary><b>...</b></summary>...</details>` blocks for progressive disclosure.

Structure reports as: overview → key metrics/issues → collapsible detail → next actions.