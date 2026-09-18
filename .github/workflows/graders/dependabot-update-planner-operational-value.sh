#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

MATURATION_SECONDS=1209600
BOOTSTRAP_WINDOW_SECONDS=21600

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dependabot-consumption-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "Dependabot / Update Planner",
  "sourcePath": ".github/workflows/dependabot-update-planner.md",
  "adoption": {"commit": "eee5133bfe88654948f63ce6380a9b1bf8f60de3", "adoptedAt": "2026-09-17T00:00:00Z"},
  "operationalValue": "Get at least one PR-sized child task from each durable Dependabot plan into active human or coding-agent use.",
  "evidence": {
    "opportunity": "One durable Dependabot plan with at most twelve PR-sized child tasks created or refreshed for a dispatched target repository.",
    "assignment": "Bind the safe-output repository, target repository, and exact plan issue number; key dependabot-plan:<safeOutputRepo>:<issueNumber> so refreshes share one opportunity.",
    "accepted": "Within fourteen days of publication, at least one child task is assigned, receives participation from someone other than the publishing automation, is cross-referenced by a pull request, or is closed as completed.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the bound parent and its native sub-issue list, then at most 100 comments and 100 timeline events for each of at most twelve children. Do not use GitHub search.",
    "maturation": "Fourteen days after the plan issue was created.",
    "zeroRule": "Complete mature evidence showing no consumed child task scores 0; assigning only the parent does not count.",
    "missingRule": "Missing assignment, an inaccessible parent or child, more than twelve children, incomplete comments or timeline evidence, or an immature plan with no child consumption signal scores null."
  },
  "primaryMetric": {"id": "dependabot-plan-consumption", "formula": "1 when the bound plan issue has at least one accepted consumption signal; otherwise 0 when mature evidence is complete.", "direction": "higher_is_better"},
  "baseline": {"mode": "attainment-only", "value": null, "evidenceCutoff": null, "provenance": []},
  "validationExamples": {
    "targetAttained": {"valid": true, "consumed": true},
    "targetMissed": {"valid": true, "consumed": false},
    "missing": {"valid": false, "consumed": null},
    "malformed": {"valid": true, "consumed": "yes"}
  }
}
JSON
}

metric() {
    jq 'if .valid != true or (.consumed | type) != "boolean" then null elif .consumed then 1 else 0 end'
}

normalize_timestamp() {
    jq -nr --arg value "$1" '($value | sub("\\.[0-9]+Z$"; "Z")) as $timestamp
      | if ($timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
          and (try (($timestamp | fromdateiso8601 | todateiso8601) == $timestamp) catch false)
        then $timestamp else error("invalid timestamp") end' 2>/dev/null
}

add_seconds() { jq -nr --arg value "$1" --argjson seconds "$2" '$value | fromdateiso8601 + $seconds | todateiso8601'; }
earlier_timestamp() { jq -nr --arg left "$1" --arg right "$2" 'if ($left | fromdateiso8601) < ($right | fromdateiso8601) then $left else $right end'; }
emit_missing() { jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg maturesAt "$4" --arg reason "$5" '{value:null,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$maturesAt,provenance:[],diagnostics:{missingReason:$reason}}'; }

find_created_issue() {
    evidence_repo=$1; target_repo=$2; created_at=$3; window_end=$4
    gh api --method GET "repos/$evidence_repo/issues" -f state=all \
      -f labels=dependabot -f per_page=100 \
      >"$tmp_dir/issues.json" 2>/dev/null || return 1
    jq -ce --arg target "$target_repo" --arg from "$created_at" --arg to "$window_end" '
      [.[] | select((.pull_request | not) and .created_at >= $from and .created_at < $to
        and (((.title // "") | endswith("Dependency update plan for \($target)"))
          or ((.body // "") | contains("<!-- dependabot-update-plan:repository=\($target) -->"))))]
      | sort_by(.created_at) | first // empty | {number, createdAt:.created_at}' "$tmp_dir/issues.json"
}

assign_case() {
    request_file=$1
    target_repo=$(jq -r '.event.inputs.target_repo // empty' "$request_file")
    [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    safe_output_mode=$(jq -r '.event.inputs.safe_output_mode // "review"' "$request_file")
    if [[ $safe_output_mode == review ]]; then
        evidence_repo=$(jq -r '.event.inputs.safe_output_repo // .run.repository // empty' "$request_file")
    else
        evidence_repo=$target_repo
    fi
    [[ $evidence_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    output_kind=$(jq -r 'def kind:.type//.kind//""|ascii_downcase|gsub("_";"-"); [.outputs[]?|select((kind=="create-issue")or(kind=="update-issue"))|kind]|first//empty' "$request_file")
    [[ -n $output_kind ]] || return 1
    issue_number=$(jq -r 'def kind:.type//.kind//""|ascii_downcase|gsub("_";"-"); def issue_ref:.issue_number//.issueNumber//.number//.target//empty; [.outputs[]?|select((kind=="create-issue")or(kind=="update-issue"))|issue_ref|select(type=="number" and .>0)]|first//empty' "$request_file")
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || return 1
    if [[ -z $issue_number && $output_kind == create-issue ]]; then
        issue=$(find_created_issue "$evidence_repo" "$target_repo" "$created_at" "$(add_seconds "$created_at" "$BOOTSTRAP_WINDOW_SECONDS")") || return 1
        issue_number=$(printf '%s\n' "$issue" | jq -r .number)
    fi
    [[ $issue_number =~ ^[1-9][0-9]*$ ]] || return 1
    jq -cn --arg targetRepo "$target_repo" --arg evidenceRepo "$evidence_repo" --argjson issueNumber "$issue_number" --arg assignedAt "$created_at" '{targetRepo:$targetRepo,evidenceRepo:$evidenceRepo,issueNumber:$issueNumber,assignedAt:$assignedAt}'
}

collect_issue_evidence() {
    evidence_repo=$1; issue_number=$2; assigned_at=$3
    gh api --method GET "repos/$evidence_repo/issues/$issue_number" >"$tmp_dir/issue.json" 2>/dev/null || return 1
    gh api --method GET "repos/$evidence_repo/issues/$issue_number/sub_issues" -f per_page=100 >"$tmp_dir/sub-issues.json" 2>/dev/null || return 1
    child_count=$(jq 'length' "$tmp_dir/sub-issues.json") || return 1
    (( child_count <= 12 )) || return 1
    : >"$tmp_dir/child-evidence.jsonl"
    while IFS= read -r child_number; do
        gh api --method GET "repos/$evidence_repo/issues/$child_number/comments" -f per_page=100 >"$tmp_dir/child-$child_number-comments.json" 2>/dev/null || return 1
        gh api --method GET "repos/$evidence_repo/issues/$child_number/timeline" -f per_page=100 >"$tmp_dir/child-$child_number-timeline.json" 2>/dev/null || return 1
        jq -cn --arg assignedAt "$assigned_at" --argjson childNumber "$child_number" --slurpfile children "$tmp_dir/sub-issues.json" --slurpfile comments "$tmp_dir/child-$child_number-comments.json" --slurpfile timeline "$tmp_dir/child-$child_number-timeline.json" '
          ($children[0][]|select(.number==$childNumber)) as $record
          | def publisher: .==($record.user.login//"") or .=="github-actions[bot]" or .=="dependabot[bot]" or test("^cao-.*\\[bot\\]$");
          ([$comments[0][]|select((.created_at//"") >= $assignedAt)|.user.login//empty|select(publisher|not)]|unique) as $participants
          | ([$timeline[0][]|select(.event=="assigned")|.assignee.login//empty]|unique) as $assignments
          | ([$timeline[0][]|select(.event=="cross-referenced")|.source.issue|select(.pull_request!=null)|.number]|unique) as $pulls
          | {number:$record.number,consumed:(($record.state=="closed" and $record.state_reason=="completed") or (($record.assignees//[])|length)>0 or ($assignments|length)>0 or ($participants|length)>0 or ($pulls|length)>0),completed:($record.state=="closed" and $record.state_reason=="completed"),currentAssigneeCount:(($record.assignees//[])|length),assignmentCount:($assignments|length),participantCount:($participants|length),linkedPullRequestNumbers:$pulls}' \
          >>"$tmp_dir/child-evidence.jsonl" || return 1
    done < <(jq -r '.[].number' "$tmp_dir/sub-issues.json")
    jq -s '.' "$tmp_dir/child-evidence.jsonl" >"$tmp_dir/child-evidence.json" || return 1
    jq -cn --slurpfile issue "$tmp_dir/issue.json" --slurpfile children "$tmp_dir/child-evidence.json" '
      ($issue[0]) as $record
      | ($children[0]) as $tasks
      | {valid:true,consumed:any($tasks[];.consumed),parentAssigneeCount:(($record.assignees//[])|length),childCount:($tasks|length),consumedChildCount:([$tasks[]|select(.consumed)]|length),completedChildCount:([$tasks[]|select(.completed)]|length),currentAssigneeCount:([$tasks[].currentAssigneeCount]|add//0),assignmentCount:([$tasks[].assignmentCount]|add//0),participantCount:([$tasks[].participantCount]|add//0),linkedPullRequestCount:([$tasks[].linkedPullRequestNumbers[]]|unique|length),linkedPullRequestNumbers:([$tasks[].linkedPullRequestNumbers[]]|unique),childIssueNumbers:([$tasks[].number]),issueCreatedAt:$record.created_at}'
}

grade_run() {
    request_file="$tmp_dir/request.json"; cat >"$request_file"
    if ! jq -e '.schemaVersion==1 and (.run.id|type)=="string" and (.run.createdAt|type)=="string" and (.evidenceAt|type)=="string"' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'; return
    fi
    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    case_json=$(jq -c '.case//empty' "$request_file")
    [[ -n $case_json ]] || case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'
    key="run:$(jq -r .run.id "$request_file")"
    if [[ $(printf '%s\n' "$case_json"|jq -r '.assignmentMissing//false') == true ]]; then emit_missing "$key" "$case_json" "$created_at" "$(add_seconds "$created_at" "$MATURATION_SECONDS")" plan-issue-assignment-unavailable; return; fi
    target_repo=$(printf '%s\n' "$case_json"|jq -r .targetRepo); evidence_repo=$(printf '%s\n' "$case_json"|jq -r .evidenceRepo); issue_number=$(printf '%s\n' "$case_json"|jq -r .issueNumber)
    assigned_at=$(normalize_timestamp "$(printf '%s\n' "$case_json"|jq -r .assignedAt)") || assigned_at=$created_at
    key="dependabot-plan:${evidence_repo}:${issue_number}"
    if ! [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $evidence_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $issue_number =~ ^[1-9][0-9]*$ ]]; then emit_missing "$key" "$case_json" "$created_at" "$(add_seconds "$created_at" "$MATURATION_SECONDS")" invalid-assignment; return; fi
    evidence=$(collect_issue_evidence "$evidence_repo" "$issue_number" "$assigned_at") || { emit_missing "$key" "$case_json" "$created_at" "$(add_seconds "$created_at" "$MATURATION_SECONDS")" issue-evidence-unavailable; return; }
    issue_created_at=$(normalize_timestamp "$(printf '%s\n' "$evidence"|jq -r .issueCreatedAt)") || issue_created_at=$created_at
    matures_at=$(add_seconds "$issue_created_at" "$MATURATION_SECONDS"); evidence_cutoff=$(earlier_timestamp "$evidence_at" "$matures_at")
    if [[ $(printf '%s\n' "$evidence"|jq -r .consumed) != true && $evidence_at < $matures_at ]]; then emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" maturation-pending; return; fi
    value=$(printf '%s\n' "$evidence"|metric)
    provenance=$(printf '%s\n' "$evidence"|jq --arg repository "$evidence_repo" --argjson issue "$issue_number" '[{repository:$repository,kind:"dependabot-plan-issue",ref:($issue|tostring)}]+[.childIssueNumbers[]|{repository:$repository,kind:"dependabot-task-issue",ref:(.|tostring)}]+[.linkedPullRequestNumbers[]|{repository:$repository,kind:"pull-request",ref:(.|tostring)}]')
    diagnostics=$(printf '%s\n' "$evidence"|jq 'del(.valid,.consumed,.linkedPullRequestNumbers,.childIssueNumbers,.issueCreatedAt)')
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" --arg cutoff "$evidence_cutoff" --arg maturesAt "$matures_at" --argjson provenance "$provenance" --argjson diagnostics "$diagnostics" '{value:$value,opportunityKey:$key,case:$case,evidenceCutoff:$cutoff,maturesAt:$maturesAt,provenance:$provenance,diagnostics:$diagnostics}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac