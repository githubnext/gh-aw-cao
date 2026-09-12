#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

MATURATION_SECONDS=1209600
BASELINE_SECONDS=604800

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/self-care-docs-build-time-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "SelfCare / Docs Build Time",
  "sourcePath": ".github/workflows/self-care-docs-build-time-investigator.md",
  "adoption": {
    "commit": "4193a3f3d0759b9897c364f94d2c72e505e1762b",
    "adoptedAt": "2026-09-02T21:04:00Z"
  },
  "operationalValue": "Reduce Documentation Pages workflow execution time by a material amount while preserving its completed-run reliability.",
  "evidence": {
    "opportunity": "The Documentation Pages performance state at the control-plane source revision audited by the worker run.",
    "assignment": "Bind the dispatched target repository, worker run source revision, and the median execution time and failure rate from completed docs.yml runs during the preceding seven days; key docs-build-performance:<targetRepo>:<sourceSha> so repeated audits of one revision share an opportunity.",
    "accepted": "At least five successful docs.yml runs after assignment have a lower median execution time than the frozen baseline, with full attainment at a reduction of at least 60 seconds or 15 percent, whichever is greater, and the completed-run failure rate does not increase.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Use GitHub Actions run timestamps for at most 100 completed docs.yml runs in each bounded baseline and post-assignment window.",
    "maturation": "Fourteen days after the worker run starts.",
    "zeroRule": "Complete post-assignment evidence with no execution-time reduction or a higher failure rate scores 0.",
    "missingRule": "Missing target or source assignment, inaccessible Actions evidence, or fewer than five successful runs in either comparison window scores null."
  },
  "primaryMetric": {
    "id": "material-reliable-build-speed-attainment",
    "formula": "When reliability is preserved, clamp((baseline median seconds - post-assignment median seconds) / max(60 seconds, 15 percent of baseline median seconds), 0, 1); otherwise 0.",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {"valid": true, "baselineMedianSeconds": 600, "observedMedianSeconds": 500, "reliabilityPreserved": true},
    "targetMissed": {"valid": true, "baselineMedianSeconds": 600, "observedMedianSeconds": 600, "reliabilityPreserved": true},
    "missing": {"valid": false, "baselineMedianSeconds": null, "observedMedianSeconds": null, "reliabilityPreserved": null},
    "malformed": {"valid": true, "baselineMedianSeconds": "600", "observedMedianSeconds": 500, "reliabilityPreserved": true}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true
          or (.baselineMedianSeconds | type) != "number"
          or (.observedMedianSeconds | type) != "number"
          or (.reliabilityPreserved | type) != "boolean"
          or .baselineMedianSeconds <= 0
          or .observedMedianSeconds < 0 then null
      elif (.reliabilityPreserved | not) then 0
      else
        ([60, (.baselineMedianSeconds * 0.15)] | max) as $target
        | ((.baselineMedianSeconds - .observedMedianSeconds) / $target) as $attainment
        | if $attainment <= 0 then 0 elif $attainment >= 1 then 1
          else (($attainment * 1000000 | round) / 1000000) end
      end
    '
}

