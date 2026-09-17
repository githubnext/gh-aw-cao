#!/usr/bin/env bash
set -euo pipefail

: "${BUNDLE:?BUNDLE is required}"
: "${TARGET_REPO:?TARGET_REPO is required}"
: "${SAFE_OUTPUT_MODE:?SAFE_OUTPUT_MODE is required}"
: "${CONTROL_REF:?CONTROL_REF is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

SAFE_OUTPUT_REPO=${SAFE_OUTPUT_REPO:-}
REQUIRE_OUTPUT=${REQUIRE_OUTPUT:-false}
CONFIRMATION=${CONFIRMATION:-}

repository_equal() {
  [[ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" ]]
}

case "$BUNDLE" in
  uk-ai-advisory)
    workflow_file=uk-ai-advisory.lock.yml
    worker_files=(uk-ai-advisory-operational-resilience.lock.yml)
    ;;
  dependabot)
    workflow_file=dependabot.lock.yml
    worker_files=(dependabot-update-planner.lock.yml)
    ;;
  eu-cra-compliance)
    workflow_file=eu-cra-compliance.lock.yml
    worker_files=(
      eu-cra-compliance-scope-classifier.lock.yml
      eu-cra-compliance-security-requirements-auditor.lock.yml
      eu-cra-compliance-supply-chain-sbom-auditor.lock.yml
      eu-cra-compliance-vulnerability-handling-auditor.lock.yml
      eu-cra-compliance-article-14-reporting-readiness.lock.yml
      eu-cra-compliance-conformity-release-evidence.lock.yml
    )
    ;;
  optimization)
    workflow_file=optimization.lock.yml
    worker_files=(optimization-ai-credit-auditor.lock.yml optimization-ai-credit-optimizer.lock.yml optimization-token-optimizer.lock.yml)
    ;;
  *) printf 'Unsupported package: %s\n' "$BUNDLE" >&2; exit 1 ;;
esac

[[ "$TARGET_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] \
  || { printf 'target_repo must use OWNER/REPO form\n' >&2; exit 1; }

case "$SAFE_OUTPUT_MODE" in
  review)
    [[ "$SAFE_OUTPUT_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] \
      || { printf 'review mode requires safe_output_repo in OWNER/REPO form\n' >&2; exit 1; }
    [[ "$SAFE_OUTPUT_REPO" != "$TARGET_REPO" ]] \
      || { printf 'review and target repositories must differ\n' >&2; exit 1; }
    [[ "$CONFIRMATION" == "REVIEW $SAFE_OUTPUT_REPO" ]] \
      || { printf 'confirmation must be REVIEW %s\n' "$SAFE_OUTPUT_REPO" >&2; exit 1; }
    is_private=$(gh api "repos/$SAFE_OUTPUT_REPO" --jq '.private')
    [[ "$is_private" == true ]] || repository_equal "$SAFE_OUTPUT_REPO" "$GITHUB_REPOSITORY" \
      || { printf 'non-central review repository must be private\n' >&2; exit 1; }
    ;;
  live)
    [[ -z "$SAFE_OUTPUT_REPO" ]] || { printf 'live mode derives its output repository from target_repo\n' >&2; exit 1; }
    [[ "$CONFIRMATION" == "LIVE $TARGET_REPO" ]] \
      || { printf 'confirmation must be LIVE %s\n' "$TARGET_REPO" >&2; exit 1; }
    ;;
  *) printf 'safe_output_mode must be review or live\n' >&2; exit 1 ;;
esac

case "$REQUIRE_OUTPUT" in
  true|false) ;;
  *) printf 'require_output must be true or false\n' >&2; exit 1 ;;
esac

snapshot_repository() {
  local repository=$1
  {
    gh api "repos/$repository" --jq '[.id, .default_branch] | @tsv'
    gh api --paginate "repos/$repository/issues?state=all&per_page=100" \
      --jq '.[] | [.id, .updated_at, .state] | @tsv'
    gh api --paginate "repos/$repository/git/matching-refs/heads/" \
      --jq '.[] | [.ref, .object.sha] | @tsv'
  } | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1
}

