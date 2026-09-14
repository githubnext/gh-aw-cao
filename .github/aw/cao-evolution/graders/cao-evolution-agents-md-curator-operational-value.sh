#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

WORKFLOW_NAME="AW Optimization / AGENTS.md"
MATURATION_SECONDS=2592000
MIN_TOKEN_REDUCTION=0.10
PROPOSAL_WINDOW_SECONDS=21600
COMPARISON_WINDOW_SECONDS=2592000
MAX_INSPECTED_PULLS=50

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/optimization-agents-md-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4, "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao", "workflowName": "AW Optimization / AGENTS.md",
  "sourcePath": ".github/workflows/optimization-agents-md-curator.md",
  "adoption": {"commit": "ae39923baa7cb8bfa57dfcc158534adc24c2b793", "adoptedAt": "2026-08-26T23:22:08Z"},
  "operationalValue": "Make the dispatched target's agents at least ten percent cheaper to run for the same delivered outcome quality by leaning out its always-loaded AGENTS.md.",
  "evidence": {
    "opportunity": "The dispatched target repository's root AGENTS.md at the time of the run, provided the run filed an optimization proposal issue for it.",
    "assignment": "Bind targetRepo from workflow_dispatch inputs and freeze the proposal issue this run created in the safe-output repository; key agents-md:<targetRepo>:<runId>.",
    "accepted": "Within thirty days of the proposal, a merged pull request changes the target's root AGENTS.md, and the target's completed agentic-workflow runs after that merge show a median successful-run token usage at least ten percent below the pre-merge median with no higher completed-run failure rate. Ten percent matches the minimum gain the curator is required to estimate before it is allowed to file a proposal at all.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the frozen proposal issue from the safe-output repository, merged pull requests touching AGENTS.md in the target, and retained gh aw run logs for the target from thirty days before the merge through the capped evidence cutoff.",
    "maturation": "Thirty days after the curator run starts, matching the frozen thirty-day expiry of the proposal issue.",
    "zeroRule": "Complete comparable evidence with no merged AGENTS.md change, a token reduction below ten percent, or a higher failure rate scores 0.",
    "missingRule": "Missing assignment, no proposal issue, inaccessible logs, or no successful completed runs on either side of the merge scores null."
  },
  "primaryMetric": {"id": "leaner-context-same-quality", "formula": "1 when the proposed AGENTS.md change merged and median successful-run token usage falls by at least ten percent with no increase in the completed-run failure rate; otherwise 0", "direction": "higher_is_better"},
  "baseline": {"mode": "attainment-only", "value": null, "evidenceCutoff": null, "provenance": []},
  "validationExamples": {
    "targetAttained": {"valid":true,"contextApplied":true,"tokenGainMet":true,"qualityPreserved":true},
    "targetMissed": {"valid":true,"contextApplied":true,"tokenGainMet":false,"qualityPreserved":true},
    "missing": {"valid":false,"contextApplied":null,"tokenGainMet":null,"qualityPreserved":null},
    "malformed": {"valid":"yes","contextApplied":true,"tokenGainMet":true,"qualityPreserved":true}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true or (.contextApplied | type) != "boolean" then null
      elif (.contextApplied | not) then 0
      elif (.tokenGainMet | type) != "boolean" or (.qualityPreserved | type) != "boolean" then null
      elif .tokenGainMet and .qualityPreserved then 1
      else 0
      end
    '
}

normalize_timestamp() { jq -nr --arg value "$1" '($value|sub("\\.[0-9]+Z$";"Z")) as $v|if ($v|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and (try (($v|fromdateiso8601|todateiso8601)==$v) catch false) then $v else error("invalid") end' 2>/dev/null; }
time_shift() { jq -nr --arg value "$1" --argjson seconds "$2" '$value|fromdateiso8601+$seconds|todateiso8601'; }
earlier() { jq -nr --arg left "$1" --arg right "$2" 'if ($left|fromdateiso8601)<($right|fromdateiso8601) then $left else $right end'; }
emit_missing() { jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg matures "$4" --arg reason "$5" '{value:null,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,provenance:[],diagnostics:{missingReason:$reason}}'; }

