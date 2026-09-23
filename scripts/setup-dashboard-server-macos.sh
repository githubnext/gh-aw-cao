#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This setup command supports macOS only." >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Homebrew is required. Install it from https://brew.sh, then rerun:

  npm run dashboard:server:setup:macos
EOF
  exit 1
fi

brew_install_formula() {
  local formula=$1
  if brew list --formula "$formula" >/dev/null 2>&1; then
    echo "Homebrew formula already installed: $formula"
  else
    brew install "$formula"
  fi
}

brew_install_cask() {
  local cask=$1
  if brew list --cask "$cask" >/dev/null 2>&1; then
    echo "Homebrew cask already installed: $cask"
  else
    brew install --cask "$cask"
  fi
}

brew tap redis-stack/redis-stack
brew_install_formula go
brew_install_formula node@24
brew_install_cask redis-stack/redis-stack/redis-stack-server

node_prefix="$(brew --prefix node@24)"
export PATH="$node_prefix/bin:$PATH"

if ! command -v redis-stack-server >/dev/null 2>&1; then
  echo "redis-stack-server was installed but is not available on PATH." >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go was installed but is not available on PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 24 was installed but npm is not available on PATH." >&2
  exit 1
fi

npm --prefix dashboard/site ci

echo
echo "Installed dashboard server dependencies:"
echo "  $(go version)"
echo "  node $(node --version)"
echo "  npm $(npm --version)"
echo "  Redis Stack $(brew list --cask --versions redis-stack-server | awk '{print $2}')"

if ! GOTOOLCHAIN=auto go -C server env GOVERSION >/dev/null 2>&1; then
  cat >&2 <<'EOF'

Warning: the Go toolchain declared by server/go.mod is not available yet.
The dependencies are installed, but building the server requires that toolchain
or a temporary compatibility build.
EOF
fi

cat <<'EOF'

Setup complete. Start the local stack with:

  redis-stack-server --bind 127.0.0.1 --port 6379 --save '' --appendonly no
  npm run dashboard:server:build
  go -C server run ./cmd/cao-dashboard serve \
    --source testdata/deployed-subset
EOF
