# Is there a finished, green run of ci.yml for this exact git tree? One judgement, two users: the receipt job
# (scripts/ci/sameTreeReceipt.sh: skip the heavy jobs when the tree already passed) and the merge gate
# (scripts/ci/mergeGate.sh: merge only a tree that passed). Sourced, not run.
# A run counts when every required job finished green; a renamed job stops matching, and then nothing counts.
GREEN_RUN_REQUIRED='^(Guard lane|Pairing and relay|Backend — lint|Backend — real Postgres \(|Frontend — lint|Three-host parity|Critical-path E2E)'
GREEN_RUN_WANT=10   # guard, pairing, backend, 4 Postgres shards, frontend, parity, critical-path e2e

# green_run_for_tree <owner/repo> <tree> [sha to leave out] → prints the id of the newest such run, or nothing.
# Any GitHub API error means "none".
green_run_for_tree() {
  local repo=$1 tree=$2 skip=${3:-} id sha runtree jobs green all
  while read -r id sha runtree; do
    [ -n "$id" ] && [ "$sha" != "$skip" ] && [ "$runtree" = "$tree" ] || continue
    jobs=$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | "\(.conclusion)\t\(.name)"' 2>/dev/null || true)
    green=$(printf '%s\n' "$jobs" | awk -F'\t' '$1 == "success" { print $2 }' | grep -cE "$GREEN_RUN_REQUIRED" || true)
    all=$(printf '%s\n' "$jobs" | cut -f2 | grep -cE "$GREEN_RUN_REQUIRED" || true)
    if [ "$all" -eq "$GREEN_RUN_WANT" ] && [ "$green" -eq "$GREEN_RUN_WANT" ]; then echo "$id"; return 0; fi
  done < <(gh api "repos/$repo/actions/workflows/ci.yml/runs?status=completed&per_page=60" \
    --jq '.workflow_runs[] | "\(.id) \(.head_sha) \(.head_commit.tree_id)"' 2>/dev/null || true)
}
