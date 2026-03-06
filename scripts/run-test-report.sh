#!/usr/bin/env bash
set -euo pipefail

STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "./results/test-runs"
OUT_DIR="$(mktemp -d "./results/test-runs/${STAMP}-XXXXXX")"

echo "Writing test artifacts to $OUT_DIR"
echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$OUT_DIR/meta.txt"
echo "command=node --test --test-reporter=tap $*" >>"$OUT_DIR/meta.txt"

set +e
node --test --test-reporter=tap "$@" 2>&1 | tee "$OUT_DIR/test-console.log"
STATUS=${PIPESTATUS[0]}
set -e

echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$OUT_DIR/meta.txt"
echo "exit_code=$STATUS" >>"$OUT_DIR/meta.txt"
exit "$STATUS"
