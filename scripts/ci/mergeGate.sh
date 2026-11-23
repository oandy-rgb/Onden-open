#!/usr/bin/env bash
# Merge only what the public CI passed (docs/agents/mistakes.md: 2026-11-16 「紅燈修完沒有重跑完整檢查就合併」 and
# 「審查放行了明知有缺口的修正」; 2026-11-18 「只跑自己挑的測試檔就回報『受影響的都過了』」).
#   scripts/ci/mergeGate.sh <tested-ref> <PR>...           check only
#   scripts/ci/mergeGate.sh --merge <tested-ref> <PR>...   check, then merge the PRs in the order given
# <tested-ref> is the private commit pushed to the public mirror (scripts/public-mirror/public-push.sh) and tested there:
# a merge train, or the PR's own head. It passes only when all of these hold:
#  1. a finished ci.yml run on the public mirror has the tree public-push made from <tested-ref> (its commit says
#     「同步：私人庫 <sha>」) with every required job green (scripts/ci/greenRunLib.sh, the receipt job's own judgement);
#  2. each PR's head on GitHub is a commit <tested-ref> contains: nobody pushed after the tested push;
#  3. merging the PR heads onto today's origin/main gives <tested-ref>'s tree, apart from files only main changed since (a file
#     both sides changed must match: merged without a conflict it was still never tested) and
#     the generated files (entrypoints catalog, notices; the guard lane checks those are fresh);
#  4. each PR's newest comment with a 「審查結論：」 line says 可合併, and its 「已知缺口：」 line says 無 or names the owner's
#     approval (「擁有者放行：」 with a link to where the owner said so).
# The full-stack e2e is not a required job (it has a known-red baseline): read it before merging a train.
# A local Claude Code hook refuses a bare `gh pr merge`, so this script is the way PRs get merged.
# When GitHub refuses a merge that git can do (it happens with mistakes.md insertions), --merge merges origin/main into the
# PR's branch, pushes, and merges again; only a merge with no conflict at all is done this way, anything else stops.
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/ci/greenRunLib.sh
PRIVATE=oandy-rgb/Onden PUBLIC=oandy-rgb/Onden-open
GENERATED='^(docs/agents/entrypoints-catalog\.md|THIRD_PARTY_NOTICES\.md)$'
merge=false; [ "${1:-}" = --merge ] && { merge=true; shift; }
[ $# -ge 2 ] || { echo "usage: $0 [--merge] <tested-ref> <PR>..." >&2; exit 2; }
tested=$(git rev-parse --verify "$1^{commit}") || exit 2; shift
prs=("$@")
fail() { echo "不能合併：$*" >&2; exit 1; }
git fetch -q origin main || fail "拿不到 origin/main"

# 1. The public run.
line="同步：私人庫 ${tested:0:9}"
ptree=$(gh api "repos/$PUBLIC/actions/workflows/ci.yml/runs?per_page=60" \
  --jq ".workflow_runs[] | select(.head_commit.message | startswith(\"$line\")) | .head_commit.tree_id" 2>/dev/null | head -1)
[ -n "$ptree" ] || fail "公開庫沒有跑過 ${tested:0:9} 這一版（先 public-push.sh 推上去跑）"
run=$(green_run_for_tree "$PUBLIC" "$ptree")
[ -n "$run" ] || fail "${tested:0:9} 在公開 CI 還沒有一次必要工作全綠的 run（還在跑、或有紅）"
echo "ok 1  公開 CI 綠：run $run（同一棵樹）"

# 2. Each PR head is still what was tested.
heads=()
for n in "${prs[@]}"; do
  h=$(gh pr view "$n" -R "$PRIVATE" --json headRefOid,state --jq 'select(.state == "OPEN") | .headRefOid') || fail "#$n 讀不到"
  [ -n "$h" ] || fail "#$n 不是開著的 PR"
  git fetch -q origin "+pull/$n/head:refs/gate/pr$n" || fail "#$n 拿不到 head"
  git merge-base --is-ancestor "$h" "$tested" || fail "#$n 的 head ${h:0:9} 不在測過的 ${tested:0:9} 裡：測完之後又推了東西，要重測"
  heads+=("$h")
done
echo "ok 2  每個 PR 的 head 都是測過的那一版"

# 3. Today's main plus these heads is the tested tree.
# The files allowed to differ from the tested tree: those main changed since the tested commit's base (a merge commit's own
# changes included) that the tested commit did not change. A file both sides changed is not allowed: merged without a
# conflict, the result was still never tested. Computed once from the base, so the check after merging needs no count of
# commits and stays right when someone else merges meanwhile.
base=$(git merge-base "$tested" origin/main)
testedfiles=$(git diff --name-only "$base" "$tested")
allowed() { git diff --name-only "$base" origin/main | grep -vxF -f <(printf '%s\n' "$testedfiles" | sed '/^$/d'; echo /dev/null) || true; }
cur=$(git rev-parse origin/main)
for h in "${heads[@]}"; do
  t=$(git merge-tree --write-tree --name-only "$cur" "$h" 2>/dev/null); code=$?
  tree=$(printf '%s\n' "$t" | head -1)
  if [ $code -ne 0 ]; then
    bad=$(printf '%s\n' "$t" | sed '1d;/^$/,$d' | grep -vE "$GENERATED" || true)
    [ -z "$bad" ] || fail "和今天的 main 有衝突：$(echo $bad)"
  fi
  cur=$(git commit-tree "$tree" -p "$cur" -p "$h" -m gate)
done
mainonly=$(allowed)
odd=$(git diff --name-only "$cur" "$tested" | grep -vE "$GENERATED" | grep -vxF -f <(printf '%s\n' "$mainonly" | sed '/^$/d'; echo /dev/null) || true)
[ -z "$odd" ] || fail "今天的 main 加上這些 PR 和測過的不一樣（不是 main 自己改的檔）：$(echo $odd)"
echo "ok 3  今天的 main 加上這些 PR = 測過的那一份（main 之後自己改的檔除外）"

# 4. The review says it may merge, with no open known gap.
for n in "${prs[@]}"; do
  body=$(gh api "repos/$PRIVATE/issues/$n/comments?per_page=100" --paginate \
    --jq '[.[] | select(.body | test("(^|\\n)\\s*審查結論："))] | last | .body // ""' 2>/dev/null | tail -c 20000)
  verdict=$(printf '%s\n' "$body" | grep -m1 -E '^\s*審查結論：' | sed 's/^\s*審查結論：\s*//')
  gaps=$(printf '%s\n' "$body" | grep -m1 -E '^\s*已知缺口：' | sed 's/^\s*已知缺口：\s*//')
  [ -n "$verdict" ] || fail "#$n 沒有「審查結論：」留言"
  case "$verdict" in 可合併*) ;; *) fail "#$n 的審查結論是「$verdict」" ;; esac
  [ -n "$gaps" ] || fail "#$n 的審查結論沒有「已知缺口：」那一行"
  case "$gaps" in 無*) ;; *擁有者放行：*http*) ;; *) fail "#$n 有已知缺口、沒有擁有者放行：$gaps" ;; esac
