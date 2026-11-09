#!/usr/bin/env bash
# Merge pingdotgg/t3code into this fork and report; never auto-resolves conflicts (check F2).
set -uo pipefail
export LC_ALL=C
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
report="${GARISEK_SYNC_REPORT:-/tmp/garisek-sync-$(date -u +%Y%m%dT%H%M%SZ).log}"
exec > >(tee "$report") 2>&1
toolchain=(mise exec node@26.12.1 pnpm@12.14.0 --)

echo "sync-upstream $(date -Is) in $root"
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree is dirty; commit or stash first"
  exit 2
fi
git fetch -q upstream || { echo "FAIL: fetch upstream"; exit 2; }
before=$(git rev-parse HEAD)
echo "HEAD $before; upstream/main $(git rev-parse upstream/main)"
if ! git merge --no-edit upstream/main; then
  echo "CONFLICTS (left unresolved for a human):"
  git diff --name-only --diff-filter=U
  exit 3
fi
echo "merged to $(git rev-parse HEAD)"

undocumented=$(comm -23 \
  <(git diff --name-only upstream/main HEAD | grep -v '^docs/garisek/receipts/' | sort) \
  <(grep -oE '`[^`]+`' docs/garisek/DELTA.md | tr -d '`' | sort -u))
if [ -n "$undocumented" ]; then
  echo "FAIL: changed vs upstream but missing from docs/garisek/DELTA.md:"
  echo "$undocumented"
  status=4
fi

"${toolchain[@]}" pnpm i --frozen-lockfile >/dev/null || { echo "FAIL: pnpm i"; exit 5; }
"${toolchain[@]}" pnpm typecheck >/tmp/garisek-sync-typecheck.log 2>&1
echo "typecheck exit $? (log /tmp/garisek-sync-typecheck.log)"
"${toolchain[@]}" scripts/garisek/test-all.sh /tmp/garisek-sync-tests.jsonl >/dev/null
echo "tests exit $? (per package: /tmp/garisek-sync-tests.jsonl)"
node scripts/garisek/omp-rpc-probe.mjs --no-model >/tmp/garisek-sync-probe.log 2>&1
echo "omp probe exit $? (log /tmp/garisek-sync-probe.log)"
echo "report $report"
exit "${status:-0}"
