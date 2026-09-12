#!/usr/bin/env bash

set -euo pipefail

export LC_ALL=C

WORKFLOW_NAME="AW Optimization / AI Credit Audit"
MATURATION_SECONDS=86400

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/optimization-ai-credit-auditor-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "AW Optimization / AI Credit Audit",
  "sourcePath": ".github/workflows/optimization-ai-credit-auditor.md",
  "adoption": {
    "commit": "35c7c3cbd319632f85784cce196e57c0f61db9a0",
    "adoptedAt": "2026-08-18T17:54:55Z"
  },
  "operationalValue": "Reproduce the dispatched target repository's completed agentic-workflow usage in a durable daily audit snapshot.",
  "evidence": {
    "opportunity": "One dispatched target repository and the 24-hour UTC period ending when its auditor run started, provided that period contains completed agentic-workflow runs.",
    "assignment": "Bind targetRepo from workflow_dispatch inputs and auditDay from the run creation time; key target-day:<targetRepo>:<auditDay>. Replays retain this case.",
    "accepted": "The durable repo-memory snapshot exactly matches retained completed-run totals and per-workflow aggregates for the assigned target and period.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read retained target workflow logs with gh aw and the assigned snapshot from the latest immutable repo-memory commit at the evidence cutoff.",
    "maturation": "One day after the auditor run starts, matching the frozen daily observation contract.",
    "zeroRule": "A readable snapshot that disagrees with complete retained run evidence scores 0.",
    "missingRule": "Missing assignment, no completed-run opportunity, inaccessible logs, or an absent or malformed snapshot scores null."
  },
  "primaryMetric": {
    "id": "accurate-audit-day",
    "formula": "1 when the assigned durable snapshot exactly reproduces eligible completed-run aggregates; 0 when it disagrees; null when either evidence side is unavailable.",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {"valid": true, "eligible": true, "matched": true},
    "targetMissed": {"valid": true, "eligible": true, "matched": false},
    "missing": {"valid": false, "eligible": true, "matched": null},
    "malformed": {"valid": "yes", "eligible": true, "matched": true}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true or .eligible != true or (.matched | type) != "boolean" then null
      elif .matched then 1
      else 0
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
    opportunity_key=$1
    case_json=$2
    evidence_cutoff=$3
    matures_at=$4
    reason=$5
    jq -cn --arg key "$opportunity_key" --argjson case "$case_json" \
      --arg cutoff "$evidence_cutoff" --arg maturesAt "$matures_at" --arg reason "$reason" '
      {value: null, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: [], diagnostics: {missingReason: $reason}}'
}

