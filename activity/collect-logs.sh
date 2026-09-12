#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
root="${REPORT_ROOT:-.}"
logs_path="${REPORT_GH_AW_LOGS:-_activity/gh-aw-logs.jsonl}"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
exit_code_path="${REPORT_GH_AW_LOGS_EXIT_CODE:-_activity/gh-aw-logs-exit-code}"
stderr_path="${REPORT_GH_AW_LOGS_STDERR:-_activity/gh-aw-logs-stderr.log}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-10}"

mkdir -p "$output_directory" "$(dirname "$logs_path")" "$(dirname "$exit_code_path")" "$(dirname "$stderr_path")"

targets=()
for workflow_path in "$root"/.github/workflows/*.lock.yml; do
  [[ -f "$workflow_path" ]] || continue
  workflow_file="${workflow_path##*/}"
  targets+=("$repository/.github/workflows/$workflow_file")
done

set +e
# $! reliably holds the PID of the process-substitution subshell started by
# `exec {fd}> >(...)` because bash launches it as a background job before this
# statement returns, and no other background job is started in between.
exec {gh_stderr_fd}> >(tee "$stderr_path" >&2)
tee_pid=$!
gh aw logs --audit \
  --output "$output_directory" \
  --summary-file "" \
  --cached-jsonl "$logs_path" \
  --artifacts usage \
  --start-date "-${window_days}d" \
  --cache-before "-${window_days}d" \
  --count "$run_limit" \
  --timeout 10 \
  --max-github-api-rate-limit -2000 \
  --max-storage 1200 \
  --prune-older-runs \
  "${targets[@]}" \
  2>&"$gh_stderr_fd"
exit_code=$?
exec {gh_stderr_fd}>&-
wait "$tee_pid" 2>/dev/null
set -e

printf '%s\n' "$exit_code" > "$exit_code_path"
