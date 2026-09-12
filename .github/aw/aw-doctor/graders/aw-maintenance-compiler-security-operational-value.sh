#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

MATURATION_SECONDS=3600
RESULT_FILE=/tmp/gh-aw/agent/aw-maintenance-compiler-security/result.json

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "AW Doctor / Compiler Security",
  "sourcePath": ".github/workflows/aw-maintenance-compiler-security.md",
  "adoption": {
    "commit": "2cc8ea81865e35063b5ea31079dabc7edf557cde",
    "adoptedAt": "2026-09-03T12:54:42Z"
  },
  "operationalValue": "Attain a target revision whose agentic workflows pass the complete gh-aw validation and security scan.",
  "evidence": {
    "opportunity": "The agentic-workflow validation and security posture of the exact target repository revision assigned to the worker run.",
    "assignment": "Bind the dispatched target repository to the checked-out target commit and the deterministic full-scan result; key aw-compiler-security:<targetRepo>:<targetSha> so duplicate runs of one revision share an opportunity.",
    "accepted": "The worker's deterministic compile step completed the full strict validation and security command for the assigned target revision and exited successfully.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the bounded result.json emitted by the deterministic compile step in the worker run; retain the target commit, completion classification, exit code, and report digest in the replayable case.",
    "maturation": "One hour after the worker run starts, covering its configured execution horizon.",
    "zeroRule": "A completed full scan with compiler, validation, lint, vulnerability, license, or security findings scores 0.",
    "missingRule": "Missing or malformed assignment evidence, an unavailable required tool or service, a timeout, or another incomplete scan scores null."
  },
  "primaryMetric": {
    "id": "clean-full-scan-attainment",
    "formula": "1 when a complete full scan is clean; 0 when a complete full scan has findings; null when the scan is incomplete or evidence is invalid.",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {"valid": true, "scanComplete": true, "clean": true},
    "targetMissed": {"valid": true, "scanComplete": true, "clean": false},
    "missing": {"valid": false, "scanComplete": null, "clean": null},
    "malformed": {"valid": true, "scanComplete": "true", "clean": true}
  }
}
JSON
}

metric() {
    jq '
      if .valid != true
          or (.scanComplete | type) != "boolean"
          or (.clean | type) != "boolean"
          or (.scanComplete | not)
        then null
      elif .clean then 1
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
    jq -cn --arg key "$1" --argjson case "$2" --arg cutoff "$3" --arg maturesAt "$4" --arg reason "$5" '
      {value: null, opportunityKey: $key, case: $case, evidenceCutoff: $cutoff,
       maturesAt: $maturesAt, provenance: [], diagnostics: {missingReason: $reason}}'
}

assign_case() {
    request_file=$1
    target_repo=$(jq -r '.event.inputs.target_repo // empty' "$request_file")
    [[ $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    [[ -f $RESULT_FILE ]] || return 1
    jq -ce --arg targetRepo "$target_repo" '
      select(
        .targetRepo == $targetRepo
        and (.targetSha | type) == "string"
        and (.targetSha | test("^[0-9a-f]{40}$"))
        and (.exitCode | type) == "number"
        and (.scanComplete | type) == "boolean"
        and (.clean | type) == "boolean"
        and (.reportDigest | type) == "string"
        and (.reportDigest | test("^[0-9a-f]{64}$"))
      )
    ' "$RESULT_FILE"
}

grade_run() {
    request_file=$(mktemp "${TMPDIR:-/tmp}/aw-compiler-security-value.XXXXXX")
    trap 'rm -f "$request_file"' EXIT HUP INT TERM
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
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" assignment-evidence-unavailable
        return
    fi
    target_repo=$(printf '%s\n' "$case_json" | jq -r '.targetRepo // empty')
    target_sha=$(printf '%s\n' "$case_json" | jq -r '.targetSha // empty')
    key="aw-compiler-security:${target_repo}:${target_sha}"
    if [[ ! $target_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || ! $target_sha =~ ^[0-9a-f]{40}$ ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" invalid-assignment
        return
    fi
    evidence=$(printf '%s\n' "$case_json" | jq -c '
      {valid: true, scanComplete: .scanComplete, clean: .clean}')
    value=$(printf '%s\n' "$evidence" | metric)
    if [[ $value == null ]]; then
        emit_missing "$key" "$case_json" "$evidence_cutoff" "$matures_at" incomplete-scan
        return
    fi
    run_id=$(jq -r .run.id "$request_file")
    provenance=$(jq -cn --arg repository "githubnext/gh-aw-cao" --arg runId "$run_id" \
      --arg targetRepo "$target_repo" --arg targetSha "$target_sha" '
      [{repository: $repository, kind: "actions-run", ref: $runId},
       {repository: $targetRepo, kind: "commit", ref: $targetSha}]')
    diagnostics=$(printf '%s\n' "$case_json" | jq -c '
      {scanComplete, clean, exitCode, reportDigest}')
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
