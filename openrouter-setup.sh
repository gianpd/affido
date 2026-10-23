#!/usr/bin/env bash
# Thin wrapper kept for muscle memory: the provider setup lives in ./dev.sh.
#
# The manager forwards no *_MODEL to `docker create`, so the openrouter provider
# needs a derived image with `ENV OPENROUTER_MODEL` plus secrets/ mounted at
# /run/secrets. `./dev.sh up --provider openrouter` does exactly that.
#
# Usage: ./openrouter-setup.sh [--no-up]
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
	"") exec ./dev.sh up --provider openrouter ;;
	--no-up) exec ./dev.sh build --provider openrouter ;;
	*) echo "usage: $0 [--no-up]" >&2; exit 1 ;;
esac