read_case() {
    request_file=$1
    jq -c '
      if (.case | type) == "object" and (.case.targetRepo | type) == "string" then .case
      elif (.event.inputs.target_repo | type) == "string" then {
        targetRepo: .event.inputs.target_repo,
        centralRepo: (.event.inputs.central_repo // .run.repository),
        evidenceRepo: .run.repository,
        auditDay: (.run.createdAt[0:10]),
        windowStart: (.run.createdAt | fromdateiso8601 - 86400 | todateiso8601),
        windowEnd: .run.createdAt
      }
      else {assignmentMissing: true}
      end
    ' "$request_file"
}

collect_logs() {
    target_repo=$1
    start_day=$2
    end_day=$3
    output=$4
    mkdir -p "$tmp_dir/logs"
    gh aw logs --repo "$target_repo" --start-date "$start_day" --end-date "$end_day" \
      --count 10000 --max-github-api-rate-limit -2000 --json --output "$tmp_dir/logs" >"$output" 2>"$tmp_dir/logs.err"
    jq -e '(.runs | type) == "array"' "$output" >/dev/null
}

load_snapshot() {
    evidence_repo=$1
    central_repo=$2
    target_repo=$3
    audit_day=$4
    cutoff=$5
    output=$6
    branch="memory/token-audit-${central_repo}-${target_repo}"
    commits_file="$tmp_dir/commits.json"
    gh api --paginate --method GET "repos/$evidence_repo/commits" \
      -f sha="$branch" -f until="$cutoff" -f per_page=100 | jq -s 'add // []' >"$commits_file" 2>/dev/null
    commit_sha=$(jq -r 'sort_by(.commit.committer.date) | last | .sha // empty' "$commits_file")
    [[ -n $commit_sha ]] || return 1
    gh api "repos/$evidence_repo/git/trees/$commit_sha?recursive=1" >"$tmp_dir/tree.json" 2>/dev/null
    snapshot_name=$(printf '%s__%s__%s.json' "${target_repo%%/*}" "${target_repo#*/}" "$audit_day")
    blob_sha=$(jq -r --arg name "$snapshot_name" '
      [.tree[]? | select(.type == "blob" and (.path | split("/") | last) == $name)] | first | .sha // empty
    ' "$tmp_dir/tree.json")
    [[ -n $blob_sha ]] || return 1
    gh api "repos/$evidence_repo/git/blobs/$blob_sha" --jq .content 2>/dev/null \
      | tr -d '\n' | base64 --decode >"$output"
    jq -e '(.overall | type) == "object" and (.workflows | type) == "array"
      and (.window_start | type) == "string" and (.window_end | type) == "string"' "$output" >/dev/null
    printf '%s\n' "$commit_sha"
}

compare_snapshot() {
    runs_file=$1
    snapshot_file=$2
    window_start=$3
    window_end=$4
    jq --arg start "$window_start" --arg end "$window_end" '
      [.runs[] | select(.status == "completed" and .created_at >= $start and .created_at < $end)]
    ' "$runs_file" >"$tmp_dir/completed.json"
    completed_count=$(jq 'length' "$tmp_dir/completed.json")
    [[ $completed_count -gt 0 ]] || return 2
    jq '
      def number: if type == "number" then . else 0 end;
      def workflow: (.workflow_path // .workflow_name // "") | tostring;
      {
        overall: {
          total_runs: length,
          total_ai_credits: (map((.aic // 0) | number) | add // 0),
          total_tokens: (map((.token_usage // 0) | number) | add // 0),
          total_action_minutes: (map((.action_minutes // 0) | number) | add // 0)
        },
        workflows: (group_by(workflow) | map({
          workflow_name: (.[0].workflow_name // (.[0] | workflow)),
          workflow_path: (.[0] | workflow), run_count: length,
          total_ai_credits: (map((.aic // 0) | number) | add // 0),
          avg_ai_credits: ((map((.aic // 0) | number) | add // 0) / length),
          total_tokens: (map((.token_usage // 0) | number) | add // 0),
          avg_tokens: ((map((.token_usage // 0) | number) | add // 0) / length),
          total_turns: (map((.turns // 0) | number) | add // 0),
          avg_turns: ((map((.turns // 0) | number) | add // 0) / length),
          total_action_minutes: (map((.action_minutes // 0) | number) | add // 0),
          error_count: (map((.error_count // 0) | number) | add // 0),
          warning_count: (map((.warning_count // 0) | number) | add // 0)
        }) | sort_by(.workflow_path))
      }
    ' "$tmp_dir/completed.json" >"$tmp_dir/expected.json"
    jq -e --slurpfile expected "$tmp_dir/expected.json" '
      def close($left; $right): (($left | tonumber) - ($right | tonumber) | fabs) <= 0.000001;
      .window_start == $start and .window_end == $end and .period_days == 1
      and .overall.total_runs == $expected[0].overall.total_runs
      and close(.overall.total_ai_credits; $expected[0].overall.total_ai_credits)
      and .overall.total_tokens == $expected[0].overall.total_tokens
      and close(.overall.total_action_minutes; $expected[0].overall.total_action_minutes)
      and ((.workflows | sort_by(.workflow_path)) as $actual
        | $expected[0].workflows as $wanted
        | ($actual | length) == ($wanted | length)
        and all(range(0; $wanted | length); . as $index
          | $actual[$index].workflow_path == $wanted[$index].workflow_path
          and $actual[$index].run_count == $wanted[$index].run_count
          and close($actual[$index].total_ai_credits; $wanted[$index].total_ai_credits)
          and close($actual[$index].avg_ai_credits; $wanted[$index].avg_ai_credits)
          and $actual[$index].total_tokens == $wanted[$index].total_tokens
          and close($actual[$index].avg_tokens; $wanted[$index].avg_tokens)
          and $actual[$index].total_turns == $wanted[$index].total_turns
          and close($actual[$index].avg_turns; $wanted[$index].avg_turns)
          and close($actual[$index].total_action_minutes; $wanted[$index].total_action_minutes)
          and $actual[$index].error_count == $wanted[$index].error_count
          and $actual[$index].warning_count == $wanted[$index].warning_count))
    ' "$snapshot_file" >/dev/null
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
    case_json=$(read_case "$request_file")
    if [[ $(printf '%s\n' "$case_json" | jq -r '.assignmentMissing // false') == true ]]; then
        emit_missing "run:$(jq -r .run.id "$request_file")" "$case_json" "$evidence_cutoff" "$matures_at" assignment-unavailable
        return
    fi
    target_repo=$(printf '%s\n' "$case_json" | jq -r .targetRepo)
    central_repo=$(printf '%s\n' "$case_json" | jq -r .centralRepo)
    evidence_repo=$(printf '%s\n' "$case_json" | jq -r '.evidenceRepo // empty')
    audit_day=$(printf '%s\n' "$case_json" | jq -r .auditDay)
    window_start=$(printf '%s\n' "$case_json" | jq -r .windowStart)
    window_end=$(printf '%s\n' "$case_json" | jq -r .windowEnd)
    opportunity_key="target-day:${target_repo}:${audit_day}"
    if ! [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $evidence_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        emit_missing "$opportunity_key" "$case_json" "$evidence_cutoff" "$matures_at" invalid-target
        return
    fi
    start_day=${window_start%%T*}
    end_day=${window_end%%T*}
    if ! collect_logs "$target_repo" "$start_day" "$end_day" "$tmp_dir/logs.json"; then
        emit_missing "$opportunity_key" "$case_json" "$evidence_cutoff" "$matures_at" logs-unavailable
        return
    fi
    if ! commit_sha=$(load_snapshot "$evidence_repo" "$central_repo" "$target_repo" "$audit_day" "$evidence_cutoff" "$tmp_dir/snapshot.json"); then
        emit_missing "$opportunity_key" "$case_json" "$evidence_cutoff" "$matures_at" snapshot-unavailable
        return
    fi
    matched=false
    comparison_status=0
    compare_snapshot "$tmp_dir/logs.json" "$tmp_dir/snapshot.json" "$window_start" "$window_end" || comparison_status=$?
    if [[ $comparison_status -eq 2 ]]; then
        emit_missing "$opportunity_key" "$case_json" "$evidence_cutoff" "$matures_at" no-eligible-runs
        return
    elif [[ $comparison_status -eq 0 ]]; then
        matched=true
    fi
    evidence=$(jq -cn --argjson matched "$matched" '{valid: true, eligible: true, matched: $matched}')
    value=$(printf '%s\n' "$evidence" | metric)
    jq -cn --argjson value "$value" --arg key "$opportunity_key" --argjson case "$case_json" \
      --arg cutoff "$evidence_cutoff" --arg maturesAt "$matures_at" --arg central "$evidence_repo" \
      --arg target "$target_repo" --arg commit "$commit_sha" '
      {value: $value, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt,
       provenance: [
         {repository: $central, kind: "repo-memory-commit", ref: $commit},
         {repository: $target, kind: "agentic-workflow-logs", ref: ($case.windowStart + ".." + $case.windowEnd)}
       ], diagnostics: {matched: ($value == 1)}}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac