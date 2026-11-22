#!/usr/bin/env bash
# Same tree already green? (ci.yml `receipt` job, owner 2026-11-22.) Every push to the public mirror starts the full
# suites, and a merge train's tree is tested twice: once on its acc-* branch, again when main is synced to exactly the same
# tree. Runs are receipts for a TREE, not a commit: if a finished run of ci.yml had this same git tree and every required job
# green, this run reuses it and the heavy jobs skip; the summary names the run it reused. A different tree runs everything.
# Never reused: the full-stack e2e (always runs when asked), scheduled runs (a night with no change must still run), PRs.
# The guard lane's result also depends on the base and the commit message (its 「文件不需要更新」 lines); reuse assumes the second push
# of a tree is the main sync after a tested train, which carries the same tree on a base that already holds it.
# Any GitHub API error means "no receipt": the run then does everything (a hiccup must not fail the jobs that need this one).
# Env: ELIGIBLE (true/false, decided by ci.yml), GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.
set -euo pipefail
out() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }
out reused false
[ "${ELIGIBLE:-false}" = true ] || { echo "not eligible for reuse: running everything"; exit 0; }
tree=$(git rev-parse 'HEAD^{tree}')
# The jobs a reused run must have finished green; a renamed job simply stops matching, and then nothing is reused.
required='^(Guard lane|Pairing and relay|Backend — lint|Backend — real Postgres \(|Frontend — lint|Three-host parity|Critical-path E2E)'
want=10   # guard, pairing, backend, 4 Postgres shards, frontend, parity, critical-path e2e
runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?status=completed&per_page=40" \
  --jq '.workflow_runs[] | "\(.id) \(.head_sha) \(.head_commit.tree_id)"' 2>/dev/null || true)
while read -r id sha runtree; do
  [ -n "$id" ] && [ "$sha" != "$GITHUB_SHA" ] && [ "$runtree" = "$tree" ] || continue
  jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | "\(.conclusion)\t\(.name)"' 2>/dev/null || true)
  green=$(printf '%s\n' "$jobs" | awk -F'\t' '$1 == "success" { print $2 }' | grep -cE "$required" || true)
  all=$(printf '%s\n' "$jobs" | cut -f2 | grep -cE "$required" || true)
  if [ "$all" -eq "$want" ] && [ "$green" -eq "$want" ]; then
    echo "same tree $tree as run $id, all $want required jobs green: reused"
    { echo "### Same tree as run [$id](https://github.com/$GITHUB_REPOSITORY/actions/runs/$id)"
      echo "Its guard lane and suites were all green on exactly this tree, so they are not run again. The full-stack e2e is never reused."; } >> "$GITHUB_STEP_SUMMARY"
    out reused true; out from "$id"; exit 0
  fi
done <<< "$runs"
echo "no finished green run of tree $tree: running everything"
