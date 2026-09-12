#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$repository_root"

gh extension upgrade github/gh-aw
gh aw update --major --cool-down 0
gh aw upgrade