target_before=$(snapshot_repository "$TARGET_REPO")
review_before=
if [[ "$SAFE_OUTPUT_MODE" == review ]]; then
  review_before=$(snapshot_repository "$SAFE_OUTPUT_REPO")
fi

started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
gh workflow run "$workflow_file" \
  --ref "$CONTROL_REF" \
  --raw-field "target_repo=$TARGET_REPO" \
  --raw-field "safe_output_repo=$SAFE_OUTPUT_REPO" \
  --raw-field "max_repos=1" \
  --raw-field "rollout_percent=100" \
  --raw-field "safe_output_mode=$SAFE_OUTPUT_MODE"

run_id=
for _ in $(seq 1 30); do
  run_id=$(gh run list \
    --workflow "$workflow_file" \
    --branch "$CONTROL_REF" \
    --commit "$GITHUB_SHA" \
    --event workflow_dispatch \
    --created ">=$started_at" \
    --limit 20 \
    --json databaseId \
    --jq 'sort_by(.databaseId) | last | .databaseId // empty')
  [[ -z "$run_id" ]] || break
  sleep 10
done

[[ -n "$run_id" ]] || { printf 'Timed out locating canary orchestrator run\n' >&2; exit 1; }
printf 'Monitoring orchestrator %s/actions/runs/%s\n' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" "$run_id"
gh run watch "$run_id" --exit-status

worker_ids_file=$(mktemp)
trap 'rm -f "$worker_ids_file"' EXIT
for _ in $(seq 1 12); do
  : > "$worker_ids_file"
  for worker_file in "${worker_files[@]}"; do
    gh run list \
      --workflow "$worker_file" \
      --branch "$CONTROL_REF" \
      --event workflow_dispatch \
      --created ">=$started_at" \
      --limit 100 \
      --json databaseId,displayTitle \
      --jq ".[] | select(.displayTitle | contains(\"$TARGET_REPO\")) | .databaseId" \
      >> "$worker_ids_file"
  done
  sort -u -o "$worker_ids_file" "$worker_ids_file"
  [[ -s "$worker_ids_file" ]] && break
  sleep 10
done

[[ -s "$worker_ids_file" ]] || { printf 'No correlated worker run was found\n' >&2; exit 1; }
while IFS= read -r worker_id; do
  printf 'Monitoring worker %s/actions/runs/%s\n' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" "$worker_id"
  gh run watch "$worker_id" --exit-status
done < "$worker_ids_file"

target_after=$(snapshot_repository "$TARGET_REPO")
case "$SAFE_OUTPUT_MODE" in
  review)
    [[ "$target_after" == "$target_before" ]] \
      || { printf 'review canary mutated target repository state\n' >&2; exit 1; }
    review_after=$(snapshot_repository "$SAFE_OUTPUT_REPO")
    if [[ "$REQUIRE_OUTPUT" == true && "$review_after" == "$review_before" ]]; then
      printf 'review canary required an output but review repository state did not change\n' >&2
      exit 1
    fi
    ;;
  live)
    if [[ "$REQUIRE_OUTPUT" == true && "$target_after" == "$target_before" ]]; then
      printf 'live canary required an output but target repository state did not change\n' >&2
      exit 1
    fi
    ;;
esac

{
  printf '## Enterprise canary\n'
  printf -- '- Mode: `%s`\n' "$SAFE_OUTPUT_MODE"
  printf -- '- Package: `%s`\n' "$BUNDLE"
  printf -- '- Target: `%s`\n' "$TARGET_REPO"
  printf -- '- Review destination: `%s`\n' "${SAFE_OUTPUT_REPO:-not applicable}"
  printf -- '- Worker runs: `%s`\n' "$(paste -sd, "$worker_ids_file")"
  printf -- '- Required repository mutation: `%s`\n' "$REQUIRE_OUTPUT"
} >> "$GITHUB_STEP_SUMMARY"