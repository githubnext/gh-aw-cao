---
emoji: ":bar_chart:"

description: "Daily optimization that identifies the highest AI Credit (AIC) agentic workflows, audits its runs, and recommends efficiency improvements including inline sub-agent refactors when warranted"

name: "AW Optimization / AI Credit Savings"

max-ai-credits: 500
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
      worker: ai-credit-optimizer
  - uses: shared/activity-cache.md
  - uses: shared/target-checkout-read-org-token.md

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
    - github

run-name: "AI Credit Optimizer · ${{ inputs.target_repo }} · ${{ inputs.safe_output_mode || 'review' }}"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

graders:
  operational-value:
    run: .github/graders/optimization-ai-credit-optimizer-operational-value.sh

tracker-id: optimization-ai-credit-optimizer

tools:
  github:
    mode: remote
    toolsets: [issues]
  bash:
    - "*"
  repo-memory:
    branch-name: "memory/token-audit-${{ inputs.central_repo }}-${{ inputs.target_repo }}"
    description: "Historical daily workflow AI credit snapshots (shared with optimization-ai-credit-auditor)"
    file-glob: ["*.json", "*.jsonl", "*.csv", "*.md"]
    max-file-size: 102400
    max-patch-size: 51200

safe-outputs:
  create-issue:
    expires: 7d
    title-prefix: "[optimization:ai-credit-optimizer] "
    labels: [optimization, optimization:ai-credit-optimizer]
    close-older-issues: true
    max: 1
    target-repo: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}

timeout-minutes: 30

steps:
  - name: Select activity-cache runs
    env:
      ACTIVITY_ROOT: ${{ runner.temp }}/cao-activity
      TARGET_REPO: ${{ inputs.target_repo }}
    run: |
      node <<'EOF'
      const fs = require("node:fs");
      const path = require("node:path");

      const output = "/tmp/gh-aw/token-audit/cached-run-ids.txt";
      const snapshotPath = path.join(process.env.ACTIVITY_ROOT, "deployed-workflows.json");
      const now = Date.now();
      let runIds = [];
      let usable = false;
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        if (snapshot.schemaVersion !== 1
          || !Number.isFinite(Date.parse(snapshot.generatedAt))
          || now - Date.parse(snapshot.generatedAt) > 2 * 60 * 60 * 1000
          || Date.parse(snapshot.generatedAt) > now + 5 * 60 * 1000
          || snapshot.runHealth?.available !== true
          || snapshot.runHealth?.complete !== true
          || snapshot.runHealth?.windowHours <= 168
          || !Array.isArray(snapshot.workflows)) throw new Error("activity snapshot is incomplete");
        const windowStart = now - 7 * 24 * 60 * 60 * 1000;
        runIds = snapshot.workflows
          .filter((workflow) => workflow?.repository === process.env.TARGET_REPO)
          .flatMap((workflow) => workflow.runHealth?.runRecords || [])
          .filter((run) => run?.status === "completed" && Date.parse(run.createdAt) >= windowStart)
          .map((run) => run.runId)
          .filter(Number.isInteger);
        usable = true;
      } catch {
        runIds = [];
      }
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, runIds.join("\n") + (runIds.length ? "\n" : ""), "utf8");
      if (usable) fs.writeFileSync("/tmp/gh-aw/token-audit/activity-cache-usable", "", "utf8");
      EOF
  - name: Download recent agentic workflow logs
    env:
      GH_TOKEN: ${{ steps.github-mcp-app-token.outputs.token || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
      GH_REPO: ${{ inputs.target_repo }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/token-audit

      echo "📥 Downloading agentic workflow logs (last 7 days)..."

      RAW_LOGS=/tmp/gh-aw/token-audit/all-runs.raw.json
      LOG_EXIT=0
      if [[ -f /tmp/gh-aw/token-audit/activity-cache-usable ]]; then
        gh aw logs \
          --repo "$TARGET_REPO" \
          --stdin \
          --output /tmp/gh-aw/token-audit/logs \
          --json \
          --timeout 15 \
          --max-github-api-rate-limit -2000 \
          --max-storage 1024 \
          < /tmp/gh-aw/token-audit/cached-run-ids.txt > "$RAW_LOGS" || LOG_EXIT=$?
      else
        gh aw logs \
          --repo "$TARGET_REPO" \
          --output /tmp/gh-aw/token-audit/logs \
          --start-date -7d \
          --json \
          -c 50 \
          --timeout 15 \
          --max-github-api-rate-limit -2000 \
          --max-storage 1024 \
          > "$RAW_LOGS" || LOG_EXIT=$?
      fi

      if jq -e . "$RAW_LOGS" >/dev/null 2>&1; then
        jq '
          ((.runs // []) | unique_by(.run_id)) as $runs |
          {
            summary: {
              total_runs: ($runs | length),
              total_tokens: ($runs | map(.token_usage // 0) | add // 0),
              total_aic: ($runs | map(.aic // 0) | add // 0)
            },
            runs: $runs
          }
        ' "$RAW_LOGS" > /tmp/gh-aw/token-audit/all-runs.json
        TOTAL=$(jq '.runs | length' /tmp/gh-aw/token-audit/all-runs.json)
        echo "✅ Downloaded $TOTAL agentic workflow runs (last 7 days, exit code $LOG_EXIT)"
      else
        echo "⚠️ Agentic workflow logs were unavailable or invalid (exit code $LOG_EXIT)"
        echo '{"runs":[],"summary":{}}' > /tmp/gh-aw/token-audit/all-runs.json
      fi
      rm -f "$RAW_LOGS"

      BEFORE_COUNT=$(jq '(.runs // []) | length' /tmp/gh-aw/token-audit/all-runs.json)
      if [[ "$TARGET_REPO" != "githubnext/gh-aw-cao" ]]; then
        jq '
            (.runs // [])
            | map(select(
                (.workflow_path // "") != ".github/workflows/optimization-ai-credit-optimizer.lock.yml"
                and (.workflow_path // "") != ".github/workflows/optimization-ai-credit-auditor.lock.yml"
              )) as $runs
            | {
                summary: {
                  total_runs: ($runs | length),
                  total_tokens: ($runs | map(.token_usage // 0) | add // 0),
                  total_aic: ($runs | map(.aic // 0) | add // 0)
                },
                runs: $runs
              }
        ' /tmp/gh-aw/token-audit/all-runs.json > /tmp/gh-aw/token-audit/all-runs.filtered.json
        mv /tmp/gh-aw/token-audit/all-runs.filtered.json /tmp/gh-aw/token-audit/all-runs.json
        AFTER_COUNT=$(jq '(.runs // []) | length' /tmp/gh-aw/token-audit/all-runs.json)
        echo "🚫 Excluded AI credit monitoring family from candidate pool: $((BEFORE_COUNT - AFTER_COUNT)) run(s) removed"
      else
        echo "ℹ️ Running in source repo — AI credit monitoring family remains in candidate pool"
        AFTER_COUNT=$BEFORE_COUNT
      fi

  - name: Aggregate top workflows by AI credit usage
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/token-audit

      jq '{
        generated_at: (now | todateiso8601),
        window_days: 7,
        top_workflows: (
          [.runs[]
            | select(.status == "completed")
              | select((.aic // 0) > 0)
            | {
                workflow_name: .workflow_name,
              workflow_path: (.workflow_path // .workflow_name),
                ai_credits: (.aic // 0),
                tokens: (.token_usage // 0),
                turns: (.turns // 0),
                action_minutes: (.action_minutes // 0)
              }
          ]
            | group_by(.workflow_path)
          | map({
              workflow_name: .[0].workflow_name,
              workflow_path: .[0].workflow_path,
              run_count: length,
              total_ai_credits: (map(.ai_credits) | add),
              avg_ai_credits: ((map(.ai_credits) | add) / length),
              total_tokens: (map(.tokens) | add),
              avg_tokens: ((map(.tokens) | add) / length),
              total_turns: (map(.turns) | add),
              total_action_minutes: (map(.action_minutes) | add)
            })
          | sort_by(.total_ai_credits)
          | reverse
          | .[:10]
        )
      }' /tmp/gh-aw/token-audit/all-runs.json > /tmp/gh-aw/token-audit/top-workflows.json

      echo "✅ Generated top workflow summary at /tmp/gh-aw/token-audit/top-workflows.json"
      jq '.top_workflows' /tmp/gh-aw/token-audit/top-workflows.json

  - name: Load optimization history
    run: |
      set -euo pipefail

      TARGET_PREFIX=$(printf '%s' "$TARGET_REPO" | sed 's|/|__|')
      OPT_LOG="/tmp/gh-aw/repo-memory/default/${TARGET_PREFIX}__optimization-log.json"
      if [ -f "$OPT_LOG" ]; then
        echo "✅ Previous optimizations:"
        jq -r '.[] | "\(.date): \(.workflow_name)"' "$OPT_LOG"
      else
        echo "ℹ️ No previous optimization history found."
      fi

source: githubnext/gh-aw-cao/.github/workflows/optimization-ai-credit-optimizer.md@main
---

{{#runtime-import? .github/cao/optimization.md}}

You are the Agentic Workflow Optimizer. Pick one high AI credit workflow, audit recent runs, and create a conservative optimization issue with measurable improvements. Your recommendations may include prompt, tool, reliability, setup-prefix, and inline sub-agent improvements when the evidence supports them.

## Objectives

1. Select one workflow using repo-memory and pre-aggregated data.
2. Analyze AI credit, tokens, turns, errors, tool usage patterns, and prompt structure across multiple runs.
3. Propose safe, high-impact optimizations with evidence, including inline sub-agent refactors only when they are a clear fit.
4. Publish one issue and update optimization history.

## Data Access Guidelines

Always filter `gh api` responses with `--jq`. Prefer a single bash tool call containing a combined command block (using pipes/`&&` as needed) over multiple separate bash tool calls.

## Data Inputs

- `/tmp/gh-aw/token-audit/all-runs.json`: full 7-day run data (`gh aw logs --json`).
- `/tmp/gh-aw/token-audit/top-workflows.json`: pre-aggregated top 10 workflows by total AIC.
- `/tmp/gh-aw/repo-memory/default/YYYY-MM-DD.json`: daily audit snapshots for local runs.
- `/tmp/gh-aw/repo-memory/default/<owner>__<repo>__YYYY-MM-DD.json`: daily audit snapshots for central runs with `target_repo`.
- `/tmp/gh-aw/repo-memory/default/optimization-log.json`: prior optimizations for local runs (if present).
- `/tmp/gh-aw/repo-memory/default/<owner>__<repo>__optimization-log.json`: prior optimizations for central runs with `target_repo` (if present).

Treat missing numeric fields (`aic`, `token_usage`, `turns`, `action_minutes`) as `0`.

## Phase 1 — Select Target

- Start from `top-workflows.json`.
- Exclude workflows optimized in the last 14 days (use `optimization-log.json`).
- Exclude the AI credit monitoring family — the `optimization-ai-credit-optimizer` and `optimization-ai-credit-auditor` workflows — **unless this workflow is running in `githubnext/gh-aw-cao`** (the source repository that ships them). In downstream repositories these workflows are not valid optimization targets; any optimization suggestions for them belong in `githubnext/gh-aw-cao`. In downstream repos they are pre-filtered from `all-runs.json` and `top-workflows.json`, but never select them even if a stale snapshot still lists them.
- Choose the highest AI-credit-spend workflow that remains.
- If no snapshot/history exists, derive candidates directly from `all-runs.json`.
- When `target_repo` is present, read and write only the target-specific snapshot and optimization log files using the `<owner>__<repo>__` prefix. Do not mix history between target repositories.

Then collect run-level data for the selected workflow:

- run count
- total and average AIC
- total and average tokens
- total and average turns
- conclusions/error patterns

## Phase 2 — Analyze Runtime Behavior

Dispatch the `aggregate-run-stats` agent in parallel with `extract-workflow-source` (Phase 3). Use its output to populate the spend profile table and drive the analysis below.

Use this compact analysis matrix:

| Area | Required checks | Output |
|---|---|---|
| Tool usage | Compare configured tools from workflow source vs observed usage across multiple runs | Keep / Consider removing / Remove |
| AI credit spend | Evaluate AIC, token totals, cache efficiency, turns | Top spend drivers |
| Reliability | Repeated errors, warnings, retries, missing tools | AI credit waste from failures |
| Prompt efficiency | Redundant instructions, overlong sections, avoidable iteration | Prompt reduction opportunities |
| Structural optimization | Repeated setup/tool-call prefixes and sections suited for inline sub-agents | Extract setup / Add sub-agent / Keep in main agent |

### Tool-Usage Efficiency Patterns

Check for: Batch independent reads · Chain bash commands · Prefer typed tools · Consolidate GitHub API sequences · Don't retry without diagnosing.

Rules:

- Audit at least 5 runs when available before removal recommendations.
- Never recommend removing a tool used in any successful run unless there is strong contrary evidence.
- Only recommend inline sub-agents when the target workflow has no existing `## agent:` blocks and at least 3 major prompt sections.
- Prioritize highest expected savings first.

## Phase 3 — Read Workflow Source

Use the `extract-workflow-source` agent (dispatch in parallel with `aggregate-run-stats`) to fetch and parse the target workflow `.md` file.

Validate from the source:

- configured tools and feature flags
- imported shared components
- prompt structure and verbosity
- whether the prompt already uses inline sub-agents
- network/sandbox constraints relevant to recommendations

## Phase 4 — Structural Optimization Checks

### Common Setup Prefix Analysis

Split the prompt body into major sections (`##` and `###`). For each section, inspect the first 10 lines and note explicit setup instructions, tool invocations, file reads, or repeated shell snippets.

A setup extraction recommendation is warranted only when:

- at least 2 sections repeat the same opening tool calls or setup instructions, and
- moving them into a shared `## Setup` section would not change later section behavior.

If you recommend this optimization, capture:

- the shared setup text (quote the exact calls)
- the affected sections
- the proposed `## Setup` section text
- a conservative savings estimate (5–15% per duplicated call removed)

### Inline Sub-Agent Opportunity Analysis

If the workflow has no inline sub-agents yet, score major sections using these dimensions:

| Dimension | Meaning | Max |
|---|---|---|
| Independence | Can the section run without outputs from other sections? | 3 |
| Small-model adequacy | Is the work mostly extractive, classificatory, or formatting? | 3 |
| Parallelism | Could it run concurrently with other sections? | 2 |
| Size | Is the task substantial enough to justify an agent call? | 2 |

Score 6+ → strong candidate. Use a smaller model for extractive/formatting tasks; keep synthesis and final issue writing in the main agent.

Recommend at most 3 inline sub-agents, and only when the combined opportunity is clearly material. Keep any proposed agent prompt concise and imperative.

## Phase 5 — Publish Optimization Issue

Create one issue with:

Provide only the unprefixed subject as the safe-output title. The configured `title-prefix` is added automatically; do not repeat it or add a semantically equivalent category prefix.

- **Target workflow + reason selected**
- **Analysis period + runs analyzed**
- **Spend profile table** (total AIC, avg AIC/run, total tokens, avg turns/run, cache efficiency)
- **Ranked recommendations** with:
  - title
  - estimated AI credit savings per run
  - concrete action
  - evidence from observed runs
- **Optional structural optimizations** for shared setup prefixes and inline sub-agents when supported by the analysis
- **Caveats** (sampling limits, edge cases)

### Report Formatting Requirements

- Use `###` for main sections and `####` for subsections.
- Keep the selected workflow, token profile summary, and ranked recommendations visible without collapsible sections.
- Use `<details><summary>...</summary>` blocks for long supporting tables, raw run evidence, and lower-priority context.
- If you cite specific workflow runs, format them as links like `[§12345](https://github.com/${{ github.repository }}/actions/runs/12345)` and include up to 3 under `**References:**`.
- If you recommend inline sub-agents, include each candidate's task, why a smaller model fits, score breakdown, and the exact invocation change you want made in the main prompt.

## Phase 6 — Update Optimization Log

Append one entry to the target-specific optimization log at `/tmp/gh-aw/repo-memory/default/<owner>__<repo>__optimization-log.json`. Derive `<owner>__<repo>` from `${{ inputs.target_repo }}`; do not write the unprefixed log for a dispatched target.

`{"date":"YYYY-MM-DD","target_repo":"${{ inputs.target_repo }}","workflow_name":"...","workflow_path":".github/workflows/....lock.yml","optimizer_run_id":"${{ github.run_id }}","total_ai_credits_analyzed":F,"total_tokens_analyzed":N,"runs_audited":N,"recommendations_count":N,"subagent_candidates":N,"estimated_aic_savings_per_run":F}`

Use the selected candidate's exact `workflow_path`; do not substitute its display name. Use `subagent_candidates` for the count of inline sub-agent candidates you actually recommend in the issue body.

Load the existing array if present, append, keep only the last 30 entries, and save.

## Guardrails

- Use pre-downloaded data; do not re-download logs.
- Do not modify audit snapshots; only update `optimization-log.json`.

## agent: `extract-workflow-source`
---
model: small
description: Fetch a target .github/workflows/<name>.md file, base64-decode it, and return structured metadata
---
You are a workflow source extraction assistant. You receive the repository name and workflow file path.

Fetch the file via bash without printing the full content to stdout:
    tmp="$(mktemp)"
    gh api "repos/<repo>/contents/<path>" --jq '.content' | base64 -d >"$tmp"
Return only a JSON object with this structure:
{
  "frontmatter": {},
  "sections": [{"heading": "", "char_count": 0}],
  "inline_sub_agents": [{"name": "", "model": "", "description": ""}],
  "tools": {}
}
Do not include the full file content or any additional commentary.

## agent: `aggregate-run-stats`
---
model: small
description: Filter run data for a target workflow and compute AI credit and timing statistics
---
You are a run statistics aggregation assistant. You receive the target workflow name.

Use `jq` to aggregate from `/tmp/gh-aw/token-audit/all-runs.json` (filtering within `.runs`) without printing raw run JSON. Compute total/avg/min/max AIC, action-minutes total/P50/P90, and conclusion counts for the target workflow, and output exactly one markdown table with columns: Metric | Value.