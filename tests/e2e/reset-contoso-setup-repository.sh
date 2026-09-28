#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
readonly repository_root
cd "$repository_root"

for path in ./* ./.github/*; do
  [[ -e "$path" ]] || continue
  case "$path" in
    ./README.md|./reset.sh|./setup-auth.sh|./.github/workflows)
      ;;
    *)
      rm -rf -- "$path"
      ;;
  esac
done

if [[ -d .github/workflows ]]; then
  find .github/workflows -mindepth 1 -maxdepth 1 -type f \
    ! -name 'auth-e2e.yml' \
    ! -name 'setup-walkthrough.yml' \
    -delete
fi

printf 'Reset %s to its setup E2E harness.\n' "$(git remote get-url origin)"
