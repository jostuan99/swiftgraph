#!/usr/bin/env bash
# Clones the reference repositories (eval/repos.txt), builds their graphs and
# runs the token benchmark (bench/proxy.ts). Fails when fewer questions are
# answered or the token ratio drops below the thresholds.
#
# Usage: eval/run-bench.sh [--min-correct N] [--min-ratio X]
# Clones go to eval/repos/ and graphs to eval/graphs/ (both ignored by git).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
repos="$root/eval/repos"
graphs="$root/eval/graphs"
mkdir -p "$repos" "$graphs"

while read -r url tag; do
  [[ -z "$url" || "$url" == \#* ]] && continue
  name="$(basename "$url" .git)"
  if [[ ! -d "$repos/$name" ]]; then
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$url" "$repos/$name"
  fi
  node "$root/src/cli.ts" build "$repos/$name" --db "$graphs/$name.db"
done < "$root/eval/repos.txt"

node "$root/bench/proxy.ts" "$graphs" "$repos" "$@"
