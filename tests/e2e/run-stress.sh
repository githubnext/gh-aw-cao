#!/usr/bin/env bash
set -euo pipefail

: "${BUNDLE:?BUNDLE is required}"
: "${TARGET_REPO:?TARGET_REPO is required}"
: "${SAFE_OUTPUT_REPO:?SAFE_OUTPUT_REPO is required}"
: "${CONTROL_REF:?CONTROL_REF is required}"
: "${RUNS:?RUNS is required}"
: "${CONFIRMATION:?CONFIRMATION is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

repository_equal() {
  [[ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" ]]
}

case "$BUNDLE" in
  uk-ai-advisory) workflow_file=uk-ai-advisory.lock.yml ;;
  dependabot) workflow_file=dependabot.lock.yml ;;
  eu-cra-compliance) workflow_file=eu-cra-compliance.lock.yml ;;
  optimization) workflow_file=optimization.lock.yml ;;
  *) printf 'Unsupported campaign: %s\n' "$BUNDLE" >&2; exit 1 ;;
esac
case "$RUNS" in
  2|3|5) ;;
  *) printf 'runs must be 2, 3, or 5\n' >&2; exit 1 ;;
esac
[[ "$TARGET_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] \
  || { printf 'target_repo must use OWNER/REPO form\n' >&2; exit 1; }
[[ "$SAFE_OUTPUT_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] \
  || { printf 'safe_output_repo must use OWNER/REPO form\n' >&2; exit 1; }
[[ "$SAFE_OUTPUT_REPO" != "$TARGET_REPO" ]] \
  || { printf 'review and target repositories must differ\n' >&2; exit 1; }
[[ "$CONFIRMATION" == "STRESS $TARGET_REPO REVIEW $SAFE_OUTPUT_REPO $RUNS" ]] \
  || { printf 'confirmation must be STRESS %s REVIEW %s %s\n' "$TARGET_REPO" "$SAFE_OUTPUT_REPO" "$RUNS" >&2; exit 1; }
is_private=$(gh api "repos/$SAFE_OUTPUT_REPO" --jq '.private')
[[ "$is_private" == true ]] || repository_equal "$SAFE_OUTPUT_REPO" "$GITHUB_REPOSITORY" \
  || { printf 'non-central review repository must be private\n' >&2; exit 1; }

snapshot_repository() {
  local repository=$1
  {
    gh api --paginate "repos/$repository/issues?state=all&per_page=100" --jq '.[] | [.id, .updated_at, .state] | @tsv'
    gh api --paginate "repos/$repository/git/matching-refs/heads/" --jq '.[] | [.ref, .object.sha] | @tsv'
  } | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1
}

target_before=$(snapshot_repository "$TARGET_REPO")
started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
for _ in $(seq 1 "$RUNS"); do
  gh workflow run "$workflow_file" \
    --ref "$CONTROL_REF" \
    --raw-field "target_repo=$TARGET_REPO" \
    --raw-field "safe_output_repo=$SAFE_OUTPUT_REPO" \
    --raw-field "max_repos=1" \
    --raw-field "rollout_percent=100" \
    --raw-field "safe_output_mode=review"
done

run_ids_file=$(mktemp)
trap 'rm -f "$run_ids_file"' EXIT
for _ in $(seq 1 30); do
  gh run list \
    --workflow "$workflow_file" \
    --branch "$CONTROL_REF" \
    --event workflow_dispatch \
    --created ">=$started_at" \
    --limit 20 \
    --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle | contains(\"$TARGET_REPO\")) | .databaseId" \
    | sort -u > "$run_ids_file"
  [[ $(wc -l < "$run_ids_file" | tr -d ' ') -ge "$RUNS" ]] && break
  sleep 10
done

[[ $(wc -l < "$run_ids_file" | tr -d ' ') -eq "$RUNS" ]] \
  || { printf 'Could not locate all stress runs\n' >&2; exit 1; }

cancelled=0
while IFS= read -r run_id; do
  gh run watch "$run_id" --exit-status || true
  conclusion=$(gh run view "$run_id" --json conclusion --jq '.conclusion')
  case "$conclusion" in
    success) ;;
    cancelled) cancelled=$((cancelled + 1)) ;;
    *) printf 'Stress run %s concluded %s\n' "$run_id" "$conclusion" >&2; exit 1 ;;
  esac
done < "$run_ids_file"

[[ "$cancelled" -ge $((RUNS - 1)) ]] \
  || { printf 'Expected at least %s superseded runs, observed %s\n' "$((RUNS - 1))" "$cancelled" >&2; exit 1; }
[[ $(snapshot_repository "$TARGET_REPO") == "$target_before" ]] \
  || { printf 'review stress run mutated target repository state\n' >&2; exit 1; }

{
  printf '## Enterprise stress canary\n'
  printf -- '- Campaign: `%s`\n' "$BUNDLE"
  printf -- '- Target: `%s`\n' "$TARGET_REPO"
  printf -- '- Review destination: `%s`\n' "$SAFE_OUTPUT_REPO"
  printf -- '- Requested runs: `%s`\n' "$RUNS"
  printf -- '- Superseded runs: `%s`\n' "$cancelled"
} >> "$GITHUB_STEP_SUMMARY"