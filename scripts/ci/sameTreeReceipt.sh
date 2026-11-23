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
. "$(dirname "$0")/greenRunLib.sh"
id=$(green_run_for_tree "$GITHUB_REPOSITORY" "$tree" "$GITHUB_SHA")
if [ -n "$id" ]; then
  echo "same tree $tree as run $id, all $GREEN_RUN_WANT required jobs green: reused"
  { echo "### Same tree as run [$id](https://github.com/$GITHUB_REPOSITORY/actions/runs/$id)"
    echo "Its guard lane and suites were all green on exactly this tree, so they are not run again. The full-stack e2e is never reused."; } >> "$GITHUB_STEP_SUMMARY"
  out reused true; out from "$id"; exit 0
fi
echo "no finished green run of tree $tree: running everything"
