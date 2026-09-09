#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
root="${REPORT_ROOT:-.}"
logs_path="${REPORT_GH_AW_LOGS:-_activity/gh-aw-logs.json}"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
exit_code_path="${REPORT_GH_AW_LOGS_EXIT_CODE:-_activity/gh-aw-logs-exit-code}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-2000}"

mkdir -p "$output_directory" "$(dirname "$logs_path")" "$(dirname "$exit_code_path")"

mapfile -t targets < <(
  find "$root/.github/workflows" -maxdepth 1 -type f -name '*.lock.yml' -printf '%f\n' |
    sort |
    sed "s#^#$repository/.github/workflows/#"
)

set +e
gh aw logs --audit \
  --output "$output_directory" \
  --summary-file "" \
  --cached-json "$logs_path" \
  --artifacts usage,detection,evals,experiment,firewall,github-api,graders,mcp,agent \
  --start-date "-${window_days}d" \
  --cache-before "-${window_days}d" \
  --count "$run_limit" \
  --timeout 15 \
  --max-github-api-rate-limit -2000 \
  --max-storage 1200 \
  --prune-older-runs \
  "${targets[@]}"
exit_code=$?
set -e

printf '%s\n' "$exit_code" > "$exit_code_path"
