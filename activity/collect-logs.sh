#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
shard_directory="${REPORT_GH_AW_LOGS_SHARDS:-_activity/gh-aw-logs-shards}"
control_settings_path="${REPORT_CONTROL_SETTINGS:-}"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
exit_code_path="${REPORT_GH_AW_LOGS_EXIT_CODE:-_activity/gh-aw-logs-exit-code}"
drain3_weights_path="${REPORT_DRAIN3_WEIGHTS:-}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-10}"
request_timeout="${REPORT_LOG_TIMEOUT:-10}"
rate_limit="${REPORT_MAX_GITHUB_API_RATE_LIMIT:--2000}"
max_storage="${REPORT_MAX_STORAGE:-1200}"

mkdir -p "$output_directory" "$shard_directory" "$(dirname "$exit_code_path")"

repositories=()
shard_groups=()
add_repository() {
  local candidate="$1"
  local normalized_candidate
  [[ "$candidate" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || return
  normalized_candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
  for existing in "${repositories[@]:-}"; do
    [[ -n "$existing" ]] || continue
    [[ "$(printf '%s' "$existing" | tr '[:upper:]' '[:lower:]')" == "$normalized_candidate" ]] && return
  done
  repositories+=("$candidate")
}

if [[ -n "$control_settings_path" && -f "$control_settings_path" ]]; then
  while IFS= read -r allowed_repository; do
    add_repository "$allowed_repository"
  done < <(jq -r '.allowed_repositories[]?' "$control_settings_path")
fi
add_repository "$repository"

exit_code=0
drain3_args=()
if [[ -n "$drain3_weights_path" && -f "$drain3_weights_path" ]]; then
  drain3_args+=(--drain3-weights "$drain3_weights_path")
fi
for target_repository in "${repositories[@]}"; do
  cache_name="${target_repository//\//-}"
  if [[ "$(printf '%s' "$target_repository" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')" ]]; then
    shard_prefix="$shard_directory/logs-"
  else
    shard_prefix="$shard_directory/${cache_name}-logs-"
  fi
  shard_groups+=("$target_repository=$(basename "$shard_prefix")")
  set +e
  gh aw logs --audit \
    --repo "$target_repository" \
    --output "$output_directory/$cache_name" \
    --summary-file "" \
    --cached-jsonl "${shard_prefix}*" \
    --artifacts usage \
    --start-date "-${window_days}d" \
    --cache-before "-${window_days}d" \
    --count "$run_limit" \
    --timeout "$request_timeout" \
    --max-github-api-rate-limit "$rate_limit" \
    --max-storage "$max_storage" \
    --prune-older-runs \
    "${drain3_args[@]+"${drain3_args[@]}"}"
  repository_exit_code=$?
  set -e
  generated_weights="$output_directory/$cache_name/drain3_weights.json"
  if [[ -n "$drain3_weights_path" && -f "$generated_weights" ]]; then
    mv "$generated_weights" "$drain3_weights_path"
    drain3_args=(--drain3-weights "$drain3_weights_path")
  fi
  if [[ $repository_exit_code -ne 0 ]]; then
    exit_code=$repository_exit_code
  fi
done

if [[ $exit_code -eq 0 ]]; then
  if [[ -f activity/cao.mjs ]]; then
    cao_script=activity/cao.mjs
  elif [[ -f .github/aw/activity/cao.mjs ]]; then
    cao_script=.github/aw/activity/cao.mjs
  else
    echo "CAO activity CLI is unavailable" >&2
    exit_code=1
  fi
  if [[ $exit_code -eq 0 ]]; then
    compact_args=(compact-jsonl --input-dir "$shard_directory")
    for shard_group in "${shard_groups[@]}"; do
      compact_args+=(--group "$shard_group")
    done
    node "$cao_script" "${compact_args[@]}" || exit_code=$?
  fi
fi

printf '%s\n' "$exit_code" > "$exit_code_path"

# The shard directory is persisted by the caller so each repository reuses
# known runs. Successful collections consolidate each repository's files into
# one shard; out-of-range records are pruned by `--cache-before`.