done
echo "ok 4  審查結論都是可合併，沒有未放行的已知缺口"

$merge || { echo "可以合併（加 --merge 才會真的合）"; exit 0; }
for i in "${!prs[@]}"; do
  n=${prs[$i]} h=${heads[$i]}
  if gh pr merge "$n" -R "$PRIVATE" --merge --match-head-commit "$h" >/dev/null 2>&1; then echo "merged #$n"; continue; fi
  # GitHub said no although git can: bring main into the branch (no conflict allowed), push, merge that.
  git fetch -q origin main
  # Main first, the PR second: the same direction the train merged in, so two insertions at one place land in the same order as in
  # the tested tree (2026-11-23: the other direction put #1953's two mistakes.md entries in a different order).
  t=$(git merge-tree --write-tree origin/main "$h" 2>/dev/null) || fail "#$n GitHub 拒絕合併，帶入 main 也有衝突：要手動處理"
  m=$(git commit-tree "$t" -p "$h" -p origin/main -m "Merge main into #$n (GitHub refused a merge git can do)")
  b=$(gh pr view "$n" -R "$PRIVATE" --json headRefName --jq .headRefName)
  git push -q origin "$m:refs/heads/$b" || fail "#$n 推不上去"
  sleep 10
  gh pr merge "$n" -R "$PRIVATE" --merge --match-head-commit "$m" >/dev/null || fail "#$n 帶入 main 之後仍合不進去"
  echo "merged #$n（先帶入 main）"
done
git fetch -q origin main
mainonly=$(allowed)
odd=$(git diff --name-only origin/main "$tested" | grep -vE "$GENERATED" | grep -vxF -f <(printf '%s\n' "$mainonly" | sed '/^$/d'; echo /dev/null) || true)
[ -z "$odd" ] || fail "合完之後 main 和測過的不一樣：$(echo $odd)"
echo "main $(git rev-parse --short origin/main) = 測過的那一份（main 之後自己改的檔除外）"
