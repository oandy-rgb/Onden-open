#!/usr/bin/env bash
# verify.sh : prove that public main is private main minus what we do not publish, and nothing else.
# Run in a worktree of the private repo that has the `open` remote. Changes nothing anywhere.
set -euo pipefail
# With an argument: the private commit the public main is expected to be made from (the mirror workflow passes its own).
want=${1:-}
here=$(dirname "$0")
git fetch -q open main
[ -n "$want" ] || git fetch -q origin main
pub=$(git rev-parse open/main)
# The private commit the public snapshot was made from is in its message ("同步：私人庫 <sha>").
src=$(git log -1 --format=%B "$pub" | grep -oE '私人庫 [0-9a-f]{7,40}' | head -1 | awk '{print $2}')
[ -n "$src" ] || { echo "public main does not name the private commit it came from"; exit 1; }
echo "public main  $(git rev-parse --short "$pub")  was made from private  $src"
if [ -n "$want" ]; then
  case "$want" in "$src"*) ;; *) echo "public main was made from $src, expected ${want:0:9}"; exit 1 ;; esac
else
  echo "private main is now  $(git rev-parse --short origin/main)  ($(git rev-list --count "$src"..origin/main) commits ahead of that)"
fi
# core.quotePath=false: a file name outside ASCII (docs/research/scan-2026-11-14/00-總表.md) otherwise comes out quoted and
# escaped, and no rule of the list would match it.
other=$(git -c core.quotePath=false diff --name-status "$pub" "$src" | node "$here/removedPaths.mjs" --not-removed-diff)
if [ -n "$other" ]; then echo "DIFFERENCE that is not an excluded file:"; echo "$other"; exit 1; fi
# The markdown files may differ only on lines that link to an excluded file.
pathspecs=(); while IFS= read -r ps; do [ -z "$ps" ] || pathspecs+=("$ps"); done < <(node "$here/removedPaths.mjs" --pathspecs)
bad=$(git diff -U0 "$pub" "$src" -- '*.md' "${pathspecs[@]}" | grep -E '^[-+][^-+]' | grep -vE "$(node "$here/removedPaths.mjs" --link-pattern)|未隨公開庫附上" || true)
if [ -n "$bad" ]; then echo "markdown lines differ beyond the removed links:"; printf '%s\n' "$bad" | sed -n 1,10p; exit 1; fi
echo "OK: every code file is identical; only docs images, the scan reports, the deploy log and the links to them differ."
