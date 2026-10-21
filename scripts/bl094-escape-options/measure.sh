#!/usr/bin/env bash
# BL-094: measure each option prototype against the base, the way the
# numbers in ADR 0008's "Proposed decision -- BL-094" were taken.
#
# Usage (from the repository root):
#   bash scripts/bl094-escape-options/measure.sh <scratch-dir> [options...]
#
# Options default to every `*.patch` of this directory. For the base and
# each option it creates a detached worktree of the base commit under
# <scratch-dir>, COPIES node_modules into it (a symlink makes
# tests/validation/hermeticity.test.ts fail spuriously), applies the
# option's patch and builds `dist`. Then, per option, one after another
# (never concurrently: the oracle suite and the corpus walks compete for
# CPU):
#
#   1. the real-Node oracle suite, as a vitest JSON report
#      (<scratch-dir>/results/oracle-<option>.json; the base's too);
#   2. the graph, proof and verdict differentials over the 139 corpus
#      cases (`scripts/differential.mjs --base <base>`);
#   3. the clean-node precision of `scripts/bl081-builtin-store-escape-corpus.mjs`
#      over the base worktree's `node_modules`, JavaScript and TypeScript
#      (about an hour for JavaScript on four cores; two minutes for
#      TypeScript).
#
# An option whose cuts beyond another's are reachable only from
# TypeScript syntax has the same JavaScript corpus result as that other
# option by construction (O2b = O2a, O2e = O2a0); BL-094 did not run
# those two JavaScript walks to completion.
set -euo pipefail
REPO=$(pwd)
SCRATCH=${1:?usage: measure.sh <scratch-dir> [options...]}
shift
BASE=842e808b91f2c1bbfcc2688b0dd233c4c45974ae
HERE="$REPO/scripts/bl094-escape-options"
if [ $# -eq 0 ]; then
  set -- $(cd "$HERE" && ls *.patch | sed 's/\.patch$//')
fi
mkdir -p "$SCRATCH/results"

prepare() {
  local v=$1 dir="$SCRATCH/v-$1"
  if [ ! -d "$dir" ]; then
    git -C "$REPO" worktree add --detach "$dir" "$BASE" >/dev/null
    cp -a "$REPO/node_modules" "$dir/node_modules"
  fi
  git -C "$dir" checkout -q -- src
  if [ "$v" != base ]; then
    git -C "$dir" apply "$HERE/$v.patch"
  fi
  (cd "$dir" && npx tsc -p tsconfig.build.json)
}

prepare base
(cd "$SCRATCH/v-base" && npx vitest run --config vitest.oracle.config.ts \
  --reporter=json --outputFile="$SCRATCH/results/oracle-base.json" >/dev/null 2>&1) || true
for v in "$@"; do
  prepare "$v"
  dir="$SCRATCH/v-$v"
  (cd "$dir" && npx vitest run --config vitest.oracle.config.ts \
    --reporter=json --outputFile="$SCRATCH/results/oracle-$v.json" >/dev/null 2>&1) || true
  (cd "$dir" && node scripts/differential.mjs --base "$BASE" \
    --out "$SCRATCH/results/diff-$v" >"$SCRATCH/results/diff-$v.log" 2>&1)
  for mode in js ts; do
    flag=""
    [ "$mode" = ts ] && flag="--typescript"
    (cd "$SCRATCH/v-base" && node scripts/bl081-builtin-store-escape-corpus.mjs \
      --base-dist "$SCRATCH/v-base/dist" --head-dist "$dir/dist" --list $flag \
      >"$SCRATCH/results/corpus-$mode-$v.txt" 2>&1)
  done
  echo "measured $v"
done
