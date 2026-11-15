#!/usr/bin/env bash
# `vp run -r test` stops at the first failing package; this runs every package's tests
# and writes one JSON line per package so a run can be diffed against the baseline.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:-/tmp/garisek-test-all-$(date -u +%Y%m%dT%H%M%SZ).jsonl}"
logdir="${out%.jsonl}.logs"
mkdir -p "$logdir"
: >"$out"
cd "$root"
pkgs=$(pnpm -r --json ls --depth -1 | node -e '
  const fs = require("node:fs");
  for (const p of JSON.parse(fs.readFileSync(0, "utf8"))) {
    const pj = JSON.parse(fs.readFileSync(p.path + "/package.json", "utf8"));
    if (pj.scripts?.test && p.path !== process.cwd()) console.log(p.name);
  }')
fail=0
for pkg in $pkgs; do
  log="$logdir/${pkg//\//_}.log"
  start=$(date +%s)
  pnpm exec vp run --filter "$pkg" test >"$log" 2>&1
  code=$?
  tests=$(grep -E '^\s+Tests\s' "$log" | tail -1 | sed -E 's/^\s+Tests\s+//')
  failed=$(grep -E '^ FAIL ' "$log" | sed -E 's/^ FAIL //' | sort -u | node -e 'console.log(JSON.stringify(require("node:fs").readFileSync(0,"utf8").split("\n").filter(Boolean)))')
  printf '{"package":"%s","exit":%d,"seconds":%d,"tests":"%s","failed":%s}\n' \
    "$pkg" "$code" "$(( $(date +%s) - start ))" "$tests" "$failed" >>"$out"
  [ "$code" -eq 0 ] || fail=1
done
echo "$out"
exit $fail