# The run filed at most one issue, so the proposal is identified by the frozen title
# prefix, a body naming the assigned target, and creation inside the run's own window.
find_proposal() {
    evidence_repo=$1; target_repo=$2; created_at=$3; window_end=$4
    gh api --paginate --method GET "repos/$evidence_repo/issues" \
      -f state=all -f sort=created -f direction=asc -f since="$created_at" -f per_page=100 \
      | jq -s 'add // []' >"$tmp_dir/issues.json" 2>/dev/null || return 1
    jq -ce --arg target "$target_repo" --arg from "$created_at" --arg to "$window_end" '
      [.[] | select((.pull_request | not)
        and ((.title // "") | startswith("[optimization:agents-md-curator] "))
        and ((.body // "") | contains($target))
        and .created_at >= $from and .created_at < $to)]
      | first // empty | {number, createdAt: .created_at}
    ' "$tmp_dir/issues.json"
}

# Adoption is a merged pull request that changes the target's root AGENTS.md after the
# proposal. This records co-occurrence in the assigned window; it does not prove causation.
find_applied_change() {
    target_repo=$1; from=$2; to=$3
    gh api --paginate --method GET "repos/$target_repo/pulls" \
      -f state=closed -f sort=updated -f direction=desc -f per_page=100 \
      | jq -s 'add // []' >"$tmp_dir/pulls.json" 2>/dev/null || return 1
    candidates=$(jq -r --arg from "$from" --arg to "$to" '
      [.[] | select((.merged_at | type) == "string" and .merged_at >= $from and .merged_at < $to)]
      | sort_by(.merged_at) | .[] | "\(.number) \(.merged_at)"
    ' "$tmp_dir/pulls.json")
    [[ -n $candidates ]] || return 1
    inspected=0
    while read -r number merged_at; do
        [[ -n $number ]] || continue
        inspected=$((inspected + 1))
        [[ $inspected -le $MAX_INSPECTED_PULLS ]] || break
        gh api --paginate "repos/$target_repo/pulls/$number/files" --jq '.[].filename' >"$tmp_dir/files.txt" 2>/dev/null </dev/null || continue
        if grep -qx 'AGENTS.md' "$tmp_dir/files.txt"; then
            jq -cn --argjson number "$number" --arg mergedAt "$merged_at" '{number:$number,mergedAt:$mergedAt}'
            return 0
        fi
    done <<<"$candidates"
    return 1
}

collect_logs() {
    target_repo=$1; start_day=$2; end_day=$3; output=$4
    rm -rf "$tmp_dir/logs"; mkdir -p "$tmp_dir/logs"
    gh aw logs --repo "$target_repo" --start-date "$start_day" --end-date "$end_day" --count 10000 --max-github-api-rate-limit -2000 --json --output "$tmp_dir/logs" >"$output" 2>"$tmp_dir/logs.err"
    jq -e '(.runs|type)=="array"' "$output" >/dev/null
}

# Token usage per successful run measures cost; the completed-run failure rate holds
# delivered quality fixed, so a cheaper run only counts when reliability does not regress.
# The ten percent floor is the same minimum gain the curator must estimate before it may
# file a proposal, so the evaluator scores the promise the worker actually made.
comparison() {
    logs_file=$1; window_start=$2; merged_at=$3; cutoff=$4
    jq -c --arg start "$window_start" --arg merged "$merged_at" --arg cutoff "$cutoff" --argjson floor "$MIN_TOKEN_REDUCTION" '
      def completed: (.conclusion|type)=="string";
      def median: sort as $v|($v|length) as $n|if $n==0 then null elif ($n%2)==1 then $v[($n/2|floor)] else (($v[$n/2-1]+$v[$n/2])/2) end;
      [.runs[]|select(completed and .created_at >= $start and .created_at < $cutoff)] as $all
      | [$all[]|select(.created_at < $merged)] as $before
      | [$all[]|select(.created_at >= $merged)] as $after
      | [$before[]|select(.conclusion=="success" and (.token_usage|type)=="number")|.token_usage] as $beforeTokens
      | [$after[]|select(.conclusion=="success" and (.token_usage|type)=="number")|.token_usage] as $afterTokens
      | if ($before|length)==0 or ($after|length)==0 or ($beforeTokens|length)==0 or ($afterTokens|length)==0 then {valid:false}
        else ($beforeTokens|median) as $beforeMedian|($afterTokens|median) as $afterMedian
        | (($before|map(select(.conclusion!="success"))|length)/($before|length)) as $beforeFailure
        | (($after|map(select(.conclusion!="success"))|length)/($after|length)) as $afterFailure
        | (if $beforeMedian>0 then ($beforeMedian-$afterMedian)/$beforeMedian else null end) as $reduction
        | {valid:true,tokenGainMet:($reduction!=null and $reduction>=$floor),qualityPreserved:($afterFailure<=$beforeFailure),
           beforeMedianTokens:$beforeMedian,afterMedianTokens:$afterMedian,tokenReduction:$reduction,requiredTokenReduction:$floor,
           beforeFailureRate:$beforeFailure,afterFailureRate:$afterFailure,
           runIds:(($before+$after)|map(.run_id|tostring)|unique)} end
    ' "$logs_file"
}

grade_run() {
    request_file="$tmp_dir/request.json"; cat >"$request_file"
    if ! jq -e '.schemaVersion==1 and (.run.id|type)=="string" and (.run.createdAt|type)=="string" and (.evidenceAt|type)=="string"' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'; return
    fi
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    matures_at=$(time_shift "$created_at" "$MATURATION_SECONDS")
    cutoff=$(earlier "$evidence_at" "$matures_at")
    run_id=$(jq -r .run.id "$request_file")
    case_json=$(jq -c '
      if (.case|type)=="object" and (.case.targetRepo|type)=="string" then .case
      elif (.event.inputs.target_repo|type)=="string" then {
        targetRepo: .event.inputs.target_repo,
        evidenceRepo: (.event.inputs.safe_output_repo // .run.repository),
        assignedAt: .run.createdAt,
        curatorRunId: .run.id
      }
      else {assignmentMissing:true}
      end' "$request_file")
    key="agents-md:$(printf '%s\n' "$case_json"|jq -r '.targetRepo // "unassigned"'):${run_id}"
    [[ $(printf '%s\n' "$case_json"|jq -r '.assignmentMissing//false') != true ]] || { emit_missing "run:${run_id}" "$case_json" "$cutoff" "$matures_at" assignment-unavailable; return; }
    target_repo=$(printf '%s\n' "$case_json"|jq -r .targetRepo)
    evidence_repo=$(printf '%s\n' "$case_json"|jq -r .evidenceRepo)
    assigned_at=$(normalize_timestamp "$(printf '%s\n' "$case_json"|jq -r .assignedAt)") || assigned_at=$created_at
    if ! [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $evidence_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-assignment; return
    fi

    proposal=$(printf '%s\n' "$case_json"|jq -c '.proposal // empty')
    if [[ -z $proposal ]]; then
        proposal=$(find_proposal "$evidence_repo" "$target_repo" "$assigned_at" "$(time_shift "$assigned_at" "$PROPOSAL_WINDOW_SECONDS")") \
          || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" no-proposal-issue; return; }
        case_json=$(printf '%s\n' "$case_json"|jq -c --argjson proposal "$proposal" '.proposal=$proposal')
    fi
    issue_number=$(printf '%s\n' "$proposal"|jq -r .number)

    applied=$(find_applied_change "$target_repo" "$assigned_at" "$cutoff") || applied=""
    if [[ -z $applied ]]; then
        evidence=$(jq -cn '{valid:true,contextApplied:false}')
        value=$(printf '%s\n' "$evidence"|metric)
        jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" --arg cutoff "$cutoff" \
          --arg matures "$matures_at" --arg evidence "$evidence_repo" --argjson issue "$issue_number" '
          {value:$value,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,
           provenance:[{repository:$evidence,kind:"proposal-issue",ref:($issue|tostring)}],
           diagnostics:{contextApplied:false}}'
        return
    fi
    merged_at=$(printf '%s\n' "$applied"|jq -r .mergedAt)
    pull_number=$(printf '%s\n' "$applied"|jq -r .number)
    window_start=$(time_shift "$merged_at" "-$COMPARISON_WINDOW_SECONDS")
    collect_logs "$target_repo" "${window_start%%T*}" "${cutoff%%T*}" "$tmp_dir/all-logs.json" \
      || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" logs-unavailable; return; }
    evidence=$(comparison "$tmp_dir/all-logs.json" "$window_start" "$merged_at" "$cutoff")
    [[ $(printf '%s\n' "$evidence"|jq -r .valid) == true ]] \
      || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" incomplete-comparable-evidence; return; }
    evidence=$(printf '%s\n' "$evidence"|jq -c '.contextApplied=true')
    value=$(printf '%s\n' "$evidence"|metric)
    provenance=$(printf '%s\n' "$evidence"|jq --arg target "$target_repo" --arg evidence "$evidence_repo" \
      --argjson issue "$issue_number" --argjson pull "$pull_number" '
      [{repository:$evidence,kind:"proposal-issue",ref:($issue|tostring)},
       {repository:$target,kind:"agents-md-pull-request",ref:($pull|tostring)}]
      + [.runIds[]|{repository:$target,kind:"actions-run",ref:.}]')
    diagnostics=$(printf '%s\n' "$evidence"|jq 'del(.valid,.runIds,.tokenGainMet,.qualityPreserved)')
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" --arg cutoff "$cutoff" \
      --arg matures "$matures_at" --argjson provenance "$provenance" --argjson diagnostics "$diagnostics" '
      {value:$value,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,
       provenance:$provenance,diagnostics:$diagnostics}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac
