---
emoji: ":mag:"

description: "Daily audit and forecast of AI Credit (AIC) usage across all agentic workflows with historical trend tracking"

name: "AW Optimization / AI Credit Audit"

max-ai-credits: 350
max-daily-ai-credits: -1

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
  permissions:
    contents: read
    actions: read

checkout:
  - repository: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
    github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
    fetch-depth: 0
    fetch: ["*"]
    current: true
  - repository: ${{ inputs.target_repo }}
    github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
    path: target

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
      package: optimization
      role: worker
      worker: ai-credit-auditor
  - uses: shared/activity-cache.md

permissions:
  contents: read
  actions: read
  copilot-requests: write
  issues: read
  pull-requests: read

strict: true

network:
  allowed:
    - defaults
    - python

run-name: "Token audit · ${{ inputs.target_repo }} · ${{ inputs.safe_output_mode || 'review' }}"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

graders:
  operational-value:
    run: .github/graders/optimization-ai-credit-auditor-operational-value.sh

tracker-id: optimization-ai-credit-auditor

tools:
  github:
    mode: remote
    toolsets: [repos, issues, pull_requests, actions]
  agentic-workflows:
  bash:
    - "*"
  repo-memory:
    branch-name: "memory/token-audit-${{ inputs.central_repo }}-${{ inputs.target_repo }}"
    description: "Historical daily workflow AI credit snapshots (shared with optimization-ai-credit-optimizer)"
    file-glob: ["*.json", "*.jsonl", "*.csv", "*.md"]
    max-file-size: 102400
    max-patch-size: 51200

safe-outputs:
  create-issue:
    expires: 3d
    title-prefix: "[optimization:ai-credit-auditor] "
    labels: [optimization, optimization:ai-credit-auditor]
    max: 1
    close-older-issues: true
    target-repo: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  upload-artifact:
    max-uploads: 5
    retention-days: 14
    skip-archive: true
    allowed-paths:
      - "/tmp/gh-aw/token-audit/charts/**"
  upload-asset:
    #target-repo: ${{ env.SAFE_OUTPUT_REPO }} Does not compile with this, this is a bug
    allowed-exts: [.png, .jpg, .jpeg, .svg]
    max: 5

timeout-minutes: 35

