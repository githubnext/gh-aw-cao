#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

REPOSITORY=githubnext/gh-aw-cao
WORKFLOW_NAME="Dependabot / Release Trains"
MATURATION_SECONDS=1209600

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dependabot-release-train-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4, "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao", "workflowName": "Dependabot / Release Trains",
  "sourcePath": ".github/workflows/dependabot-release-train-updater.md",
  "adoption": {"commit": "4615c8d8eaf51dab837238dff6fc8248a56194fe", "adoptedAt": "2026-07-16T15:40:56Z"},
  "operationalValue": "Resolve one dependency-update opportunity in the dispatched target with a validated merge.",
  "evidence": {
    "opportunity": "The oldest dependency pull request open in the dispatched target at run creation, among pull requests created during the preceding 30 days that are Dependabot-authored or change a dependency manifest or lockfile.",
    "assignment": "Bind targetRepo from workflow_dispatch inputs, or recover it from the worker run title for historical reports; freeze the oldest eligible pull request and its required checks at run creation, breaking ties by pull-request number; key dependency-pr:<targetRepo>:<number>. Duplicate runs for the same pull request repeat the key.",
    "accepted": "The assigned pull request is merged by the evidence cutoff and every required status check frozen at assignment has succeeded by that cutoff.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the worker run metadata when target recovery is needed, query target pull requests and changed files once for assignment, then query the assigned pull request, immutable merge commit, and required-check results through the capped cutoff.",
    "maturation": "Fourteen days after the workflow run starts.",
    "zeroRule": "Complete evidence showing that the assigned pull request was not validly merged by the capped cutoff scores 0.",
    "missingRule": "Missing target assignment, no eligible pull request, inaccessible pull-request evidence, or unavailable required-check configuration scores null."
  },
  "primaryMetric": {"id": "validated-dependency-resolution", "formula": "1 when the assigned dependency pull request is merged and all required checks frozen at assignment succeeded by the capped cutoff; otherwise 0", "direction": "higher_is_better"},
  "baseline": {"mode": "attainment-only", "value": null, "evidenceCutoff": null, "provenance": []},
  "validationExamples": {
    "targetAttained": {"valid": true, "resolved": true},
    "targetMissed": {"valid": true, "resolved": false},
    "missing": {"valid": false, "resolved": null},
    "malformed": {"valid": true, "resolved": "yes"}
  }
}
JSON
}

metric() {
    jq 'if .valid != true or (.resolved|type)!="boolean" then null
      elif .resolved then 1 else 0 end'
}

