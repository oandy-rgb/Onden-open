#!/usr/bin/env bash
# scripts/ci/mergeGate.sh against a fake `gh` and a throwaway git repository: each way it must refuse is shown to refuse,
# and the one good case is shown to pass. Run by the guard lane (scripts/guard-lane.sh).
#   bash scripts/merge-gate-selftest.sh
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t GIT_CONFIG_GLOBAL=/dev/null

# origin: main, and one PR whose head is pull/7/head.
git init -q --bare "$work/origin.git"
git init -q -b main "$work/repo" && cd "$work/repo" || exit 1
mkdir -p scripts/ci && cp "$here/scripts/ci/mergeGate.sh" "$here/scripts/ci/greenRunLib.sh" scripts/ci/
echo a > a.txt && git add -A && git commit -qm base
git remote add origin "$work/origin.git" && git push -q origin main
git checkout -qb pr && echo b > b.txt && git add b.txt && git commit -qm pr
head=$(git rev-parse HEAD); git push -q origin "HEAD:refs/pull/7/head"
git checkout -qb train main && git merge -q --no-edit pr && tested=$(git rev-parse HEAD)
git checkout -q main

# The fake gh answers from files the cases write; --jq is ignored (the answers are already what the filter would give).
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
d=$FAKE_GH
case "$*" in
  *"actions/workflows/ci.yml/runs"*"select(.head_commit.message"*) cat "$d/ptree" ;;
  *"actions/workflows/ci.yml/runs"*) echo "1 abc $(cat "$d/ptree")" ;;
  *"actions/runs/1/jobs"*) cat "$d/jobs" ;;
  "pr view 7 "*"headRefOid,state"*) cat "$d/head" ;;
  *"issues/7/comments"*) cat "$d/comment" ;;
  "pr merge"*) echo merged >> "$d/merges" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FAKE_GH="$work/gh"
mkdir -p "$FAKE_GH"
green() { for j in "Guard lane" "Pairing and relay" "Backend — lint" "Backend — real Postgres (1/4)" "Backend — real Postgres (2/4)" \
  "Backend — real Postgres (3/4)" "Backend — real Postgres (4/4)" "Frontend — lint" "Three-host parity" "Critical-path E2E"; do printf 'success\t%s\n' "$j"; done; }
reset() {
  echo tree1 > "$FAKE_GH/ptree"; green > "$FAKE_GH/jobs"; echo "$head" > "$FAKE_GH/head"
  printf '審查結論：可合併\n已知缺口：無\n' > "$FAKE_GH/comment"
}
failures=0
expect() { # expect <pass|refuse> <what> <words the refusal must say>
  local want=$1 what=$2 words=${3:-} out code
  out=$(bash scripts/ci/mergeGate.sh "$tested" 7 2>&1); code=$?
  if [ "$want" = pass ] && [ $code -eq 0 ]; then echo "ok   $what"; return; fi
  if [ "$want" = refuse ] && [ $code -eq 1 ] && printf '%s' "$out" | grep -q "$words"; then echo "ok   $what"; return; fi
  echo "FAIL $what (exit $code)"; printf '%s\n' "$out" | sed 's/^/     /'; failures=$((failures + 1))
}

reset; expect pass "tested, green, head unchanged, review says merge with no gap"
reset; : > "$FAKE_GH/ptree"; expect refuse "the tested commit never reached the public CI" "沒有跑過"
reset; sed -i '1s/^success/failure/' "$FAKE_GH/jobs"; expect refuse "a required job is red" "全綠"
reset; git checkout -q pr && echo c > c.txt && git add c.txt && git commit -qm later && git push -q origin "HEAD:refs/pull/7/head" -f
  git rev-parse HEAD > "$FAKE_GH/head"; git checkout -q main
  expect refuse "the PR got a commit after the tested push" "又推了東西"
  git push -q origin "$head:refs/pull/7/head" -f
reset; echo d > b.txt && git add b.txt && git commit -qm "main writes the PR's file differently" && git push -q origin main
  expect refuse "today's main conflicts with the PR" "衝突"
  git reset -q --hard HEAD~1 && git push -q -f origin main
reset; printf '審查結論：退回\n已知缺口：無\n' > "$FAKE_GH/comment"; expect refuse "the review says send back" "退回"
reset; printf '審查結論：可合併\n已知缺口：舊資料沒有回填\n' > "$FAKE_GH/comment"; expect refuse "a known gap without the owner's approval" "已知缺口"
reset; printf '審查結論：可合併\n已知缺口：舊資料沒有回填（擁有者放行：https://github.com/x/y/pull/7#issuecomment-1）\n' > "$FAKE_GH/comment"
  expect pass "a known gap the owner approved"
reset; : > "$FAKE_GH/comment"; expect refuse "no review verdict at all" "審查結論"
reset; echo e > a.txt && git commit -qam "main moves on another file" && git push -q origin main
  expect pass "main moved on a file the PR does not touch"
  git reset -q --hard HEAD~1 && git push -q -f origin main
reset; git checkout -qb side main && echo s > s.txt && git add s.txt && git commit -qm side && git checkout -q main \
  && git merge -q --no-ff --no-commit side >/dev/null && echo m > m.txt && git add m.txt && git commit -qm "a merge that also changes a file of its own" && git push -q origin main
  expect pass "main moved through a merge commit that changes a file itself (not only through its branch's commits)"
  git reset -q --hard HEAD~1 && git push -q -f origin main && git branch -qD side
[ "$failures" -eq 0 ] && echo "merge gate self-test passed" || { echo "merge gate self-test: $failures case(s) wrong"; exit 1; }
