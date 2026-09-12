#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

REPOSITORY="githubnext/gh-aw-cao"
WORKFLOW_NAME="EU CRA / Maintenance"
LEDGER_PATH="eu-cra-compliance/implementation-status.md"
MATURATION_SECONDS=2592000

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/eu-cra-package-maintainer-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "EU CRA / Maintenance",
  "sourcePath": ".github/workflows/eu-cra-compliance-package-maintainer.md",
  "adoption": {
    "commit": "d7bea37d9ae5ea5af2282be06d19f72ab416493b",
    "adoptedAt": "2026-08-27T18:02:44Z"
  },
  "operationalValue": "Resolve the frozen EU CRA package-capability gaps through human-reviewed ledger changes.",
  "evidence": {
    "opportunity": "Each PARTIAL, MISSING, or INCOMPLETE requirement ID in the implementation ledger at the package-maintainer run's source commit.",
    "assignment": "Freeze the source ledger blob and its eligible requirement IDs; key cra-ledger:<repository>:<startingLedgerBlob>. Duplicate runs over the same ledger share the opportunity.",
    "accepted": "An assigned requirement ID no longer has a PARTIAL, MISSING, or INCOMPLETE status in the latest ledger at the evidence cutoff, and the ledger change arrived through a pull request approved by a non-bot human.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the immutable source ledger blob, the latest ledger commit at the capped cutoff, its associated pull request, and submitted reviews.",
    "maturation": "Thirty days after the package-maintainer run starts.",
    "zeroRule": "Complete evidence with no human-reviewed resolution of any assigned requirement ID scores 0.",
    "missingRule": "An inaccessible or malformed ledger, no eligible starting gap, inaccessible commit or review evidence, or an invalid run assignment scores null."
  },
  "primaryMetric": {
    "id": "human-reviewed-ledger-gap-resolution-share",
    "formula": "human-reviewed resolved assigned requirement IDs / assigned requirement IDs",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {"valid": true, "eligible": 3, "resolved": 3, "humanReviewed": true},
    "targetMissed": {"valid": true, "eligible": 3, "resolved": 0, "humanReviewed": false},
    "missing": {"valid": false, "eligible": null, "resolved": null, "humanReviewed": null},
    "malformed": {"valid": true, "eligible": 2, "resolved": 3, "humanReviewed": true}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true or (.eligible | type) != "number" or (.resolved | type) != "number"
        or (.humanReviewed | type) != "boolean" or .eligible <= 0 or .resolved < 0 or .resolved > .eligible
      then null
      elif .humanReviewed | not then 0
      else ((.resolved / .eligible) * 1000000 | round) / 1000000
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

load_ledger() {
    repository=$1
    ref=$2
    output=$3
    gh api "repos/$repository/contents/$LEDGER_PATH?ref=$ref" >"$tmp_dir/ledger-response.json" 2>/dev/null || return 1
    jq -e '(.sha | type) == "string" and (.content | type) == "string"' "$tmp_dir/ledger-response.json" >/dev/null || return 1
    jq -r .content "$tmp_dir/ledger-response.json" | tr -d '\n' | base64 --decode >"$output" 2>/dev/null || return 1
    jq -r .sha "$tmp_dir/ledger-response.json"
}

gap_ids() {
    jq -Rsc '
      split("\n")
      | [.[]
          | select(test("^\\| CRA-"))
          | split("|")
          | select(length >= 6 and (.[4] | test("^ (PARTIAL|MISSING|INCOMPLETE) $")))
          | .[1] | gsub("^ +| +$"; "")]
      | unique | sort
    ' "$1"
}

assign_case() {
    request_file=$1
    repository=$(jq -r .run.repository "$request_file")
    starting_ref=$(jq -r '.run.sha // empty' "$request_file")
    [[ $repository == "$REPOSITORY" && $starting_ref =~ ^[0-9a-f]{40}$ ]] || return 1
    starting_blob=$(load_ledger "$repository" "$starting_ref" "$tmp_dir/starting-ledger.md") || return 1
    assigned_gaps=$(gap_ids "$tmp_dir/starting-ledger.md") || return 1
    jq -cn --arg repository "$repository" --arg startingRef "$starting_ref" \
      --arg startingLedgerBlob "$starting_blob" --arg assignedAt "$(jq -r .run.createdAt "$request_file")" \
      --argjson gapIds "$assigned_gaps" '
      {repository: $repository, startingRef: $startingRef, startingLedgerBlob: $startingLedgerBlob,
       assignedAt: $assignedAt, gapIds: $gapIds}'
}

latest_ledger_commit() {
    repository=$1
    cutoff=$2
    gh api --paginate --method GET "repos/$repository/commits" \
      -f path="$LEDGER_PATH" -f until="$cutoff" -f per_page=100 \
      | jq -se '
          add // []
          | sort_by(.commit.committer.date)
          | last
          | select(.sha != null)
          | .sha
        ' 2>/dev/null
}

human_reviewed_pull() {
    repository=$1
    commit_sha=$2
    assigned_at=$3
    cutoff=$4
    gh api "repos/$repository/commits/$commit_sha/pulls" >"$tmp_dir/ledger-pulls.json" 2>/dev/null || return 2
    pull_number=$(jq -r --arg from "$assigned_at" --arg cutoff "$cutoff" '
      [.[] | select((.merged_at // "") >= $from and (.merged_at // "") <= $cutoff)]
      | first | .number // empty
    ' "$tmp_dir/ledger-pulls.json")
    [[ $pull_number =~ ^[0-9]+$ ]] || return 1
    gh api --paginate "repos/$repository/pulls/$pull_number/reviews?per_page=100" \
      | jq -s --arg cutoff "$cutoff" '
          add // []
          | any(.[];
              .state == "APPROVED"
              and (.submitted_at // "") <= $cutoff
              and (.user.type // "") != "Bot"
              and ((.user.login // "") | endswith("[bot]") | not))
        ' >"$tmp_dir/human-reviewed.json" 2>/dev/null || return 2
    [[ $(cat "$tmp_dir/human-reviewed.json") == true ]] || return 1
    printf '%s\n' "$pull_number"
}

grade_run() {
    request_file="$tmp_dir/request.json"
    cat >"$request_file"
    if ! jq -e '
      .schemaVersion == 1
      and (.run.id | type) == "string"
      and (.run.repository | type) == "string"
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
    case_json=$(jq -c .case "$request_file")
    if [[ $case_json == null ]]; then
        case_json=$(assign_case "$request_file") || case_json='{"assignmentMissing":true}'
    fi
    key="run:$(jq -r .run.id "$request_file")"
    if [[ $(printf '%s\n' "$case_json" | jq -r '.assignmentMissing // false') == true ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" assignment-unavailable
        return
    fi

    repository=$(printf '%s\n' "$case_json" | jq -r .repository)
    starting_blob=$(printf '%s\n' "$case_json" | jq -r .startingLedgerBlob)
    assigned_at=$(printf '%s\n' "$case_json" | jq -r .assignedAt)
    key="cra-ledger:${repository}:${starting_blob}"
    if ! [[ $repository == "$REPOSITORY" && $starting_blob =~ ^[0-9a-f]{40}$ ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" invalid-assignment
        return
    fi
    eligible=$(printf '%s\n' "$case_json" | jq '.gapIds | length')
    if [[ $eligible -eq 0 ]]; then
        emit_missing "$key" "$case_json" "$cutoff" "$matures_at" no-eligible-ledger-gaps
        return
    fi

    latest_commit=$(latest_ledger_commit "$repository" "$cutoff") \
      || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" ledger-history-unavailable; return; }
    latest_blob=$(load_ledger "$repository" "$latest_commit" "$tmp_dir/latest-ledger.md") \
      || { emit_missing "$key" "$case_json" "$cutoff" "$matures_at" latest-ledger-unavailable; return; }
    remaining_ids=$(gap_ids "$tmp_dir/latest-ledger.md")
    remaining=$(jq -n --argjson assigned "$(printf '%s\n' "$case_json" | jq .gapIds)" \
      --argjson current "$remaining_ids" '
        [$assigned[] as $id | select($current | index($id)) | $id] | length')
    resolved=$((eligible - remaining))
    human_reviewed=false
    pull_number=""
    if [[ $resolved -gt 0 ]]; then
        review_status=0
        pull_number=$(human_reviewed_pull "$repository" "$latest_commit" "$assigned_at" "$cutoff") || review_status=$?
        if [[ $review_status -eq 2 ]]; then
            emit_missing "$key" "$case_json" "$cutoff" "$matures_at" review-evidence-unavailable
            return
        elif [[ $review_status -eq 0 ]]; then
            human_reviewed=true
        fi
    fi

    evidence=$(jq -cn --argjson eligible "$eligible" --argjson resolved "$resolved" \
      --argjson humanReviewed "$human_reviewed" '
      {valid: true, eligible: $eligible, resolved: $resolved, humanReviewed: $humanReviewed}')
    value=$(printf '%s\n' "$evidence" | metric)
    provenance=$(jq -cn --arg repository "$repository" --arg starting "$starting_blob" \
      --arg latest "$latest_blob" --arg pull "$pull_number" '
      [{repository: $repository, kind: "starting-ledger-blob", ref: $starting},
       {repository: $repository, kind: "latest-ledger-blob", ref: $latest}]
      + (if $pull == "" then [] else [{repository: $repository, kind: "human-reviewed-pull-request", ref: $pull}] end)')
    jq -cn --argjson value "$value" --arg key "$key" --argjson case "$case_json" \
      --arg cutoff "$cutoff" --arg maturesAt "$matures_at" --argjson provenance "$provenance" \
      --argjson eligible "$eligible" --argjson resolved "$resolved" --argjson humanReviewed "$human_reviewed" '
      {value: $value, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: $provenance,
       diagnostics: {eligible: $eligible, resolved: $resolved, humanReviewed: $humanReviewed}}'
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    --grade-run) [[ $# -eq 1 ]] || exit 2; grade_run ;;
    *) printf 'usage: %s --definition|--metric|--grade-run\n' "$0" >&2; exit 2 ;;
esac
