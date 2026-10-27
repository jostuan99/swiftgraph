#!/usr/bin/env bash
# Compares the call edges of swiftgraph with the compiler's index store on a
# reference repository (SG4, docs/01-design.md). macOS with Xcode only.
#
# Usage: eval/run-indexstore.sh [<repository name from eval/repos.txt>] [--min-precision P]
#
# Building the repository runs its build code (plugins, macros): only use it
# on trusted repositories, such as the ones in eval/repos.txt.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
name="swift-argument-parser"
if [[ $# -gt 0 && "$1" != --* ]]; then
  name="$1"
  shift
fi
repos="$root/eval/repos"
graphs="$root/eval/graphs"
mkdir -p "$repos" "$graphs"

read -r url tag < <(grep -v '^#' "$root/eval/repos.txt" | grep "/$name.git ")
if [[ ! -d "$repos/$name" ]]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$url" "$repos/$name"
fi

swift build -c release --package-path "$root/eval/indexstore-calls"
(cd "$repos/$name" && swift build --build-tests --enable-index-store)
store="$(find "$repos/$name/.build" -type d -name store -path '*index*' | head -1)"
library="$(dirname "$(xcrun --find swift)")/../lib/libIndexStore.dylib"

"$root/eval/indexstore-calls/.build/release/indexstore-calls" "$store" "$library" "$repos/$name" > "$graphs/$name.calls.tsv"
node "$root/src/cli.ts" build "$repos/$name" --db "$graphs/$name.db"
node "$root/eval/compare-calls.ts" "$graphs/$name.db" "$graphs/$name.calls.tsv" "$@"
