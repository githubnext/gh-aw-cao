#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

WORKFLOW_NAME="AW Optimization / AI Credit Savings"
MATURATION_SECONDS=604800

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/optimization-ai-credit-optimizer-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4, "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao", "workflowName": "AW Optimization / AI Credit Savings",
  "sourcePath": ".github/workflows/optimization-ai-credit-optimizer.md",
  "adoption": {"commit": "35c7c3cbd319632f85784cce196e57c0f61db9a0", "adoptedAt": "2026-08-18T17:54:55Z"},
  "operationalValue": "Lower the dispatched target's highest-AIC workflow cost without increasing its failure rate.",
  "evidence": {
    "opportunity": "The high-AIC target workflow selected by the optimizer run after its frozen eligibility and recent-optimization exclusions.",
    "assignment": "Bind targetRepo from workflow_dispatch inputs and freeze the workflow_path recorded by this optimizer run; key target-workflow:<targetRepo>:<workflowPath>:<runId>.",
    "accepted": "During the seven days after assignment, the workflow's median successful-run AIC is lower than its pre-run median and its completed-run failure rate is no higher.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read retained gh aw run logs for the assigned target from seven days before the run through the capped evidence cutoff.",
    "maturation": "Seven days after the optimizer run starts.",
    "zeroRule": "Complete comparable evidence with no AIC reduction or a higher failure rate scores 0.",
    "missingRule": "Missing assignment, no eligible workflow, inaccessible logs, or no successful and completed runs in either period scores null."
  },
  "primaryMetric": {"id": "efficient-reliable-outcome", "formula": "1 when median successful-run AIC decreases and failure rate does not increase; otherwise 0", "direction": "higher_is_better"},
  "baseline": {"mode": "attainment-only", "value": null, "evidenceCutoff": null, "provenance": []},
  "validationExamples": {
    "targetAttained": {"valid":true,"lowerAic":true,"reliabilityPreserved":true},
    "targetMissed": {"valid":true,"lowerAic":false,"reliabilityPreserved":true},
    "missing": {"valid":false,"lowerAic":null,"reliabilityPreserved":null},
    "malformed": {"valid":"yes","lowerAic":true,"reliabilityPreserved":true}
  }
}
JSON
}

metric() { jq 'if .valid!=true or (.lowerAic|type)!="boolean" or (.reliabilityPreserved|type)!="boolean" then null elif .lowerAic and .reliabilityPreserved then 1 else 0 end'; }
normalize_timestamp() { jq -nr --arg value "$1" '($value|sub("\\.[0-9]+Z$";"Z")) as $v|if ($v|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and (try (($v|fromdateiso8601|todateiso8601)==$v) catch false) then $v else error("invalid") end' 2>/dev/null; }
time_shift() { jq -nr --arg value "$1" --argjson seconds "$2" '$value|fromdateiso8601+$seconds|todateiso8601'; }
earlier() { jq -nr --arg left "$1" --arg right "$2" 'if ($left|fromdateiso8601)<($right|fromdateiso8601) then $left else $right end'; }
emit_missing() { jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg matures "$4" --arg reason "$5" '{value:null,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,provenance:[],diagnostics:{missingReason:$reason}}'; }

collect_logs() {
    target_repo=$1; start_day=$2; end_day=$3; output=$4
    rm -rf "$tmp_dir/logs"; mkdir -p "$tmp_dir/logs"
    gh aw logs --repo "$target_repo" --start-date "$start_day" --end-date "$end_day" --count 10000 --max-github-api-rate-limit -2000 --json --output "$tmp_dir/logs" >"$output" 2>"$tmp_dir/logs.err"
    jq -e '(.runs|type)=="array"' "$output" >/dev/null
}

