#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

# Emits the current quantity of open Dependabot-labelled issues in each
# requested repository. Pull requests are excluded from the count.

request=$(cat)
jq -e '
  .schemaVersion == 1
  and (.timestamp | type) == "string"
  and (.repositories | type) == "array"
  and all(.repositories[]; type == "string" and test("^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$"))
' >/dev/null <<<"$request"

timestamp=$(jq -r '.timestamp' <<<"$request")
minimum_remaining=${CAO_GITHUB_API_MIN_REMAINING:-0}
[[ $minimum_remaining =~ ^[0-9]+$ ]] || {
  printf 'CAO_GITHUB_API_MIN_REMAINING must be a non-negative integer\n' >&2
  exit 2
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/cao-dependabot-value.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
output="$tmp_dir/values.jsonl"
: >"$output"

while IFS= read -r repository; do
  if (( minimum_remaining > 0 )); then
    remaining=$(gh api rate_limit --jq '.resources.core.remaining')
    [[ $remaining =~ ^[0-9]+$ ]] || {
      printf 'GitHub API returned an invalid core rate limit\n' >&2
      exit 1
    }
    if (( remaining <= minimum_remaining )); then
      printf 'GitHub API core remaining is at or below the reserved %s requests\n' "$minimum_remaining" >&2
      exit 1
    fi
  fi

  count=$(
    gh api --method GET "repos/$repository/issues" \
      -f state=open \
      -f labels=dependabot \
      -f per_page=100 \
      --paginate \
      --slurp |
      jq '[.[][] | select(has("pull_request") | not)] | length'
  )
  jq -cn \
    --arg timestamp "$timestamp" \
    --arg repository "$repository" \
    --argjson value "$count" \
    '{timestamp:$timestamp,repository:$repository,valueId:"dependabot-issues",value:$value}' \
    >>"$output"
done < <(jq -r '.repositories[]' <<<"$request")

cat "$output"
