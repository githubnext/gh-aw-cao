#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
shard_directory="${REPORT_GH_AW_LOGS_SHARDS:-_activity/gh-aw-logs-shards}"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-10}"

mkdir -p "$output_directory" "$shard_directory"

exit_code=0
observation_shard="$shard_directory/token-efficiency-observations.jsonl"
observation_tmp="$observation_shard.tmp"
: > "$observation_tmp"
observation_complete=false
set +e
gh api "repos/$repository/actions/artifacts?name=token-efficiency-observation&per_page=$run_limit" \
  --jq '.artifacts[]
    | select(.expired == false and .name == "token-efficiency-observation")
    | select((now - (.created_at | fromdateiso8601)) <= ('"$window_days"' * 86400))
    | [.id, .workflow_run.id, .archive_download_url, .created_at]
    | @tsv' \
  | while IFS=$'\t' read -r artifact_id workflow_run_id archive_url created_at; do
      [[ -n "$artifact_id" && -n "$workflow_run_id" && -n "$archive_url" ]] || continue
      if ! workflow_path="$(gh api "repos/$repository/actions/runs/$workflow_run_id" --jq '.path')"; then
        exit 1
      fi
      [[ "$workflow_path" == ".github/workflows/optimization-token-optimizer.lock.yml" ]] || continue
      archive="$output_directory/token-efficiency-observation-$artifact_id.zip"
      extracted="$output_directory/token-efficiency-observation-$artifact_id"
      if ! gh api "$archive_url" > "$archive"; then
        exit 1
      fi
      mkdir -p "$extracted"
      if ! unzip -qq -o "$archive" -d "$extracted"; then
        exit 1
      fi
      file="$extracted/token-efficiency-observation.json"
      if jq -e --arg run "$workflow_run_id" --arg repository "$repository" '
          .schemaVersion == 1
          and .optimizerRunId == $run
          and .controlRepository == $repository
          and (.targetRepo | type == "string")
          and (.workflowPath | type == "string")
          and .evidenceState == "complete"
          and .costGrain == "invocation"
        ' "$file" >/dev/null 2>&1; then
        jq -c --arg createdAt "$created_at" \
          '{schema_version: 2, kind: "token_efficiency_observation", created_at: $createdAt, observation: .}' \
          "$file" >> "$observation_tmp"
      else
        exit 1
      fi
    done
observation_status=("${PIPESTATUS[@]}")
set -e
if [[ ${observation_status[0]} -eq 0 && ${observation_status[1]} -eq 0 ]]; then
  observation_complete=true
else
  exit_code=1
fi
if [[ "$observation_complete" == true ]]; then
  mv "$observation_tmp" "$observation_shard"
else
  rm -f "$observation_tmp"
fi

lifecycle_shard="$shard_directory/token-efficiency-lifecycle-observations.jsonl"
lifecycle_tmp="$lifecycle_shard.tmp"
if [[ -f "$lifecycle_shard" ]]; then
  cp "$lifecycle_shard" "$lifecycle_tmp"
else
  : > "$lifecycle_tmp"
fi
lifecycle_complete=false
if [[ $exit_code -eq 0 ]]; then
  if [[ -f activity/token-intervention-lifecycle.mjs ]]; then
    lifecycle_script=activity/token-intervention-lifecycle.mjs
  elif [[ -f activity/token-intervention-lifecycle.mjs ]]; then
    lifecycle_script=activity/token-intervention-lifecycle.mjs
  else
    lifecycle_script=
  fi
  if [[ -z "$lifecycle_script" ]]; then
    exit_code=1
  else
    set +e
    gh api --paginate "repos/$repository/actions/artifacts?name=token-efficiency-lifecycle-claim&per_page=100" \
      --jq '.artifacts[]
        | select(.expired == false and .name == "token-efficiency-lifecycle-claim")
        | select((now - (.created_at | fromdateiso8601)) <= ('"$window_days"' * 86400))
        | [.id, .workflow_run.id, .archive_download_url, .created_at]
        | @tsv' \
      | sort -t $'\t' -k4,4 \
      | while IFS=$'\t' read -r artifact_id workflow_run_id archive_url created_at; do
          [[ -n "$artifact_id" && -n "$workflow_run_id" && -n "$archive_url" ]] || continue
          if ! workflow_path="$(gh api "repos/$repository/actions/runs/$workflow_run_id" --jq '.path')"; then
            exit 1
          fi
          [[ "$workflow_path" == ".github/workflows/optimization-token-intervention-tracker.yml" ]] || continue
          archive="$output_directory/token-efficiency-lifecycle-claim-$artifact_id.zip"
          extracted="$output_directory/token-efficiency-lifecycle-claim-$artifact_id"
          if ! gh api "$archive_url" > "$archive"; then
            exit 1
          fi
          mkdir -p "$extracted"
          if ! unzip -qq -o "$archive" -d "$extracted"; then
            exit 1
          fi
          claim="$extracted/token-efficiency-lifecycle-claim.json"
          if ! jq -e --arg run "$workflow_run_id" --arg repository "$repository" '
              .schemaVersion == 1
              and .claimRunId == $run
              and .controlRepository == $repository
            ' "$claim" >/dev/null 2>&1; then
            exit 1
          fi
          if ! node "$lifecycle_script" \
              --claim "$claim" \
              --shard-dir "$shard_directory" \
              --history-file "$lifecycle_tmp" >> "$lifecycle_tmp"; then
            exit 1
          fi
        done
    lifecycle_status=("${PIPESTATUS[@]}")
    set -e
    if [[ ${lifecycle_status[0]} -eq 0 && ${lifecycle_status[1]} -eq 0 && ${lifecycle_status[2]} -eq 0 ]]; then
      lifecycle_complete=true
    else
      exit_code=1
    fi
  fi
fi
if [[ "$lifecycle_complete" == true ]]; then
  mv "$lifecycle_tmp" "$lifecycle_shard"
else
  rm -f "$lifecycle_tmp"
fi

exit "$exit_code"