assign_case() {
    request_file=$1; target_repo=$(jq -r '.event.inputs.target_repo//empty' "$request_file")
    [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    run_id=$(jq -r .run.id "$request_file")
    created_at=$(jq -r .run.createdAt "$request_file"); baseline_start=$(time_shift "$created_at" -604800)
    log_prefix=$(printf '%s' "$target_repo" | sed 's|/|__|')
    log_file="/tmp/gh-aw/repo-memory/default/${log_prefix}__optimization-log.json"
    [[ -f $log_file ]] || return 1
    selected=$(jq -c --arg runId "$run_id" '
      [.[] | select((.optimizer_run_id | tostring) == $runId)] | last // null
    ' "$log_file")
    [[ $selected != null ]] || return 1
    workflow=$(printf '%s\n' "$selected" | jq -r '.workflow_path // empty')
    [[ $workflow == .github/workflows/*.lock.yml ]] || return 1
    jq -cn --arg targetRepo "$target_repo" --arg assignedAt "$created_at" --arg baselineStart "$baseline_start" \
      --arg workflow "$workflow" --arg optimizerRunId "$run_id" \
      '{targetRepo:$targetRepo,assignedAt:$assignedAt,baselineStart:$baselineStart,workflow:$workflow,optimizerRunId:$optimizerRunId}'
}

comparison() {
    logs_file=$1; case_json=$2; cutoff=$3
    jq -c --argjson case "$case_json" --arg cutoff "$cutoff" '
      def completed: (.status=="completed" or (.conclusion|type)=="string");
      def median: sort as $v|($v|length) as $n|if $n==0 then null elif ($n%2)==1 then $v[($n/2|floor)] else (($v[$n/2-1]+$v[$n/2])/2) end;
      [.runs[]|select((.workflow_path//.workflow_name)==$case.workflow and completed and .created_at >= $case.baselineStart and .created_at < $cutoff)] as $all
      | [$all[]|select(.created_at < $case.assignedAt)] as $before
      | [$all[]|select(.created_at >= $case.assignedAt)] as $after
      | [$before[]|select(.conclusion=="success" and (.aic|type)=="number")|.aic] as $beforeSuccess
      | [$after[]|select(.conclusion=="success" and (.aic|type)=="number")|.aic] as $afterSuccess
      | if ($before|length)==0 or ($after|length)==0 or ($beforeSuccess|length)==0 or ($afterSuccess|length)==0 then {valid:false}
        else ($beforeSuccess|median) as $beforeMedian|($afterSuccess|median) as $afterMedian
        | (($before|map(select(.conclusion!="success"))|length)/($before|length)) as $beforeFailure
        | (($after|map(select(.conclusion!="success"))|length)/($after|length)) as $afterFailure
        | {valid:true,lowerAic:($afterMedian<$beforeMedian),reliabilityPreserved:($afterFailure<=$beforeFailure),beforeMedian:$beforeMedian,afterMedian:$afterMedian,beforeFailureRate:$beforeFailure,afterFailureRate:$afterFailure,runIds:(($before+$after)|map(.run_id|tostring)|unique)} end
    ' "$logs_file"
}

grade_run() {
    request_file="$tmp_dir/request.json"; cat >"$request_file"
    if ! jq -e '.schemaVersion==1 and (.run.id|type)=="string" and (.run.createdAt|type)=="string" and (.evidenceAt|type)=="string"' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'; return
    fi
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    matures_at=$(time_shift "$created_at" "$MATURATION_SECONDS"); cutoff=$(earlier "$evidence_at" "$matures_at")
    case_json=$(jq -c .case "$request_file"); [[ $case_json != null ]] || case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'
    key="run:$(jq -r .run.id "$request_file")"
    [[ $(printf '%s\n' "$case_json"|jq -r '.assignmentMissing//false') != true ]] || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" assignment-unavailable; return; }
    target_repo=$(printf '%s\n' "$case_json"|jq -r .targetRepo); workflow=$(printf '%s\n' "$case_json"|jq -r .workflow); optimizer_run_id=$(printf '%s\n' "$case_json"|jq -r '.optimizerRunId // empty'); key="target-workflow:${target_repo}:${workflow}:${optimizer_run_id}"
    [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $workflow == .github/workflows/*.lock.yml && $optimizer_run_id =~ ^[0-9]+$ ]] || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-assignment; return; }
    collect_logs "$target_repo" "$(printf '%s\n' "$case_json"|jq -r .baselineStart|cut -dT -f1)" "${cutoff%%T*}" "$tmp_dir/all-logs.json" || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" logs-unavailable; return; }
    evidence=$(comparison "$tmp_dir/all-logs.json" "$case_json" "$cutoff")
    [[ $(printf '%s\n' "$evidence"|jq -r .valid) == true ]] || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" incomplete-comparable-evidence; return; }
    value=$(printf '%s\n' "$evidence"|metric); provenance=$(printf '%s\n' "$evidence"|jq --arg repository "$target_repo" '[.runIds[]|{repository:$repository,kind:"actions-run",ref:.}]')
    diagnostics=$(printf '%s\n' "$evidence"|jq 'del(.valid,.runIds,.lowerAic,.reliabilityPreserved)')
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" --arg cutoff "$cutoff" --arg matures "$matures_at" --argjson provenance "$provenance" --argjson diagnostics "$diagnostics" \
      '{value:$value,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,provenance:$provenance,diagnostics:$diagnostics}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac