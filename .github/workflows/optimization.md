---
name: "AW Optimization"

run-name: "${{ github.event_name == 'schedule' && 'AW Optimization · scheduled' || format('AW Optimization · {0} · {1}', inputs.target_repo || 'discovery', inputs.safe_output_mode || 'review') }}"

max-ai-credits: 250
max-daily-ai-credits: -1
timeout-minutes: 15

concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

on:
  schedule: "hourly"
  workflow_dispatch:
    inputs:
      target_repo:
        type: string
      safe_output_repo:
        type: string
      max_repos:
        default: 1
        type: number
      rollout_percent:
        default: 100
        type: number
      safe_output_mode:
        default: "review"
        type: choice
        options:
          - review
          - live
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      token_efficiency_candidates_json:
        description: Frozen eligible rows from the token-efficiency-optimizer-assignments Dashboard Language query
        type: string
  permissions:
    contents: read
    actions: read

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
  activation:
    pre-steps:
      - name: Download CAO control precompute artifact
        uses: actions/download-artifact@v8.0.1
        with:
          name: cao-control-precompute
          path: /tmp/gh-aw/agent
      - name: Validate frozen token-efficiency portfolio rows
        id: token_candidates
        env:
          TOKEN_CANDIDATES_JSON: ${{ inputs.token_efficiency_candidates_json }}
        run: |
          set -euo pipefail
          candidates_dir="$RUNNER_TEMP/token-efficiency-portfolio"
          candidates_file="$candidates_dir/candidates.json"
          precompute=/tmp/gh-aw/agent/control-precompute.json
          mkdir -p "$candidates_dir"
          eligible=false
          reason=not-supplied
          count=0
          echo '[]' > "$candidates_file"

          if [ -n "$TOKEN_CANDIDATES_JSON" ]; then
            reason=invalid-candidate-json
            if candidates="$(jq -ce '.' <<<"$TOKEN_CANDIDATES_JSON" 2>/dev/null)"; then
              count="$(jq 'length' <<<"$candidates")"
              effective_max="$(jq -r '.effective_max_repos // 0' "$precompute")"
              allowed_repositories="$(jq -c '
                [.candidate_repositories[]? | (.full_name // .repository // empty) | ascii_downcase]
              ' "$precompute")"
              if jq -e \
                  --argjson effectiveMax "$effective_max" \
                  --argjson allowed "$allowed_repositories" '
                    type == "array"
                    and length > 0
                    and length <= 10
                    and length <= $effectiveMax
                    and (map(.["target-repo"] | ascii_downcase) | unique | length) == length
                    and (map(.["candidate-id"]) | unique | length) == length
                    and all(.[];
                      . as $candidate
                      | $candidate.query == "token-efficiency-optimizer-assignments"
                      and $candidate["candidate-status"] == "eligible"
                      and $candidate["missing-reason"] == "none"
                      and $candidate["source-completeness"] == "complete"
                      and $candidate["source-freshness"] == "fresh"
                      and (($candidate["target-repo"] | ascii_downcase) as $target | ($allowed | index($target)) != null)
                      and ($candidate["workflow-path"] | test("^\\.github/workflows/[^/]+\\.(md|lock\\.yml)$"))
                      and ($candidate["candidate-id"] | startswith("token-candidate:"))
                      and $candidate["candidate-id"] == (
                        "token-candidate:"
                        + $candidate["target-repo"] + ":"
                        + $candidate["workflow-path"] + ":"
                        + $candidate["assignment-run"] + ":"
                        + $candidate.experiment + ":"
                        + $candidate.variant + ":"
                        + $candidate["smell-id"]
                      )
                      and ($candidate["assignment-run"] | test("^[0-9]+$"))
                      and ($candidate["evidence-window-start"] | fromdateiso8601? != null)
                      and ($candidate["evidence-window-end"] | fromdateiso8601? != null)
                      and ($candidate["observation-cutoff"] | fromdateiso8601? != null)
                      and $candidate["cost-grain"] == "run-aggregate"
                      and ($candidate["run-identities"] | test("^[0-9]+$"))
                      and $candidate["run-identities"] == $candidate["assignment-run"]
                      and ($candidate["distinct-runs"] | type == "number")
                      and $candidate["distinct-runs"] == 1
                      and ($candidate["invocation-count"] | type == "number")
                      and $candidate["invocation-count"] == 1
                      and ($candidate["priced-invocation-count"] | type == "number")
                      and $candidate["priced-invocation-count"] == $candidate["invocation-count"]
                      and ($candidate["measured-aic"] | type == "number")
                      and $candidate["measured-aic"] > 0
                      and ($candidate["aic-per-accepted-outcome"] | type == "number")
                      and $candidate["aic-per-accepted-outcome"] > 0
                      and ($candidate.experiment | test("^[A-Za-z0-9][A-Za-z0-9._:-]*$"))
                      and ($candidate.variant | test("^[A-Za-z0-9][A-Za-z0-9._:-]*$"))
                      and $candidate["assignment-included"] == true
                      and ($candidate["evaluator-digest"] | test("^[0-9a-f]{64}$"))
                      and $candidate["maturity-state"] == "matured"
                      and ($candidate["accepted-outcome-count"] | type == "number")
                      and $candidate["accepted-outcome-count"] >= 1
                      and $candidate["quality-evidence-state"] == "complete"
                      and $candidate["reliability-evidence-state"] == "complete"
                      and $candidate["active-intervention-count"] == 0
                      and $candidate["active-intervention-state"] == "none"
                      and $candidate["evidence-state"] == "complete"
                      and ($candidate["priority-aic"] | type == "number")
                      and $candidate["priority-aic"] == $candidate["measured-aic"]
                      and ($candidate | has("total-tokens") | not)
                    )
                    and . == sort_by(-.["priority-aic"], .["target-repo"], .["workflow-path"], .["assignment-run"], .["candidate-id"])
                  ' <<<"$candidates" >/dev/null; then
                eligible=true
                reason=eligible
                jq '.' <<<"$candidates" > "$candidates_file"
              else
                reason=invalid-incomplete-or-unauthorized-candidate
              fi
            fi
          fi

          echo "eligible=$eligible" >> "$GITHUB_OUTPUT"
          echo "reason=$reason" >> "$GITHUB_OUTPUT"
          echo "count=$count" >> "$GITHUB_OUTPUT"
      - name: Upload frozen token-efficiency portfolio rows
        if: ${{ always() }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: token-efficiency-portfolio-candidates
          path: ${{ runner.temp }}/token-efficiency-portfolio/candidates.json
          if-no-files-found: error
          retention-days: 1
  agent:
    pre-steps:
      - name: Download frozen token-efficiency portfolio rows
        uses: actions/download-artifact@v8.0.1
        with:
          name: token-efficiency-portfolio-candidates
          path: /tmp/gh-aw/token-efficiency-portfolio

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || '' }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      campaign: optimization
      role: orchestrator
      dispatch_max: 20
      orchestrator_credits: 250
      worker_credits_per_target: 1950
  - uses: shared/activity-cache.md

permissions:
  contents: read
  actions: read
  copilot-requests: write

strict: true

tools:
  github:
    mode: remote
    toolsets: [repos, actions]

network:
  allowed:
    - defaults
    - github

safe-outputs:
  dispatch-workflow:
    workflows: [optimization-ai-credit-auditor, optimization-ai-credit-optimizer, optimization-agents-md-curator, optimization-skills-curator, optimization-token-efficiency-auditor, optimization-token-optimizer, optimization-token-efficiency-verifier]
    max: 20
  threat-detection: false

source: githubnext/gh-aw-cao@2de9130ff1709fccdacbe5261fd5da71995e6721
---

# AW Optimization

## Discovery

For the AW Optimization campaign, prefer repositories where Agentic Workflows can be made cheaper or their ambient context can be made smaller and more accurate. Strong signals include Agentic Workflow definitions under `.github/workflows/`, recent AI credit usage, high-turn or high-token runs, repeated warnings or failures, existing audit history, or a root `AGENTS.md` that has drifted while the repository kept changing.

Before dispatching an ambient-context worker, confirm the default branch contains a root `AGENTS.md`; never dispatch those workers to propose creating one. Prefer drift evidenced by stale paths or commands, oversized or duplicated instructions, contradictions among instruction files, repeated reviewer corrections, or skills with weak descriptions or unclear use.

Deprioritize repositories with neither Agentic Workflow definitions nor a root `AGENTS.md`, unreadable workflow logs, no recent agentic activity or repository changes, open pull requests already modifying ambient context, or only the optimization monitoring workflows installed without other workflows to improve.

## Workers

- `optimization-ai-credit-auditor`: reads workflow definitions and recent run logs; records AI credit and token snapshots with trend charts, then uses `gh aw forecast` to report weekly and monthly AIC and estimated USD scenarios.
- `optimization-ai-credit-optimizer`: reads 7-day run aggregates and repo-memory history; publishes recommendations for the highest-impact workflow not recently optimized.
- `optimization-agents-md-curator`: reads a repository's root `AGENTS.md`, git history, and merged pull request and review-comment history; files one issue containing an agentic prompt for a small, evidence-backed update.
- `optimization-skills-curator`: reads agent skills, agent definitions, and their in-repository references; files one issue containing an agentic prompt that improves the layering between `AGENTS.md` and skills.
- `optimization-token-efficiency-auditor`: deterministically revalidates one frozen, query-ranked token-efficiency candidate against policy and authoritative Activity evidence; it emits only a bounded audit artifact and never recommends or dispatches work.
- `optimization-token-optimizer`: consumes one frozen evidence-complete repository/workflow/experiment assignment, deterministically rejects incomplete or duplicate work, and publishes at most one review-only recommendation with canonical opportunity and intervention lineage.
- `optimization-token-efficiency-verifier`: consumes exactly one authoritative applied intervention as a bounded, review-only verification checkpoint. The Optimization dashboard computes progress and regression from canonical evidence with Dashboard Language queries; the worker never writes a target repository or transforms dashboard data.

Dispatch stays repository-scoped: one dispatch per selected repository and eligible worker. Token-efficiency portfolio selection is accepted only from `/tmp/gh-aw/token-efficiency-portfolio/candidates.json`, which contains at most ten bounded, policy-checked rows ordered by the `token-efficiency-optimizer-assignments` query in `optimization/dashboard.json`; the ten-row ceiling reserves the 20-dispatch campaign cap for one auditor and one optimizer dispatch per candidate. Each submitted row must add `source-completeness` and `source-freshness` copied from the production query result metadata; both must be `complete` and `fresh`. Never reconstruct, supplement, reorder, or infer those rows in the workflow. If the file is absent or contains an empty array, dispatch neither token-efficiency auditor nor token optimizer. For each retained row, dispatch `optimization-token-efficiency-auditor` with the complete row serialized unchanged as `candidate_json`, then dispatch `optimization-token-optimizer` from the same frozen selectors. Set the common optimizer inputs `target_repo`, `safe_output_repo`, `safe_output_mode`, `correlation_id`, `central_repo`, and `control_plane_run_url`; put the frozen assignment in `assignment_json` as one JSON object with `targetRepo`, `workflowPath`, `evidenceWindowStart`, `evidenceWindowEnd`, `assignmentRunId`, `experimentId`, `variant`, `evaluatorDigest`, `opportunityKind`, `evidenceComplete: true`, `evidenceProvenance`, `attributableRunIds`, `costGrain`, and `measuredAic`. Convert `run-identities` only into the optimizer's JSON Run-ID array and provenance objects; every provenance row must name the `token-efficiency-optimizer-assignments` query, its Run ID, and the candidate's declared run-aggregate cost grain. Omit `evidenceConfidence` and `proposedSavingsAic` from `assignment_json` when the query does not authoritatively supply them. Measured AIC is only the disclosed priority signal, never proof of avoidable waste or an auditor recommendation. Do not dispatch either worker for excluded assignments or incomplete, unavailable, immature, mixed-grain, duplicate, active-intervention, out-of-policy, or cap-exceeding rows. The auditor never gates through a downstream dispatch; the orchestrator remains the only dispatcher and records both dispatches against the same frozen row.

Dispatch `optimization-token-optimizer` only with all of its frozen assignment fields in `assignment_json`, including the exact `evaluatorDigest` from the target workflow's authoritative schema-version-4 operational-value result; do not ask it to discover an opportunity and do not substitute the optimizer's evaluator. Dispatch `optimization-token-efficiency-verifier` only for one latest authoritative lifecycle observation whose disposition is `applied` and whose implementation is complete. Supply only `target_repo`, `opportunity_id`, `intervention_id`, and an `evidence_cutoff` from the complete Activity generation. Do not supply Run lists, measurements, outcome lists, AIC, or evaluator contracts. The dashboard query owns comparison, aggregation, and verification-state derivation from canonical lifecycle, experiment-assignment, grader, usage, and Run sources. Do not dispatch proposed, unapplied, rejected, failed-start, superseded, outdated, duplicate, unmatured, stale, ambiguous, or mixed-grain evidence. The ambient-context workers apply their existing 10 percent gain gate before publishing and return a `noop` when the estimated reduction in always-loaded context is smaller.

## Completion

Finish with the standard `## Orchestrator Report` inherited from `shared/control.md`. Preserve every standard heading and field — `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome` — and use `0`, `none`, or `not applicable` for empty fields. Use the exact precomputed repository totals and distinguish eligible, selected, skipped, and deferred repositories.

If no worker is dispatched and no incomplete condition applies, call `noop` exactly once with the complete orchestrator report as its message.

Add campaign-specific details after the standard fields:

- The optimization or ambient-context signal that justified each selected repository.
- Repositories skipped for ambient-context work because they have no root `AGENTS.md`.

{{#runtime-import? .github/cao/optimization.md}}