normalize_timestamp() {
    jq -nr --arg value "$1" '
      ($value | sub("\\.[0-9]+Z$"; "Z")) as $timestamp
      | if ($timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
          and (try (($timestamp | fromdateiso8601 | todateiso8601) == $timestamp) catch false)
        then $timestamp else error("invalid timestamp") end
    ' 2>/dev/null
}

add_seconds() {
    jq -nr --arg value "$1" --argjson seconds "$2" '$value | fromdateiso8601 + $seconds | todateiso8601'
}

earlier_timestamp() {
    jq -nr --arg left "$1" --arg right "$2" '
      if ($left | fromdateiso8601) < ($right | fromdateiso8601) then $left else $right end
    '
}

emit_missing() {
    jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg maturesAt "$4" --arg reason "$5" '
      {value: null, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: [], diagnostics: {missingReason: $reason}}'
}

fetch_runs() {
    repository=$1
    window=$2
    output=$3
    gh api --method GET "repos/$repository/actions/workflows/docs.yml/runs" \
      -f status=completed -f created="$window" -f per_page=100 >"$output" 2>/dev/null
    jq -e '(.workflow_runs | type) == "array"' "$output" >/dev/null 2>&1
}

summarize_runs() {
    runs_file=$1
    window_start=$2
    window_end=$3
    jq -c --arg start "$window_start" --arg end "$window_end" '
      def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
      def median:
        sort as $values | ($values | length) as $count
        | if $count == 0 then null
          elif ($count % 2) == 1 then $values[($count / 2 | floor)]
          else (($values[$count / 2 - 1] + $values[$count / 2]) / 2) end;
      [.workflow_runs[]
        | select(.created_at >= $start and .created_at <= $end)
        | select((.run_started_at | type) == "string" and (.updated_at | type) == "string")
        | . + {executionSeconds: ((.updated_at | epoch) - (.run_started_at | epoch))}
        | select(.executionSeconds >= 0)
      ] as $runs
      | [$runs[] | select(.conclusion == "success") | .executionSeconds] as $successful
      | {
          completed: ($runs | length),
          successful: ($successful | length),
          medianSeconds: ($successful | median),
          failureRate: (if ($runs | length) == 0 then null
                        else ([$runs[] | select(.conclusion != "success")] | length) / ($runs | length) end),
          runIds: [$runs[].id | tostring]
        }
    ' "$runs_file"
}

assign_case() {
    request_file=$1
    target_repo=$(jq -r '.event.inputs.target_repo // empty' "$request_file")
    [[ $target_repo == githubnext/gh-aw-cao ]] || return 1
    assigned_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || return 1
    source_sha=$(jq -r '.run.sha // empty' "$request_file")
    [[ $source_sha =~ ^[0-9a-f]{40}$ ]] || return 1
    baseline_start=$(add_seconds "$assigned_at" -$BASELINE_SECONDS)
    fetch_runs "$target_repo" "$baseline_start..$assigned_at" "$tmp_dir/baseline-runs.json" || return 1
    summary=$(summarize_runs "$tmp_dir/baseline-runs.json" "$baseline_start" "$assigned_at") || return 1
    [[ $(printf '%s\n' "$summary" | jq -r .successful) -ge 5 ]] || return 1
    jq -cn --arg targetRepo "$target_repo" --arg sourceSha "$source_sha" \
      --arg assignedAt "$assigned_at" --arg baselineStart "$baseline_start" --argjson baseline "$summary" '
      {targetRepo: $targetRepo, sourceSha: $sourceSha, assignedAt: $assignedAt,
       baselineStart: $baselineStart, baseline: $baseline}'
}

grade_run() {
    request_file="$tmp_dir/request.json"
    cat >"$request_file"
    if ! jq -e '.schemaVersion == 1 and (.run.id | type) == "string" and (.run.createdAt | type) == "string" and (.evidenceAt | type) == "string"' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'
        return
    fi
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    matures_at=$(add_seconds "$created_at" "$MATURATION_SECONDS")
    evidence_cutoff=$(earlier_timestamp "$evidence_at" "$matures_at")
    case_json=$(jq -c .case "$request_file")
    [[ $case_json != null ]] || case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'
    key="run:$(jq -r .run.id "$request_file")"
    if [[ $(printf '%s\n' "$case_json" | jq -r '.assignmentMissing // false') == true ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" assignment-unavailable
        return
    fi
    target_repo=$(printf '%s\n' "$case_json" | jq -r .targetRepo)
    source_sha=$(printf '%s\n' "$case_json" | jq -r .sourceSha)
    assigned_at=$(printf '%s\n' "$case_json" | jq -r .assignedAt)
    key="docs-build-performance:${target_repo}:${source_sha}"
    if [[ $target_repo != githubnext/gh-aw-cao || ! $source_sha =~ ^[0-9a-f]{40}$ ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" invalid-assignment
        return
    fi
    fetch_runs "$target_repo" "$assigned_at..$evidence_cutoff" "$tmp_dir/observed-runs.json" || {
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" actions-evidence-unavailable
        return
    }
    observed=$(summarize_runs "$tmp_dir/observed-runs.json" "$assigned_at" "$evidence_cutoff")
    if [[ $(printf '%s\n' "$observed" | jq -r .successful) -lt 5 ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" insufficient-post-assignment-runs
        return
    fi
    evidence=$(jq -cn --argjson baseline "$(printf '%s\n' "$case_json" | jq .baseline)" \
      --argjson observed "$observed" '
      {valid: true, baselineMedianSeconds: $baseline.medianSeconds,
       observedMedianSeconds: $observed.medianSeconds,
       reliabilityPreserved: ($observed.failureRate <= $baseline.failureRate)}')
    value=$(printf '%s\n' "$evidence" | metric)
    provenance=$(jq -cn --arg repository "$target_repo" \
      --argjson baseline "$(printf '%s\n' "$case_json" | jq '.baseline.runIds')" \
      --argjson observed "$(printf '%s\n' "$observed" | jq '.runIds')" '
      [($baseline + $observed)[] | {repository: $repository, kind: "actions-run", ref: .}]')
    diagnostics=$(jq -cn --argjson baseline "$(printf '%s\n' "$case_json" | jq .baseline)" \
      --argjson observed "$observed" '
      {baselineMedianSeconds: $baseline.medianSeconds, observedMedianSeconds: $observed.medianSeconds,
       baselineFailureRate: $baseline.failureRate, observedFailureRate: $observed.failureRate,
       baselineSuccessfulRuns: $baseline.successful, observedSuccessfulRuns: $observed.successful}')
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" \
      --arg cutoff "$evidence_cutoff" --arg maturesAt "$matures_at" \
      --argjson provenance "$provenance" --argjson diagnostics "$diagnostics" '
      {value: $value, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: $provenance, diagnostics: $diagnostics}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac
