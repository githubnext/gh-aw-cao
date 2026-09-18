---
emoji: ":mag_right:"

description: "Review-only validation of one frozen token-efficiency portfolio candidate"

intent: "Prevent incomplete or duplicate fleet token-efficiency candidates from advancing to optimization review."

name: "AW Optimization / Token Auditor"

max-ai-credits: 50
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
      max_repos:
        type: number
      rollout_percent:
        type: number
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
      candidate_json:
        required: true
        type: string
  permissions:
    contents: read
    actions: read

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
  activation:
    outputs:
      candidate_eligible: ${{ steps.candidate_eligibility.outputs.eligible }}
      candidate_reason: ${{ steps.candidate_eligibility.outputs.reason }}
    pre-steps:
      - name: Validate one frozen token-efficiency candidate
        id: candidate_eligibility
        env:
          CANDIDATE_JSON: ${{ inputs.candidate_json }}
          REQUESTED_MODE: ${{ inputs.safe_output_mode }}
          TARGET_REPOSITORY: ${{ inputs.target_repo }}
        run: |
          set -euo pipefail
          result_dir="$RUNNER_TEMP/token-efficiency-auditor"
          result="$result_dir/result.json"
          mkdir -p "$result_dir"
          eligible=false
          reason=invalid-candidate-json
          candidate='{}'
          verified_run_ids='[]'

          if candidate="$(jq -ce '.' <<<"$CANDIDATE_JSON" 2>/dev/null)"; then
            reason=invalid-candidate
            if [ -n "$REQUESTED_MODE" ] && [ "$REQUESTED_MODE" != review ]; then
              reason=review-mode-required
            elif ! jq -e --arg target "$TARGET_REPOSITORY" '
                . as $candidate
                | $candidate.query == "token-efficiency-optimizer-assignments"
                and $candidate["candidate-status"] == "eligible"
                and $candidate["missing-reason"] == "none"
                and $candidate["source-completeness"] == "complete"
                and $candidate["source-freshness"] == "fresh"
                and $candidate["target-repo"] == $target
                and ($candidate["target-repo"] | test("^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$"))
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
                and ($candidate["opportunity-kind"] | IN(
                  "avoidable-agent-invocation",
                  "deterministic-data-gathering",
                  "unused-tool-schema",
                  "unbounded-context-growth",
                  "poor-cache-utilization",
                  "blocked-tool-retry-loop",
                  "model-or-subagent-mismatch",
                  "avoidable-trigger-frequency",
                  "duplicated-work-across-repositories"
                ))
                and ($candidate["assignment-run"] | test("^[0-9]+$"))
                and ($candidate["evidence-window-start"] | fromdateiso8601? != null)
                and ($candidate["evidence-window-end"] | fromdateiso8601? != null)
                and ($candidate["observation-cutoff"] | fromdateiso8601? != null)
                and (($candidate["evidence-window-start"] | fromdateiso8601) < ($candidate["evidence-window-end"] | fromdateiso8601))
                and (($candidate["evidence-window-end"] | fromdateiso8601) <= ($candidate["observation-cutoff"] | fromdateiso8601))
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
              ' <<<"$candidate" >/dev/null; then
              reason=invalid-or-incomplete-selectors
            else
              run_ids="$(jq -c '[.["run-identities"]]' <<<"$candidate")"
              if ! jq -e --argjson expected "$(jq '.["distinct-runs"]' <<<"$candidate")" '
                  length == $expected
                  and all(.[]; test("^[0-9]+$"))
                ' <<<"$run_ids" >/dev/null; then
                reason=run-identity-count-mismatch
              else
                db="$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite"
                if [ -f activity/cao.mjs ]; then
                  cao_script=activity/cao.mjs
                elif [ -f .github/aw/activity/cao.mjs ]; then
                  cao_script=.github/aw/activity/cao.mjs
                else
                  cao_script=
                fi

                inventory_sources="$RUNNER_TEMP/cao-activity/inventory-sources.json"
                payload_hashes="$RUNNER_TEMP/cao-activity/payload-hashes.json"
                cutoff="$(jq -r '.["observation-cutoff"]' <<<"$candidate")"
                if [ -z "$cao_script" ] || [ ! -s "$db" ]; then
                  reason=activity-cache-unavailable
                elif [ ! -s "$inventory_sources" ] || [ ! -s "$payload_hashes" ]; then
                  reason=activity-cache-metadata-unavailable
                elif ! expected_database_hash="$(jq -er '."gh-aw-logs.sqlite" | select(test("^[0-9a-f]{64}$"))' "$payload_hashes" 2>/dev/null)"; then
                  reason=activity-cache-digest-unavailable
                elif [ "$(shasum -a 256 "$db" | awk '{print $1}')" != "$expected_database_hash" ]; then
                  reason=activity-cache-digest-mismatch
                elif ! jq -e \
                    --arg target "$TARGET_REPOSITORY" \
                    --arg cutoff "$cutoff" '
                      ($target | split("/")) as $coordinate
                      | .repositories.metadata.completeness == "complete"
                      and .repositories.metadata.freshness == "fresh"
                      and .workflows.metadata.completeness == "complete"
                      and .workflows.metadata.freshness == "fresh"
                      and ((.repositories.metadata["as-of"] | fromdateiso8601) >= ($cutoff | fromdateiso8601))
                      and ((.workflows.metadata["as-of"] | fromdateiso8601) >= ($cutoff | fromdateiso8601))
                      and any(.repositories.rows[]?;
                        (.organization | ascii_downcase) == ($coordinate[0] | ascii_downcase)
                        and (.repository | ascii_downcase) == ($coordinate[1] | ascii_downcase)
                      )
                    ' "$inventory_sources" >/dev/null; then
                  reason=activity-cache-stale-incomplete-or-out-of-scope
                else
                  workflow_path="$(jq -r '.["workflow-path"]' <<<"$candidate")"
                  window_start="$(jq -r '.["evidence-window-start"]' <<<"$candidate")"
                  window_end="$(jq -r '.["evidence-window-end"]' <<<"$candidate")"
                  set +e
                  runs="$(node "$cao_script" gh runs \
                    --database "$db" \
                    --repo "$TARGET_REPOSITORY" \
                    --workflow "$workflow_path" \
                    --since "$window_start" \
                    --until "$window_end" \
                    --limit 1000 2>/dev/null)"
                  runs_status=$?
                  sessions="$(node "$cao_script" query \
                    --database "$db" \
                    --collection sessions \
                    --limit 100000 2>/dev/null)"
                  sessions_status=$?
                  grader_events="$(node "$cao_script" query \
                    --database "$db" \
                    --collection events \
                    --where type=workflow_run_grader \
                    --limit 100000 2>/dev/null)"
                  grader_events_status=$?
                  usage_events="$(node "$cao_script" query \
                    --database "$db" \
                    --collection events \
                    --where type=workflow_run_usage \
                    --limit 100000 2>/dev/null)"
                  usage_events_status=$?
                  events="$(node "$cao_script" query \
                    --database "$db" \
                    --collection events \
                    --where type=token_efficiency.intervention \
                    --limit 100000 2>/dev/null)"
                  events_status=$?
                  set -e

                  if [ "$runs_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$runs" >/dev/null; then
                    reason=run-evidence-unavailable
                  elif [ "$sessions_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$sessions" >/dev/null \
                      || [ "$grader_events_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$grader_events" >/dev/null \
                      || [ "$usage_events_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$usage_events" >/dev/null; then
                    reason=grader-evidence-unavailable
                  elif ! runs="$(jq -ce --argjson sessions "$sessions" --argjson graders "$grader_events" --argjson usage "$usage_events" '
                      (reduce $sessions[] as $session ({}; .[$session.id] = $session.runId)) as $sessionRun
                      | (reduce $graders[] as $event ({};
                          ($sessionRun[$event.sessionId] // "") as $runId
                          | if $runId == "" then . else .[$runId] += [$event] end
                        )) as $gradersByRun
                      | (reduce $usage[] as $event ({};
                          ($sessionRun[$event.sessionId] // "") as $runId
                          | if $runId == "" then . else .[$runId] += [$event] end
                        )) as $usageByRun
                      | map(. + {
                          graders: ($gradersByRun[(.id // "")] // []),
                          usage: ($usageByRun[(.id // "")] // [])
                        })
                    ' <<<"$runs")"; then
                    reason=run-evidence-invalid
                  elif ! verified_run_ids="$(jq -ce --argjson expected "$run_ids" '
                      [.[]
                        | (.githubRunId // .runId // .id // empty)
                        | tostring
                        | select(. as $id | $expected | index($id))
                      ]
                      | unique
                    ' <<<"$runs")"; then
                    reason=run-evidence-invalid
                  elif ! jq -e --argjson expected "$run_ids" '
                      . as $verified
                      | length == ($expected | length)
                      and all($expected[]; . as $id | $verified | index($id) != null)
                    ' <<<"$verified_run_ids" >/dev/null; then
                    reason=run-evidence-incomplete
                  elif ! jq -e \
                      --argjson candidate "$candidate" \
                      --argjson expected "$run_ids" '
                        [
                          .[]
                          | select(
                              ((.githubRunId // .runId // .id // empty) | tostring)
                              as $id
                              | $expected
                              | index($id)
                            )
                        ] as $matched
                        | ($matched | length) == 1
                        and ($matched[0] as $run
                          | (($run.startedAt // $run.createdAt // "") == $candidate["evidence-window-start"])
                          and (($run.completedAt // $run.updatedAt // "") == $candidate["evidence-window-end"])
                          and ($run.usage
                               | map(select((.aic | type == "number") or ((.tokenUsage.total_aic? // .tokenUsage.totalAic?) | type == "number")))
                               | unique_by(.id // .sourceId // .sessionId)
                               as $usageRows
                             | ($usageRows | length) == 1
                             and (($usageRows | map(.aic // .tokenUsage.total_aic // .tokenUsage.totalAic) | add) == $candidate["measured-aic"])
                           )
                          and any($run.graders[]?;
                            .grader == "operational-value"
                            and (.status == "pass")
                            and (
                              (.implementation.digest // "")
                              == $candidate["evaluator-digest"]
                            )
                            and (
                              (.observation.case.experimentId // .observation.experimentId // "")
                              == $candidate.experiment
                            )
                            and (
                              (.observation.mature // false) == true
                            )
                          )
                        )
                      ' <<<"$runs" >/dev/null; then
                    reason=authoritative-evidence-mismatch
                  elif [ "$events_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$events" >/dev/null; then
                    reason=intervention-history-unavailable
                  elif jq -e \
                      --arg target "$TARGET_REPOSITORY" \
                      --arg workflow "$workflow_path" \
                      --arg experiment "$(jq -r '.experiment' <<<"$candidate")" '
                      any(.[]?;
                        (.targetRepo | ascii_downcase) == ($target | ascii_downcase)
                        and .targetWorkflowPath == $workflow
                        and .experimentId == $experiment
                        and (
                          (.interventionState | IN("proposed", "accepted", "running", "verified"))
                          or .recommendationDisposition == "applied"
                        )
                      )
                    ' <<<"$events" >/dev/null; then
                    reason=duplicate-active-intervention
                  else
                    eligible=true
                    reason=eligible
                  fi
                fi
              fi
            fi
          fi

          jq -n \
            --argjson schemaVersion 1 \
            --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg result "$eligible" \
            --arg reason "$reason" \
            --argjson candidate "$candidate" \
            --argjson verifiedRunIds "$verified_run_ids" \
            '{
              schemaVersion: $schemaVersion,
              observedAt: $observedAt,
              eligible: ($result == "true"),
              reason: $reason,
              candidateId: ($candidate["candidate-id"] // null),
              query: ($candidate.query // null),
              verifiedRunIds: $verifiedRunIds
            }' > "$result"

          {
            echo "### Token-efficiency candidate audit"
            echo
            echo "- Eligible: \`$eligible\`"
            echo "- Reason: \`$reason\`"
          } >> "$GITHUB_STEP_SUMMARY"
          echo "eligible=$eligible" >> "$GITHUB_OUTPUT"
          echo "reason=$reason" >> "$GITHUB_OUTPUT"
      - name: Upload token-efficiency audit result
        if: ${{ always() }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: token-efficiency-auditor-result
          path: ${{ runner.temp }}/token-efficiency-auditor/result.json
          if-no-files-found: error
          retention-days: 30
  agent:
    if: ${{ false }}

imports:
  - uses: shared/control.md
    with:
      campaign: optimization
      role: worker
      worker: token-efficiency-auditor
  - uses: shared/activity-cache.md

permissions:
  contents: read
  actions: read
  copilot-requests: none

strict: true

network:
  allowed:
    - defaults
    - github

run-name: "Token Auditor · ${{ inputs.target_repo }} · review"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

tracker-id: optimization-token-efficiency-auditor

tools:
  bash:
    - "*"

timeout-minutes: 10

safe-outputs:
  missing-data: false
  missing-tool: false
  report-incomplete: false

source: githubnext/gh-aw-cao/.github/workflows/optimization-token-efficiency-auditor.md@main
---

# AW Optimization / Token Auditor

This workflow has no model task. Its activation job validates exactly one
review-only candidate selected by the
`token-efficiency-optimizer-assignments` Dashboard Language query. It checks the
frozen repository, workflow, opportunity, experiment, evaluator, evidence
window, query completeness and freshness, cost grain, and Run identities
against the authoritative Activity snapshot, and it rejects active or applied
intervention duplicates.

The auditor never discovers repositories, ranks candidates, dispatches another
workflow, publishes an optimizer recommendation, checks out a target
repository, or writes to one. Missing, stale, mixed-grain, immature,
incomparable, unauthorized, or insufficient evidence remains ineligible.

{{#runtime-import? .github/cao/optimization.md}}
