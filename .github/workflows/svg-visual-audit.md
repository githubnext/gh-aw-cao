---
description: "Checks every tracked SVG in light and dark mode for contrast, text overlap, clipping, and overflow."
name: "SVG Visual Audit"
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths:
      - "**/*.svg"
      - ".github/workflows/svg-visual-audit.md"
  workflow_dispatch:
max-ai-credits: 400
max-daily-ai-credits: -1
timeout-minutes: 30
run-name: "SVG visual audit · ${{ github.event.pull_request.number || github.run_number }}"
concurrency:
  group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: read
  copilot-requests: write
strict: true
tools:
  playwright:
    version: "0.1.13"
network:
  allowed:
    - defaults
    - playwright
safe-outputs:
  create-check-run:
    name: "SVG Visual Audit Result"
  upload-artifact:
    max-uploads: 1
    retention-days: 14
    allowed-paths:
      - "/tmp/gh-aw/agent/svg-audit/screenshots/**"
steps:
  - name: Checkout repository
    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
    with:
      persist-credentials: false
  - name: Prepare SVG audit workspace
    shell: bash
    run: |
      set -euo pipefail
      AUDIT_ROOT=/tmp/gh-aw/agent/svg-audit
      mkdir -p "$AUDIT_ROOT/screenshots"
      git ls-files '*.svg' \
        | awk '!/(^|\/)(node_modules|dist|\.astro)\//' \
        | LC_ALL=C sort > "$AUDIT_ROOT/svg-files.txt"
---

# SVG Visual Audit

Audit every SVG listed in `/tmp/gh-aw/agent/svg-audit/svg-files.txt`. Serve the repository inside this agent sandbox and open it with Playwright at `http://127.0.0.1:4321/`.

## Required procedure

1. Read the complete manifest. Do not sample or stop after the first finding. Start the server from Bash in this sandbox, retain its PID, and verify readiness:

   ```bash
   AUDIT_ROOT=/tmp/gh-aw/agent/svg-audit
   python3 -m http.server 4321 \
     --bind 127.0.0.1 \
     --directory "$GITHUB_WORKSPACE" \
     > "$AUDIT_ROOT/server.log" 2>&1 &
   echo $! > "$AUDIT_ROOT/server.pid"
   curl --fail --silent --show-error \
     --retry 10 \
     --retry-connrefused \
     --retry-all-errors \
     --retry-max-time 30 \
     http://127.0.0.1:4321/ > /dev/null
   ```

   If readiness fails, inspect only the relevant tail of `server.log` and report the audit incomplete.
2. Open one Playwright browser session. For every manifest path, URL-encode each path segment and navigate to its repository-relative URL twice:
   - emulate `colorScheme: "light"`, then capture a full-page screenshot;
   - emulate `colorScheme: "dark"`, then capture a full-page screenshot.
3. Save screenshots under `/tmp/gh-aw/agent/svg-audit/screenshots/` with filesystem-safe names ending in `-light.png` and `-dark.png`.
4. Inspect the rendered DOM and screenshot in each mode. Do not infer rendered colors or geometry from SVG source alone.
5. Close the browser and stop the server using the PID in `/tmp/gh-aw/agent/svg-audit/server.pid`.
6. Request one `upload_artifact` safe output containing the screenshot directory.
7. Request exactly one `create_check_run` safe output with the audit result.

Use `playwright-cli browser_run_code` when browser evaluation or `page.emulateMedia()` is needed. Reuse the same page instead of launching a browser per file.

## Contrast checks

- Check every visible text run against its effective painted background using WCAG contrast calculations.
- Require at least `4.5:1` for normal text and `3:1` for text that is at least 24 CSS px, or at least 18.66 CSS px and bold (700 or heavier).
- Require at least `3:1` for meaningful graphical objects and boundaries against adjacent colors when those boundaries are needed to understand the visual.
- Resolve computed colors, opacity, inherited fills, and the actual background beneath the element. Do not assume the page background when an opaque or translucent SVG shape is underneath.
- Ignore hidden, transparent, zero-area, decorative, and non-meaningful elements.

## Text layout checks

- Detect visible text runs that overlap other visible text by more than one CSS pixel in both axes.
- Do not report overlap between a `<text>` element and its own descendant `<tspan>` elements, or between hidden and zero-area nodes.
- Detect text clipped by the SVG viewport or an explicit clip path, truncated labels, and text that escapes its intended containing shape.
- Use DOM bounding boxes as evidence, then confirm each candidate in the screenshot. Do not report intentional text inside a background shape as overlap.
- Report the text content, element identity when available, overlap or clipping bounds, file, and color scheme for every confirmed violation.

## Result contract

The check run must use:

- `failure` when any confirmed contrast, overlap, clipping, or overflow violation exists;
- `success` when every file passes in both modes;
- `action_required` only when the audit could not inspect every manifest entry.

Include a concise table with one row per SVG and separate light/dark statuses. For failures, include measured contrast ratios or bounding-box evidence and a specific remediation. Never claim success if any manifest entry was skipped, failed to render, or produced a blank screenshot.