steps:
  - name: Setup Python
    uses: actions/setup-python@v7.0.0
    with:
      python-version: "3.12"
  - name: Setup local chart workspace
    run: |
      mkdir -p /tmp/gh-aw/token-audit/charts /tmp/gh-aw/token-audit/site-packages
  - name: Install Python chart dependencies
    run: |
      python3 -m pip install --quiet --target /tmp/gh-aw/token-audit/site-packages pandas matplotlib seaborn
  - name: Download agentic workflow logs
    env:
      GH_TOKEN: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
      GH_REPO: ${{ inputs.target_repo }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/token-audit
      WINDOW_END=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at)
      WINDOW_START=$(date -u -d "$WINDOW_END - 24 hours" +%Y-%m-%dT%H:%M:%SZ)

      RAW_LOGS=/tmp/gh-aw/token-audit/workflow-logs.raw.json
      LOG_EXIT=0
      gh aw logs \
        --repo "$TARGET_REPO" \
        --output /tmp/gh-aw/token-audit/logs \
        --start-date -2d \
        --json \
        -c 100 \
        --timeout 10 \
        --max-github-api-rate-limit -2000 \
        --max-storage 1024 \
        > "$RAW_LOGS" || LOG_EXIT=$?

      if jq -e . "$RAW_LOGS" >/dev/null 2>&1; then
        jq --arg windowStart "$WINDOW_START" --arg windowEnd "$WINDOW_END" '
          ((.runs // []) | unique_by(.run_id)
            | map(select(.created_at >= $windowStart and .created_at < $windowEnd))) as $runs |
          {
            window_start: $windowStart,
            window_end: $windowEnd,
            summary: {
              total_runs: ($runs | length),
              total_tokens: ($runs | map(.token_usage // 0) | add // 0),
              total_aic: ($runs | map(.aic // 0) | add // 0)
            },
            runs: $runs
          }
        ' "$RAW_LOGS" > /tmp/gh-aw/token-audit/workflow-logs.json
        TOTAL=$(jq '.runs | length' /tmp/gh-aw/token-audit/workflow-logs.json)
        echo "✅ Downloaded $TOTAL agentic workflow runs (last 24 hours, exit code $LOG_EXIT)"
      else
        echo "⚠️ Agentic workflow logs were unavailable or invalid (exit code $LOG_EXIT)"
        jq -cn --arg windowStart "$WINDOW_START" --arg windowEnd "$WINDOW_END" \
          '{window_start:$windowStart,window_end:$windowEnd,runs:[],summary:{}}' \
          > /tmp/gh-aw/token-audit/workflow-logs.json
      fi
      rm -f "$RAW_LOGS"
  - name: Forecast AI Credit spend
    env:
      GH_TOKEN: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
      TARGET_REPOSITORY: ${{ inputs.target_repo }}
    run: |
      set -uo pipefail
      FORECAST_DIR=/tmp/gh-aw/token-audit
      FORECAST_JSON="$FORECAST_DIR/forecast.json"
      FORECAST_METADATA="$FORECAST_DIR/forecast-metadata.txt"
      mkdir -p "$FORECAST_DIR"

      FORECAST_EXIT_CODE=0
      gh aw forecast \
        --repo "$TARGET_REPOSITORY" \
        --days 30 \
        --period month \
        --sample 100 \
        --concurrency 8 \
        --timeout 10 \
        --verbose \
        --json \
        > "$FORECAST_JSON" || FORECAST_EXIT_CODE=$?

      FORECAST_JSON_VALID=false
      if jq -e '(.period | type == "string") and (.workflows | type == "array")' "$FORECAST_JSON" >/dev/null 2>&1; then
        FORECAST_JSON_VALID=true
      fi

      {
        printf 'exit_code=%s\n' "$FORECAST_EXIT_CODE"
        printf 'json_valid=%s\n' "$FORECAST_JSON_VALID"
        printf 'repository=%s\n' "$TARGET_REPOSITORY"
        printf 'generated_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
      } > "$FORECAST_METADATA"

      echo "Forecast exit code: $FORECAST_EXIT_CODE"
      echo "Forecast JSON valid: $FORECAST_JSON_VALID"

source: githubnext/gh-aw-cao/.github/workflows/optimization-ai-credit-auditor.md@main
---

{{#runtime-import? .github/cao/optimization.md}}

You are the Agentic Workflow Auditor — a workflow that tracks daily AI Credit (AIC) spend and token consumption, forecasts weekly and monthly cost, and maintains a historical record for trend analysis across all agentic workflows in the target repository.

## Workspace Layout

Read target-repository evidence from `target/`. Treat the workspace root as the repository where safe outputs land.

In `live`, the workspace root may be the target repository itself. In `review`, the workspace root is the control-plane repository.

Recreate safe outputs there without pretending the control-plane repo is the target repo: keep issues as issues, prefer `upload_artifact` for charts and other audit evidence, and use `upload_asset` only when you need a persistent URL.

## Mission

1. Parse the pre-downloaded agentic workflow logs and compute per-workflow AI credit spend and token usage metrics.
2. Validate the precomputed `gh aw forecast` output and calculate weekly and monthly AIC and estimated USD scenarios.
3. Persist today's snapshot to repo-memory so the optimizer (and future runs of this audit) can read historical data.
4. Publish a concise audit issue summarizing today's AI credit spend, projected cost, data quality, and trend highlights.

## Data Sources

### Pre-downloaded logs

The workflow logs are at `/tmp/gh-aw/token-audit/workflow-logs.json`. The file is the raw JSON output of `gh aw logs --json` with this top-level shape:

```json
{
  "summary": { "total_runs": N, "total_tokens": N, ... },
  "runs": [ ... ],
  "tool_usage": [ ... ],
  "mcp_tool_usage": { ... },
  ...
}
```

Each element of `.runs` is a `RunData` object with (among others):

| Field | Type | Notes |
|---|---|---|
| `workflow_name` | string | Human-readable name |
| `workflow_path` | string | `.github/workflows/....lock.yml` |
| `aic` | float | AI Credits (AIC) consumed (primary billing metric; 1 AI credit = $0.01 USD) |
| `token_usage` | int | Total tokens (`omitempty` — treat missing/null as 0) |
| `effective_tokens` | int | Legacy normalized token metric (deprecated; use `aic` for billing) |
| `action_minutes` | float | Billable GitHub Actions minutes |
| `turns` | int | Number of agent turns |
| `duration` | string | Human-readable duration |
| `created_at` | ISO 8601 | Run creation time |
| `run_id` | int64 | Unique run ID |
| `url` | string | Link to the run |
| `status` | string | `completed`, `in_progress`, etc. |
| `conclusion` | string | `success`, `failure`, etc. |
| `error_count` | int | Errors encountered |
| `warning_count` | int | Warnings encountered |
| `token_usage_summary` | object or null | Firewall-level breakdown by model |

### Precomputed forecast

The 30-day forecast is at `/tmp/gh-aw/token-audit/forecast.json`, and command status is at `/tmp/gh-aw/token-audit/forecast-metadata.txt`. Read both files before reporting a forecast. The JSON is the direct output of:

```bash
gh aw forecast --repo "$TARGET_REPO" --days 30 --period month --sample 100 --concurrency 8 --timeout 10 --verbose --json
```

Use these current forecast fields:

| Field | Meaning |
|---|---|
| `workflows[].sampled_runs` | Runs used by the projection |
| `workflows[].p50_aic_per_run`, `p95_aic_per_run` | Per-run AIC percentiles |
| `workflows[].weekly_monte_carlo` | Weekly `p10_projected_aic`, `p50_projected_aic`, `p90_projected_aic`, and `is_reliable` |
| `workflows[].monthly_monte_carlo` | Monthly `p10_projected_aic`, `p50_projected_aic`, `p90_projected_aic`, and `is_reliable` |
| `workflows[].weekly_projected_aic`, `monthly_projected_aic` | Point-estimate fallbacks when a Monte Carlo object is absent |
| `workflows[].run_samples` | Historical run IDs, dates, URLs, and AIC used by the projection |

AI Credits are the gh-aw cost metric. Use `1 AIC = $0.01 USD` for estimated cost conversion. Label every USD amount as an estimate and state that billing dashboards remain authoritative.

### Repo-memory (historical snapshots)

Previous snapshots live at `/tmp/gh-aw/repo-memory/default/`. For local runs, each daily snapshot is stored as `YYYY-MM-DD.json`. For central runs with `target_repo`, normalize the target repository by replacing `/` with `__` and use `<owner>__<repo>__YYYY-MM-DD.json` so multiple target repositories do not overwrite each other.

## Phase 1 — Process Logs

Write a Python script to `/tmp/gh-aw/token-audit/process_audit.py` and run it. The script must:

1. Load `/tmp/gh-aw/token-audit/workflow-logs.json`; preserve its `window_start` and `window_end`, and extract `.runs`.
2. Filter to `status == "completed"` runs only.
3. Group by `workflow_path` (falling back to `workflow_name` only when the path is absent) and compute per-workflow aggregates. Preserve both fields so distinct workflows with the same display name never merge:
   - `run_count`, `total_ai_credits`, `avg_ai_credits`, `total_tokens`, `avg_tokens`, `total_turns`, `avg_turns`, `total_action_minutes`, `error_count`, `warning_count`
4. Compute an overall summary: total runs, total AI credits, total tokens, total action minutes.
5. Sort workflows descending by `total_ai_credits`.
6. Save the result to `/tmp/gh-aw/token-audit/audit_snapshot.json` with this shape:

```json
{
  "date": "YYYY-MM-DD",
  "period_days": 1,
  "window_start": "ISO-8601",
  "window_end": "ISO-8601",
  "overall": {
    "total_runs": N,
    "total_ai_credits": F,
    "total_tokens": N,
    "total_action_minutes": F
  },
  "workflows": [
    {
      "workflow_name": "...",
      "workflow_path": ".github/workflows/example.lock.yml",
      "run_count": N,
      "total_ai_credits": F,
      "avg_ai_credits": F,
      "total_tokens": N,
      "avg_tokens": N,
      "total_turns": N,
      "avg_turns": F,
      "total_action_minutes": F,
      "error_count": N,
      "warning_count": N,
      "latest_run_url": "..."
    }
  ]
}
```

Handle null/missing `aic` and `token_usage` by treating them as 0.

## Phase 2 — Validate and Summarize the Forecast

1. Read `forecast-metadata.txt`. Treat the forecast as complete only when `exit_code=0` and `json_valid=true`. A valid partial JSON document from a nonzero or timeout exit is incomplete evidence, not a complete repository forecast.
2. Parse `forecast.json` without changing it. Never invent a missing workflow, sample, projection, or percentile.
3. For each workflow, use `weekly_monte_carlo` and `monthly_monte_carlo` for P10/P50/P90. If a Monte Carlo object is absent but the corresponding point estimate is positive, use that estimate for all three scenarios and label the row as a point estimate without a confidence interval.
4. Sum the same percentile across workflows to produce repository weekly and monthly scenarios. Label these totals as sums of per-workflow projections, not an independently simulated portfolio confidence interval.
5. Convert forecast AIC to estimated USD by multiplying by `0.01`. Keep enough decimal places that a positive cost never renders as `$0.00`.
6. Flag data quality limitations, including zero sampled runs, zero AIC despite sampled runs, `is_reliable=false`, stale samples, missing workflows, a nonzero command exit, invalid JSON, and intervals whose P90 is more than twice P50.

Use these percentile definitions consistently:

- **P10**: optimistic scenario; 10% of simulated outcomes fall below this value.
- **P50**: median scenario; half of simulated outcomes fall below this value.
- **P90**: conservative budget scenario; 90% of simulated outcomes fall below this value.

If the forecast is unavailable or incomplete, still publish the observed-spend audit. Mark forecasts unavailable or partial, include the command status and specific data gap, and do not substitute a trend extrapolation.

## Phase 3 — Persist Snapshot to Repo-Memory

1. Read the snapshot from `/tmp/gh-aw/token-audit/audit_snapshot.json`.
2. Copy it to the snapshot file for today's UTC date. Use `/tmp/gh-aw/repo-memory/default/YYYY-MM-DD.json` for local runs, or `/tmp/gh-aw/repo-memory/default/<owner>__<repo>__YYYY-MM-DD.json` when `target_repo` is present.
3. This file is what the optimizer workflow reads to identify high-usage workflows.

Also maintain a rolling summary file that contains an array of daily overall totals (date, total_ai_credits, total_tokens, total_runs, total_action_minutes, active_workflows) for the last 90 entries. Use `/tmp/gh-aw/repo-memory/default/rolling-summary.json` for local runs, or `/tmp/gh-aw/repo-memory/default/<owner>__<repo>__rolling-summary.json` when `target_repo` is present. `active_workflows` must be the count of distinct workflows with `run_count >= 1` in that day's snapshot. Load the existing file, append today's entry, trim to 90, and save.

Do not append a synthetic zero-valued entry to `rolling-summary.json` when either of these conditions is true:

- the raw `.runs` array is empty
- the raw `.runs` array is non-empty but there are zero completed runs in the current window

Report those two cases differently in the issue as described below so the empty-window diagnosis stays precise while the historical trend remains unchanged.

## Phase 4 — Generate Charts

Create up to two chart images in `/tmp/gh-aw/token-audit/charts/` using Python, `matplotlib`, and `seaborn` with `whitegrid` styling:

1. **AI credit spend by workflow** (`ai_credits_by_workflow.png`): a horizontal bar chart of the top 15 workflows by total AI credits from `audit_snapshot.json`.
2. **Historical AI credit trend** (`ai_credits_trend.png`): a dual-axis line chart from `rolling-summary.json` with total AI credits on the primary y-axis and active workflows/day on the secondary y-axis.

Chart requirements:

- The preinstalled Python packages live in `/tmp/gh-aw/token-audit/site-packages`. Set `PYTHONPATH=/tmp/gh-aw/token-audit/site-packages${PYTHONPATH:+:$PYTHONPATH}` for every Python command that imports `pandas`, `matplotlib`, or `seaborn`, for example: `PYTHONPATH=/tmp/gh-aw/token-audit/site-packages${PYTHONPATH:+:$PYTHONPATH} python3 /tmp/gh-aw/token-audit/process_audit.py`.
- Use 300 DPI and a white background.
- Add clear axis labels and titles.
- Save only PNG files.
- For `ai_credits_trend.png`, label the secondary y-axis as `Active workflows/day` (or `Distinct workflows executed`) and plot daily distinct executed workflows from `active_workflows`.
- Do not plot the total number of workflows defined in the repository.
- If there are fewer than 2 rolling-summary points, skip the trend chart and explain why in the issue.
- After generating each chart, call `upload_asset` with its file path.
- In the issue template below, replace `UPLOAD_URL_WORKFLOW_PLACEHOLDER` with the URL returned for `ai_credits_by_workflow.png`.
- In the issue template below, replace `UPLOAD_URL_TREND_PLACEHOLDER` with the URL returned for `ai_credits_trend.png`.
- If a chart is skipped, omit that image markdown line entirely instead of leaving a placeholder behind.

## Phase 5 — Publish Audit Issue

Create an issue with these sections:

Provide only the unprefixed subject as the safe-output title. The configured `title-prefix` is added automatically; do not repeat it or add a semantically equivalent category prefix.

### Formatting Requirements

- Use `###` for main sections and `####` for subsections inside the issue body.
- Keep the executive summary and final observations visible without collapsible sections.
- Put verbose tables or supporting detail inside `<details><summary>...</summary>` blocks.
- If you cite specific workflow runs, format them as links like `[§12345](https://github.com/${{ github.repository }}/actions/runs/12345)` and include up to 3 under `**References:**`.

### Report Template

```
- **Period**: last 24 hours (YYYY-MM-DD to YYYY-MM-DD)
- **Total runs**: N
- **Total AI credits**: N.NN AIC
- **Estimated observed cost**: $N.NNNN USD (`total AI credits * $0.01`; billing estimate)
- **Total tokens**: N (formatted with commas)
- **Total Actions minutes**: X.X min
- **Active workflows**: N
- **Next 7 days**: P10 N AIC / $N, P50 N AIC / $N, P90 N AIC / $N
- **Next 30 days**: P10 N AIC / $N, P50 N AIC / $N, P90 N AIC / $N

### 🏆 Top 5 Workflows by AI Credit Spend

| Workflow | Runs | Total AI Credits | Avg AI Credits |
|---|---|---|---|
| ... | ... | ... | ... |

### Cost Forecast

Forecasts are estimates derived from historical samples. Billing dashboards are authoritative.

| Horizon | P10 optimistic | P50 median | P90 conservative |
|---|---:|---:|---:|
| Next 7 days | N AIC / $N USD | N AIC / $N USD | N AIC / $N USD |
| Next 30 days | N AIC / $N USD | N AIC / $N USD | N AIC / $N USD |

State that repository totals are sums of per-workflow projections. Then include a concise table of the top workflows by monthly P50 with sampled runs, weekly P50, monthly P10/P50/P90, and estimated monthly P50 USD. Put the complete per-workflow forecast table in a `<details>` block.

### Forecast Confidence and Data Quality

State whether the forecast command completed, identify unreliable or missing workflow projections, and explain material interval width or sampling limitations. Use `none` when no limitation was detected; never omit this section.

### 📈 Trends

Embed chart images using uploaded asset URLs when available:

![AI Credit Spend by Workflow](UPLOAD_URL_WORKFLOW_PLACEHOLDER)

![Historical AI Credit Trend](UPLOAD_URL_TREND_PLACEHOLDER)

Summarize AI credit, token, and active-workflow changes from `rolling-summary.json` when historical data is available.

<details>
<summary><b>Full Per-Workflow Breakdown</b></summary>

[Complete table of all workflows sorted by total AI credits]

</details>

### 💡 Observations

- Identify any workflow with >30% of total AI credits as a "heavy hitter"
- Note workflows with high error/warning counts relative to runs
- Flag any workflow whose avg AI credits per run exceeds 1.00 AIC

**Data snapshot**: `memory/token-audit/YYYY-MM-DD.json` or `memory/token-audit/<owner>__<repo>__YYYY-MM-DD.json` for central runs
```

## Important Notes

- Use `// 0` (null coalescing) in jq and `.get(field, 0)` in Python for nullable numeric fields (`aic`, `token_usage`).
- Distinguish between these two cases in the issue:
  - the raw `.runs` array is empty
  - the raw `.runs` array is non-empty but none of the runs are `status == "completed"`
- Report those cases differently:
  - if `len(runs) == 0` (or `jq '.runs | length' == 0`), say the collection window returned no runs
  - if `len(runs) > 0` and there are zero completed runs, say the collection window had runs but none completed yet
- Do not claim the raw log file was empty unless you verified `len(runs) == 0` (or `jq '.runs | length' == 0`).
- Keep the issue concise — the optimizer workflow will do the deep analysis.

## Experiment OTEL Span Attributes

If the file `/tmp/gh-aw/experiments/assignments.json` exists, read it and emit one OTEL span
attribute per experiment using the `otlp.cjs` `logSpan` helper:

```javascript
const fs = require('fs');
const assignmentsFile = '/tmp/gh-aw/experiments/assignments.json';
if (fs.existsSync(assignmentsFile)) {
  const assignments = JSON.parse(fs.readFileSync(assignmentsFile, 'utf8'));
  const names = Object.keys(assignments).sort();
  if (names.length > 0) {
    const attrs = { 'gh_aw.experiment.names': names.join(',') };
    for (const name of names) {
      attrs[`gh_aw.experiment.${name}`] = assignments[name];
    }
    const otlp = require('/tmp/gh-aw/actions/otlp.cjs');
    await otlp.logSpan('experiment', attrs);
  }
}
```

This enables filtering workflow runs by experiment variant in Datadog, Honeycomb, or any
OTLP-compatible backend. Attribute keys follow the pattern `gh_aw.experiment.<name>` with the
assigned variant as the value, plus `gh_aw.experiment.names` as a comma-separated index.