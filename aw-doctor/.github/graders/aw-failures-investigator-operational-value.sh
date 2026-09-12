#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

MATURATION_SECONDS=1209600
ASSIGNMENT_WINDOW_SECONDS=86400
MAX_DISCOVERY_PAGES=5

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/aw-failures-investigator-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "AW Doctor / Failures",
  "sourcePath": ".github/workflows/aw-failures-investigator.md",
  "adoption": {
    "commit": "478d356df17de4f9a0e34f879872ea428e7fe274",
    "adoptedAt": "2026-08-26T22:32:04Z"
  },
  "operationalValue": "Retire the dispatched target repository's failing agentic workflows: each failure cluster assigned to a run stops failing and runs green again.",
  "evidence": {
    "opportunity": "Each distinct agentic workflow (a compiled .lock.yml workflow) with at least one failed, timed-out, or startup-failed run in the dispatched target repository during the 24 hours before the investigator run started.",
    "assignment": "Bind targetRepo from workflow_dispatch inputs and freeze the failing workflow ids observed at run creation time; key failure-clusters:<targetRepo>:<runId>. Replays retain this case.",
    "accepted": "An assigned failing workflow completes at least one run after the investigator run started and at or before the evidence cutoff, that window contains at least one successful run, and it contains no failed, timed-out, or startup-failed run.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "List completed target Actions runs once to freeze the assignment, then list completed runs per assigned workflow through the capped evidence cutoff.",
    "maturation": "Fourteen days after the investigator run starts.",
    "zeroRule": "Complete evidence for assigned failing workflows with no recovered workflow scores 0.",
    "missingRule": "Missing target assignment, no failing agentic workflow in the assignment window, or inaccessible Actions run evidence scores null."
  },
  "primaryMetric": {
    "id": "recovered-failure-cluster-share",
    "formula": "recovered assigned failing workflows / assigned failing workflows",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {"valid": true, "eligible": 3, "recovered": 3},
    "targetMissed": {"valid": true, "eligible": 3, "recovered": 0},
    "missing": {"valid": false, "eligible": null, "recovered": null},
    "malformed": {"valid": true, "eligible": 2, "recovered": 3}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true or (.eligible | type) != "number" or (.recovered | type) != "number"
        or .eligible <= 0 or .recovered < 0 or .recovered > .eligible then null
      else ((.recovered / .eligible) * 1000000 | round) / 1000000
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

fetch_completed_runs() {
    endpoint=$1
    created=$2
    output=$3
    : >"$output.ndjson"
    page=1
    while [[ $page -le $MAX_DISCOVERY_PAGES ]]; do
        gh api --method GET "$endpoint" -f exclude_pull_requests=true -f status=completed \
          -f created="$created" -f per_page=100 -f page="$page" >"$tmp_dir/page.json" 2>/dev/null || return 1
        jq -e '(.workflow_runs | type) == "array"' "$tmp_dir/page.json" >/dev/null 2>&1 || return 1
        jq -c '.workflow_runs[]' "$tmp_dir/page.json" >>"$output.ndjson"
        [[ $(jq '.workflow_runs | length' "$tmp_dir/page.json") -lt 100 ]] && break
        page=$((page + 1))
    done
    jq -s '.' "$output.ndjson" >"$output"
}

assign_case() {
    request_file=$1
    target_repo=$(jq -r '.event.inputs.target_repo // empty' "$request_file")
    [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    created_at=$(jq -r .run.createdAt "$request_file")
    window_start=$(add_seconds "$created_at" -$ASSIGNMENT_WINDOW_SECONDS)
    fetch_completed_runs "repos/$target_repo/actions/runs" ">=$window_start" "$tmp_dir/window-runs.json" || return 1
    clusters=$(jq --arg start "$window_start" --arg end "$created_at" '
      def failed: ((.conclusion // "") | ascii_downcase) as $conclusion | $conclusion == "failure" or $conclusion == "timed_out" or $conclusion == "startup_failure";
      [ .[]
        | select(((.path // "") | split("@")[0]) as $path | $path | endswith(".lock.yml"))
        | select(.created_at >= $start and .created_at <= $end)
        | select(failed)
        | {workflowId: .workflow_id, workflowPath: ((.path // "") | split("@")[0]), workflowName: (.name // "")}
      ]
      | group_by(.workflowId)
      | map({workflowId: .[0].workflowId, workflowPath: .[0].workflowPath,
             workflowName: .[0].workflowName, failedRuns: length})
      | sort_by(.workflowPath)
    ' "$tmp_dir/window-runs.json") || return 1
    jq -cn --arg targetRepo "$target_repo" --arg runId "$(jq -r .run.id "$request_file")" \
      --arg assignedAt "$created_at" --arg windowStart "$window_start" --argjson clusters "$clusters" '
      {targetRepo: $targetRepo, runId: $runId, assignedAt: $assignedAt,
       windowStart: $windowStart, clusters: $clusters}'
}

recovered_cluster() {
    target_repo=$1
    workflow_id=$2
    window_start=$3
    cutoff=$4
    runs_file="$tmp_dir/recovery-$workflow_id.json"
    fetch_completed_runs "repos/$target_repo/actions/workflows/$workflow_id/runs" "$window_start..$cutoff" "$runs_file" || return 2
    jq -e --arg start "$window_start" --arg cutoff "$cutoff" '
      def failed: ((.conclusion // "") | ascii_downcase) as $conclusion | $conclusion == "failure" or $conclusion == "timed_out" or $conclusion == "startup_failure";
      [.[] | select(.created_at > $start and .created_at <= $cutoff)] as $runs
      | ($runs | length) > 0
        and any($runs[]; (.conclusion // "") == "success")
        and all($runs[]; failed | not)
    ' "$runs_file" >/dev/null
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
    case_json=$(jq -c '.case' "$request_file")
    if [[ $case_json == null ]]; then
        case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'
    fi
    key="run:$(jq -r .run.id "$request_file")"
    if [[ $(printf '%s\n' "$case_json" | jq -r '.assignmentMissing // false') == true ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" assignment-unavailable
        return
    fi
    target_repo=$(printf '%s\n' "$case_json" | jq -r .targetRepo)
    assigned_at=$(printf '%s\n' "$case_json" | jq -r .assignedAt)
    key="failure-clusters:${target_repo}:$(printf '%s\n' "$case_json" | jq -r .runId)"
    eligible=$(printf '%s\n' "$case_json" | jq '.clusters | length')
    if [[ $eligible -eq 0 ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" no-eligible-failure-clusters
        return
    fi
    recovered=0
    unavailable=false
    : >"$tmp_dir/provenance.ndjson"
    while IFS=$'\t' read -r workflow_id workflow_path; do
        result=0
        recovered_cluster "$target_repo" "$workflow_id" "$assigned_at" "$evidence_cutoff" || result=$?
        [[ $result -eq 0 ]] && recovered=$((recovered + 1))
        [[ $result -eq 2 ]] && unavailable=true
        jq -cn --arg repository "$target_repo" --arg ref "$workflow_path" \
          '{repository: $repository, kind: "agentic-workflow-runs", ref: $ref}' >>"$tmp_dir/provenance.ndjson"
    done < <(printf '%s\n' "$case_json" | jq -r '.clusters[] | [.workflowId, .workflowPath] | @tsv')
    if [[ $unavailable == true ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" run-evidence-unavailable
        return
    fi
    evidence=$(jq -cn --argjson eligible "$eligible" --argjson recovered "$recovered" \
      '{valid: true, eligible: $eligible, recovered: $recovered}')
    value=$(printf '%s\n' "$evidence" | metric)
    provenance=$(jq -s '.' "$tmp_dir/provenance.ndjson")
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" \
      --arg cutoff "$evidence_cutoff" --arg maturesAt "$matures_at" --argjson provenance "$provenance" \
      --argjson eligible "$eligible" --argjson recovered "$recovered" '
      {value: $value, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: $provenance,
       diagnostics: {eligible: $eligible, recovered: $recovered}}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac
