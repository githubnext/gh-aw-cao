#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
root="${REPORT_ROOT:-.}"
logs_path="${REPORT_GH_AW_LOGS:-_activity/gh-aw-logs.jsonl}"
shard_directory="$(dirname "$logs_path")/gh-aw-logs-shards"
shard_prefix="$shard_directory/logs-"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
exit_code_path="${REPORT_GH_AW_LOGS_EXIT_CODE:-_activity/gh-aw-logs-exit-code}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-10}"

mkdir -p "$output_directory" "$shard_directory" "$(dirname "$logs_path")" "$(dirname "$exit_code_path")"

# Seed the wildcard shard cache with the previously consolidated snapshot so
# the `--cached-logs` invocation below can reuse it without rediscovering
# known runs.
if [[ -s "$logs_path" ]]; then
  cp "$logs_path" "${shard_prefix}0.jsonl"
fi

targets=()
for workflow_path in "$root"/.github/workflows/*.lock.yml; do
  [[ -f "$workflow_path" ]] || continue
  workflow_file="${workflow_path##*/}"
  targets+=("$repository/.github/workflows/$workflow_file")
done

set +e
gh aw logs --audit \
  --output "$output_directory" \
  --summary-file "" \
  --cached-logs "${shard_prefix}*" \
  --artifacts usage \
  --start-date "-${window_days}d" \
  --cache-before "-${window_days}d" \
  --count "$run_limit" \
  --timeout 10 \
  --max-github-api-rate-limit -2000 \
  --max-storage 1200 \
  --prune-older-runs \
  "${targets[@]}"
exit_code=$?
set -e

printf '%s\n' "$exit_code" > "$exit_code_path"

# Consolidate the wildcard shards back into the single-file snapshot contract
# that downstream consumers (activity/logs.mjs and its cached-run fallback)
# expect, then discard the transient shard directory.
shopt -s nullglob
shards=("${shard_prefix}"*.jsonl)
shopt -u nullglob
if [[ ${#shards[@]} -gt 0 ]]; then
  cat "${shards[@]}" > "$logs_path"
fi
rm -rf "$shard_directory"