normalize_timestamp() {
    jq -nr --arg value "$1" '($value|sub("\\.[0-9]+Z$";"Z")) as $v
      | if ($v|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
        and (try (($v|fromdateiso8601|todateiso8601)==$v) catch false) then $v else error("invalid") end' 2>/dev/null
}

time_shift() { jq -nr --arg value "$1" --argjson seconds "$2" '$value|fromdateiso8601+$seconds|todateiso8601'; }
earlier() { jq -nr --arg left "$1" --arg right "$2" 'if ($left|fromdateiso8601)<($right|fromdateiso8601) then $left else $right end'; }

emit_missing() {
    jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg matures "$4" --arg reason "$5" \
      '{value:null,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,provenance:[],diagnostics:{missingReason:$reason}}'
}

dependency_file_regex='(^|/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock|requirements[^/]*\.txt|constraints[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|setup\.(py|cfg)|Gemfile(\.lock)?|go\.(mod|sum|work)|Cargo\.(toml|lock)|composer\.(json|lock)|mix\.(exs|lock)|pubspec\.(yaml|lock)|Package\.swift|Podfile(\.lock)?|packages?\.lock\.json|Directory\.Packages\.props|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|MODULE\.bazel(\.lock)?|WORKSPACE|flake\.(nix|lock)|dependabot\.ya?ml)$'

required_checks() {
    target_repo=$1; branch=$2; output=$3
    if gh api "repos/$target_repo/branches/$branch/protection/required_status_checks" >"$tmp_dir/required-raw.json" 2>/dev/null; then
        jq '[
          (.checks[]? | {context:.context,appId:(.app_id // null)}),
          (.contexts[]? | {context:.,appId:null})
        ] | unique_by([.context,.appId])' "$tmp_dir/required-raw.json" >"$output"
        return
    fi
    protected=$(gh api "repos/$target_repo/branches/$branch" --jq .protected 2>/dev/null) || return 1
    [[ $protected == false ]] || return 1
    printf '%s\n' '[]' >"$output"
}

resolve_target_repo() {
    request_file=$1
    target_repo=$(jq -r '.event.inputs.target_repo // empty' "$request_file")
    if [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        printf '%s\n' "$target_repo"
        return
    fi
    control_repo=$(jq -r .run.repository "$request_file")
    run_id=$(jq -r .run.id "$request_file")
    [[ $control_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    gh api "repos/$control_repo/actions/runs/$run_id" >"$tmp_dir/run.json" 2>/dev/null || return 1
    jq -er '.display_title
      | capture("^Dependabot release train \\u00b7 (?<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+) \\u00b7 ").repo' \
      "$tmp_dir/run.json"
}

assign_case() {
    request_file=$1
    target_repo=$(resolve_target_repo "$request_file") || return 1
    created_at=$(jq -r .run.createdAt "$request_file")
    window_start=$(time_shift "$created_at" -2592000)
    gh api --paginate --method GET "repos/$target_repo/pulls" -f state=all -f sort=created -f direction=desc -f per_page=100 \
      | jq -s 'add // []' >"$tmp_dir/pulls.json" 2>/dev/null || return 1
    : >"$tmp_dir/candidates.ndjson"
    while IFS=$'\t' read -r number author created closed branch; do
        [[ $created < $window_start || $created > $created_at ]] && continue
        [[ -n $closed && $closed < $created_at ]] && continue
        files="$tmp_dir/files-$number.json"
        gh api --paginate "repos/$target_repo/pulls/$number/files?per_page=100" --jq '.[].filename' \
          | jq -Rsc 'split("\n")|map(select(length>0))' >"$files" 2>/dev/null || return 1
        is_dependency=$(jq --arg author "$author" --arg regex "$dependency_file_regex" \
          '($author|ascii_downcase|startswith("dependabot")) or any(.[];test($regex;"i"))' "$files")
        [[ $is_dependency == true ]] || continue
        jq -cn --argjson number "$number" --arg createdAt "$created" --arg baseRef "$branch" \
          '{number:$number,createdAt:$createdAt,baseRef:$baseRef}' >>"$tmp_dir/candidates.ndjson"
    done < <(jq -r '.[]|[.number,(.user.login//""),.created_at,(.closed_at//""),.base.ref]|@tsv' "$tmp_dir/pulls.json")
    opportunity=$(jq -cs 'sort_by(.createdAt,.number)|first//null' "$tmp_dir/candidates.ndjson")
    if [[ $opportunity != null ]]; then
        number=$(printf '%s\n' "$opportunity" | jq -r .number)
        branch=$(printf '%s\n' "$opportunity" | jq -r .baseRef)
        required_file="$tmp_dir/required-$number.json"
        required_checks "$target_repo" "$branch" "$required_file" || return 1
        opportunity=$(printf '%s\n' "$opportunity" | jq -c --slurpfile required "$required_file" '.requiredChecks=$required[0]')
    fi
    jq -cn --arg targetRepo "$target_repo" --arg runId "$(jq -r .run.id "$request_file")" \
      --arg assignedAt "$created_at" --argjson opportunity "$opportunity" \
      '{targetRepo:$targetRepo,runId:$runId,assignedAt:$assignedAt,opportunity:$opportunity}'
}

validated_pull() {
    target_repo=$1; number=$2; cutoff=$3; required=$4
    gh api "repos/$target_repo/pulls/$number" >"$tmp_dir/pull-$number.json" 2>/dev/null || return 2
    merged_at=$(jq -r '.merged_at // empty' "$tmp_dir/pull-$number.json")
    merge_sha=$(jq -r '.merge_commit_sha // empty' "$tmp_dir/pull-$number.json")
    [[ -n $merged_at && -n $merge_sha ]] || return 1
    [[ $merged_at > $cutoff ]] && return 1
    [[ $(printf '%s\n' "$required" | jq -r 'type') == array ]] || return 2
    [[ $(printf '%s\n' "$required" | jq length) -gt 0 ]] || return 0
    gh api --paginate "repos/$target_repo/commits/$merge_sha/check-runs?per_page=100" --jq '.check_runs[]' | jq -s '.' >"$tmp_dir/checks-$number.json" 2>/dev/null || return 2
    gh api "repos/$target_repo/commits/$merge_sha/status" >"$tmp_dir/status-$number.json" 2>/dev/null || return 2
    jq -en --arg cutoff "$cutoff" --argjson required "$required" --slurpfile checks "$tmp_dir/checks-$number.json" --slurpfile statuses "$tmp_dir/status-$number.json" '
      [$checks[0][]|select(.conclusion=="success" and .completed_at <= $cutoff)|{context:.name,appId:(.app.id//null)}] as $checks
      | [$statuses[0].statuses[]?|select(.state=="success" and .created_at <= $cutoff)|{context:.context,appId:null}] as $statuses
      | all($required[] as $wanted; any(($checks+$statuses)[];
          .context==$wanted.context and ($wanted.appId==null or .appId==$wanted.appId)))' >/dev/null
}

grade_run() {
    request_file="$tmp_dir/request.json"; cat >"$request_file"
    if ! jq -e '.schemaVersion==1 and (.run.id|type)=="string" and (.run.createdAt|type)=="string" and (.evidenceAt|type)=="string"' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'; return
    fi
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    matures_at=$(time_shift "$created_at" "$MATURATION_SECONDS"); cutoff=$(earlier "$evidence_at" "$matures_at")
    if [[ $(jq -r .run.repository "$request_file") != "$REPOSITORY" || $(jq -r .run.workflow "$request_file") != "$WORKFLOW_NAME" ]]; then
        emit_missing "run:$(jq -r .run.id "$request_file")" '{"assignmentMissing":true}' "$cutoff" "$matures_at" contract-mismatch
        return
    fi
    case_json=$(jq -c '.case' "$request_file")
    if [[ $case_json == null ]]; then case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'; fi
    key="run:$(jq -r .run.id "$request_file")"
    if [[ $(printf '%s\n' "$case_json"|jq -r '.assignmentMissing//false') == true ]]; then emit_missing "$key" "$case_json" "$cutoff" "$matures_at" assignment-unavailable; return; fi
    if ! printf '%s\n' "$case_json" | jq -e '
      (.targetRepo|type)=="string" and (.targetRepo|test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
      and (.opportunity==null or ((.opportunity|type)=="object"
        and (.opportunity.number|type)=="number" and .opportunity.number>0 and (.opportunity.number|floor)==.opportunity.number
        and (.opportunity.requiredChecks|type)=="array"))' >/dev/null; then
        emit_missing "$key" '{"assignmentMissing":true}' "$cutoff" "$matures_at" invalid-case
        return
    fi
    target_repo=$(printf '%s\n' "$case_json"|jq -r .targetRepo)
    opportunity=$(printf '%s\n' "$case_json"|jq -c '.opportunity//null')
    [[ $opportunity != null ]] || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" no-eligible-opportunity; return; }
    number=$(printf '%s\n' "$opportunity"|jq -r .number)
    required=$(printf '%s\n' "$opportunity"|jq -c .requiredChecks)
    key="dependency-pr:${target_repo}:${number}"
    result=0
    validated_pull "$target_repo" "$number" "$cutoff" "$required" || result=$?
    [[ $result -ne 2 ]] || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" required-check-evidence-unavailable; return; }
    resolved=false; [[ $result -eq 0 ]] && resolved=true
    evidence=$(jq -cn --argjson resolved "$resolved" '{valid:true,resolved:$resolved}')
    value=$(printf '%s\n' "$evidence"|metric)
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" --arg cutoff "$cutoff" --arg matures "$matures_at" \
      --arg target "$target_repo" --argjson number "$number" \
      '{value:$value,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$matures,
       provenance:[{repository:$target,kind:"pull-request",ref:($number|tostring)}],diagnostics:{}}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac