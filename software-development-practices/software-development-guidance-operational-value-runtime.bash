#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

MATURATION_SECONDS=2592000
REPORT_WINDOW_SECONDS=21600
ADOPTION_COMMIT="fecd13d5c3e47265e4c83d5728389570535271ea"
ADOPTED_AT="2026-09-02T01:22:31Z"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/software-development-guidance-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    jq -n \
      --arg workflowName "$WORKFLOW_NAME" \
      --arg sourcePath "$SOURCE_PATH" \
      --arg adoptionCommit "$ADOPTION_COMMIT" \
      --arg adoptedAt "$ADOPTED_AT" \
      --arg operationalValue "$OPERATIONAL_VALUE" \
      --arg opportunity "$OPPORTUNITY" \
      --arg accepted "$ACCEPTED" \
      --arg framework "$FRAMEWORK" \
      --arg metricId "$METRIC_ID" '
      {
        schemaVersion: 4,
        grader: "operational-value",
        repository: "githubnext/gh-cao",
        workflowName: $workflowName,
        sourcePath: $sourcePath,
        adoption: {commit: $adoptionCommit, adoptedAt: $adoptedAt},
        operationalValue: $operationalValue,
        evidence: {
          opportunity: $opportunity,
          assignment: ("Bind targetRepo and evidenceRepo from workflow_dispatch inputs, then freeze the matching " + $framework + " guidance issue and its machine-readable target commit; key software-development-practices:" + $framework + ":<targetRepo>:<targetSha>. Duplicate runs for the same framework and target snapshot share the opportunity."),
          accepted: $accepted,
          repositories: ["githubnext/gh-cao"],
          collection: "Read the guidance marker once to freeze the framework and target commit, then read issue reactions through the capped evidence cutoff. Count only a thumbs-up reaction from a non-bot GitHub user.",
          maturation: "Thirty days after the worker run starts, matching the guidance issue expiry.",
          zeroRule: "Complete evidence for a matching guidance issue with no non-bot human acceptance reaction scores 0.",
          missingRule: "Missing target assignment, no matching guidance marker, inaccessible issue or reaction evidence, or a malformed assignment scores null."
        },
        primaryMetric: {
          id: $metricId,
          formula: "1 when a non-bot human accepts the frozen target-snapshot guidance with a thumbs-up reaction; otherwise 0",
          direction: "higher_is_better"
        },
        baseline: {
          mode: "attainment-only",
          value: null,
          evidenceCutoff: null,
          provenance: []
        },
        validationExamples: {
          targetAttained: {valid: true, accepted: true},
          targetMissed: {valid: true, accepted: false},
          missing: {valid: false, accepted: null},
          malformed: {valid: "yes", accepted: true}
        }
      }'
}

metric() {
    jq '
      if .valid != true or (.accepted | type) != "boolean" then null
      elif .accepted then 1 else 0 end
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

time_shift() {
    jq -nr --arg value "$1" --argjson seconds "$2" '$value | fromdateiso8601 + $seconds | todateiso8601'
}

earlier() {
    jq -nr --arg left "$1" --arg right "$2" '
      if ($left | fromdateiso8601) < ($right | fromdateiso8601) then $left else $right end
    '
}

emit_missing() {
    jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg maturesAt "$4" --arg reason "$5" '
      {value: null, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: [], diagnostics: {missingReason: $reason}}'
}

find_guidance() {
    evidence_repo=$1
    target_repo=$2
    assigned_at=$3
    cutoff=$4
    window_end=$(time_shift "$assigned_at" "$REPORT_WINDOW_SECONDS")
    window_end=$(earlier "$window_end" "$cutoff")
    gh api --paginate --method GET "repos/$evidence_repo/issues" \
      -f state=all -f sort=created -f direction=asc -f since="$assigned_at" -f per_page=100 \
      | jq -s --arg prefix "$TITLE_PREFIX" --arg target "$target_repo" \
          --arg from "$assigned_at" --arg to "$window_end" '
          add // []
          | [.[] | select((.pull_request | not)
              and ((.title // "") | startswith($prefix))
              and ((.body // "") | contains($target))
              and .created_at >= $from and .created_at <= $to)]
          | first // empty
          | {number, createdAt: .created_at, body: (.body // "")}
        ' 2>/dev/null
}

parse_guidance() {
    guidance=$1
    printf '%s\n' "$guidance" | jq -ce --arg framework "$FRAMEWORK" --arg target "$2" '
      (.body | try capture("<!-- operational-value: framework=(?<framework>[a-z0-9-]+) target=(?<target>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+) target-sha=(?<targetSha>[0-9a-f]{40}) -->")) as $marker
      | select($marker.framework == $framework and $marker.target == $target)
      | {number, createdAt, targetSha: $marker.targetSha}
    '
}

human_accepted() {
    evidence_repo=$1
    issue_number=$2
    cutoff=$3
    gh api --paginate "repos/$evidence_repo/issues/$issue_number/reactions?per_page=100" \
      -H "Accept: application/vnd.github+json" \
      | jq -s --arg cutoff "$cutoff" '
          add // []
          | any(.[];
              .content == "+1"
              and (.created_at // "") <= $cutoff
              and (.user.type // "") != "Bot"
              and ((.user.login // "") | endswith("[bot]") | not))
        ' 2>/dev/null
}

grade_run() {
    request_file="$tmp_dir/request.json"
    cat >"$request_file"
    if ! jq -e '
      .schemaVersion == 1
      and (.run.id | type) == "string"
      and (.run.createdAt | type) == "string"
      and (.evidenceAt | type) == "string"
    ' "$request_file" >/dev/null 2>&1; then
        printf '%s\n' '{"value":null,"opportunityKey":"invalid-request","case":{"invalidRequest":true},"evidenceCutoff":"1970-01-01T00:00:00Z","maturesAt":"1970-01-01T00:00:00Z","provenance":[],"diagnostics":{"missingReason":"invalid request"}}'
        return
    fi

    created_at=$(normalize_timestamp "$(jq -r .run.createdAt "$request_file")") || created_at=1970-01-01T00:00:00Z
    evidence_at=$(normalize_timestamp "$(jq -r .evidenceAt "$request_file")") || evidence_at=$created_at
    matures_at=$(time_shift "$created_at" "$MATURATION_SECONDS")
    cutoff=$(earlier "$evidence_at" "$matures_at")
    run_id=$(jq -r .run.id "$request_file")
    case_json=$(jq -c '
      if (.case | type) == "object" and (.case.targetRepo | type) == "string" then .case
      elif (.event.inputs.target_repo | type) == "string" then {
        targetRepo: .event.inputs.target_repo,
        evidenceRepo: (.event.inputs.safe_output_repo // .run.repository),
        assignedAt: .run.createdAt,
        workerRunId: .run.id
      }
      else {assignmentMissing: true}
      end
    ' "$request_file")
    if [[ $(printf '%s\n' "$case_json" | jq -r '.assignmentMissing // false') == true ]]; then
        emit_missing "run:${run_id}" "$case_json" "$cutoff" "$matures_at" assignment-unavailable
        return
    fi

    target_repo=$(printf '%s\n' "$case_json" | jq -r .targetRepo)
    evidence_repo=$(printf '%s\n' "$case_json" | jq -r .evidenceRepo)
    assigned_at=$(normalize_timestamp "$(printf '%s\n' "$case_json" | jq -r .assignedAt)") || assigned_at=$created_at
    key="run:${run_id}"
    if ! [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $evidence_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-assignment
        return
    fi

    guidance_assignment=$(printf '%s\n' "$case_json" | jq -c '.guidance // empty')
    if [[ -z $guidance_assignment ]]; then
        guidance=$(find_guidance "$evidence_repo" "$target_repo" "$assigned_at" "$cutoff") \
          || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" guidance-evidence-unavailable; return; }
        if [[ -z $guidance ]]; then
            emit_missing "$key" "$case_json" "$cutoff" "$matures_at" no-durable-guidance
            return
        fi
        guidance_assignment=$(parse_guidance "$guidance" "$target_repo") \
          || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-guidance-marker; return; }
        case_json=$(printf '%s\n' "$case_json" | jq -c --argjson guidance "$guidance_assignment" '.guidance = $guidance')
    fi

    target_sha=$(printf '%s\n' "$guidance_assignment" | jq -r '.targetSha // empty')
    issue_number=$(printf '%s\n' "$guidance_assignment" | jq -r '.number // empty')
    key="software-development-practices:${FRAMEWORK}:${target_repo}:${target_sha}"
    if ! [[ $target_sha =~ ^[0-9a-f]{40}$ && $issue_number =~ ^[0-9]+$ ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-guidance-assignment
        return
    fi
    accepted=$(human_accepted "$evidence_repo" "$issue_number" "$cutoff") \
      || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" reaction-evidence-unavailable; return; }
    evidence=$(jq -cn --argjson accepted "$accepted" '{valid: true, accepted: $accepted}')
    value=$(printf '%s\n' "$evidence" | metric)
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" \
      --arg cutoff "$cutoff" --arg maturesAt "$matures_at" --arg repository "$evidence_repo" \
      --arg targetRepo "$target_repo" --arg targetSha "$target_sha" --arg issue "$issue_number" --argjson accepted "$accepted" '
      {value: $value, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt,
       provenance: [
         {repository: $targetRepo, kind: "target-commit", ref: $targetSha},
         {repository: $repository, kind: "accepted-guidance-issue", ref: $issue}
       ],
       diagnostics: {humanAccepted: $accepted}}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac
