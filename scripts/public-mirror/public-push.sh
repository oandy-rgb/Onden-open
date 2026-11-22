#!/usr/bin/env bash
# public-push.sh <private ref> <branch on Onden-open> [--fullstack] : the tree of <ref> without the paths in removed-paths.json (docs images,
# the scan reports, the deploy log), as one commit. Run in a clean worktree of the private repo.
# A branch other than main is always one commit on top of public main, replacing what the public branch held (force push): stacked on
# the branch's old public commit, its base stayed an older main and the guard lane counted everything main gained since as this
# branch's change (false "docs covered" and ratchet reds, 2026-11-22). So <ref> must contain private main: merge main into it first.
# --fullstack writes `ci-fullstack: true` into the commit, and the run this push starts includes the full-stack e2e (ci.yml), instead of
# a second, manual run that cancels it.
set -euo pipefail
ref=$1; branch=$2; here=$(dirname "$0")
fullstack=""; [ "${3:-}" = "--fullstack" ] && fullstack="ci-fullstack: true"
[ -z "$(git status --porcelain)" ] || { echo "worktree not clean"; exit 1; }
sha=$(git rev-parse "$ref"); back=$(git rev-parse --abbrev-ref HEAD); [ "$back" != HEAD ] || back=$(git rev-parse HEAD)
git fetch -q open
# A branch goes up only while public main IS private main: a stale public main is two repos that differ, and a check that
# runs against an old base. Whoever finds it stale brings it up to date first (the same script, with `origin/main main`).
if [ "$branch" != main ]; then
  git fetch -q origin main
  bash "$here/verify.sh" "$(git rev-parse origin/main)" > /dev/null \
    || { echo "NOT pushed: public main is not private main. First: bash scripts/public-mirror/public-push.sh origin/main main"; exit 1; }
  git merge-base --is-ancestor origin/main "$sha" \
    || { echo "NOT pushed: $ref does not contain private main. Merge main into it first (the public commit is built on public main)."; exit 1; }
fi
# The tools and the list of what the mirror leaves out are taken from THIS checkout (the one the script was started
# from) before the tree is swapped: after `git checkout` "$here" holds <ref>'s files, and a ref's own, older or absent,
# version of the list must not decide what gets published.
tools=$(mktemp -d); trap 'rm -rf "$tools"' EXIT
mkdir -p "$tools/scripts/public-mirror"
cp "$here/removedPaths.mjs" "$here/removed-paths.json" "$here/strip_links.py" "$tools/scripts/public-mirror/"
cp "$here/../prCardLib.mjs" "$tools/scripts/"
removed="$tools/scripts/public-mirror/removedPaths.mjs"
git checkout -q --detach "$sha"
# What the mirror leaves out is one piece of data (removed-paths.json): docs images, the scan reports, the deploy log
# (owner, 2026-11-16: backup and rollback names, disk use). public-push.sh, verify.sh and the docs checker all read it.
git ls-files -z | node "$removed" --filter -z | xargs -0 -r git rm -q
python3 "$tools/scripts/public-mirror/strip_links.py"
node scripts/check-md-links.mjs | tail -1
git add -A
[ -z "$(git ls-files -z | node "$removed" --filter -z | tr -d '\0')" ] || { echo "strip failed"; exit 1; }
tree=$(git write-tree)
# main stacks on public main; every other branch is rebuilt on it (see the top).
parent=$(git rev-parse open/main)
# Last look before anything becomes public: what this push ADDS compared with what is already public.
# Stops on a new binary/media/archive file anywhere, a file over 1 MiB, or added text that looks like a key or token.
# PUBLIC_PUSH_ALLOW=1 skips it; use only after reading the list yourself.
problems=""
while IFS=$'\t' read -r status path; do
  [ -n "$path" ] || continue
  case "$path" in
    *.png|*.jpg|*.jpeg|*.webp|*.gif|*.bmp|*.heic|*.mp4|*.mov|*.webm|*.mp3|*.wav|*.pdf|*.zip|*.tar|*.gz|*.tgz|*.7z|*.sqlite|*.db|*.dump|*.pem|*.key|*.p12|*.env)
      problems="$problems\n  new file of a kind that is not pushed without a look: $path" ;;
  esac
  size=$(git cat-file -s ":$path" 2>/dev/null || echo 0)
  [ "$size" -le 1048576 ] || problems="$problems\n  larger than 1 MiB ($size bytes): $path"
done < <(git diff --cached --name-status --diff-filter=A "$parent")
secrets=$(git diff --cached -U0 "$parent" | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -nE 'BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bp]-[0-9A-Za-z-]{20,}|sk-ant-[A-Za-z0-9_-]{40,}|onden_[A-Za-z0-9]{32,}' \
  | grep -vE 'abcdefghijklmnopqrstuvwxyz|PLAINTEXT|edgesedges|wpmwpm|"a"\.repeat|"z"\.repeat' | cut -c1-160 | head -5 || true)
[ -z "$secrets" ] || problems="$problems\n  added text that looks like a key or token:\n$secrets"
if [ -n "$problems" ] && [ "${PUBLIC_PUSH_ALLOW:-}" != "1" ]; then
  printf 'NOT pushed. This push would make public:%b\n' "$problems"
  git reset -q --hard; git checkout -q "$back"; exit 1
fi
# The ratchet check reads `ratchet-override:` lines from the commits between main and HEAD (scripts/ratchetLib.mjs). The branch
# arrives as one commit, so the lines the private commits carry go into its message, or the guard lane on the public CI would refuse
# an addition the owner agreed to.
# origin/main is fetched first: against a stale one the range reaches back into commits that are already on main, and an override
# copied from one of those would open the ratchet for this branch without anyone having agreed to it here.
# The public CI also starts by itself on every push (ci.yml, 2026-11-20), where there is no PR description to pass: the
# guard lane's two written exemptions — 「不需要更新說明」 (scripts/changesLib.mjs) and 「文件不需要更新：<原因>」
# (scripts/check-md-links.mjs) — ride along the same way, from the private commits and from the branch's PR description.
# The lines become public text, and the look above reads only the diff, so they get the same key/token look; keep reasons free of
# server details and of counts of the owner's data.
git fetch -q origin main
# The branch's PR (a ref given as origin/<branch> names the same PR).
pr_json=$(gh pr view "${ref#origin/}" --repo oandy-rgb/Onden --json body,createdAt 2>/dev/null || true)
pr_body=$(printf '%s' "$pr_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).body||"")}catch{}})')
# Every PR is pushed here to be checked, so this is where its 驗收卡 (the five lines the owner reads, scripts/prCardLib.mjs) is
# required: a PR opened from 2026-11-21 on without a complete card is not pushed (PUBLIC_PUSH_ALLOW=1 overrides, as above).
if [ -n "$pr_json" ] && ! PR_JSON="$pr_json" node "$tools/scripts/prCardLib.mjs" $(git diff --name-only "$(git merge-base origin/main "$sha")" "$sha") \
   && [ "${PUBLIC_PUSH_ALLOW:-}" != "1" ]; then
  echo "NOT pushed: complete the PR's 驗收卡 first."
  git reset -q --hard; git checkout -q "$back"; exit 1
fi
said=$( { git log --format=%B "$(git merge-base origin/main "$sha")..$sha"; printf '%s\n' "$pr_body"; } | sed 's/\r$//')
# changes.mjs accepts the phrase anywhere in the text, so it travels as one line of its own instead of the sentence around it.
overrides=$( { printf '%s\n' "$said" | grep -iE '^ratchet-override:[[:space:]]*[^[:space:]]|^[[:space:]]*文件不需要更新：[[:space:]]*[^[:space:]]';
  printf '%s\n' "$said" | grep -q '不需要更新說明' && echo '不需要更新說明'; } | sort -u || true)
if printf '%s' "$overrides" | grep -qE 'BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bp]-[0-9A-Za-z-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' && [ "${PUBLIC_PUSH_ALLOW:-}" != "1" ]; then
  echo "NOT pushed. A carried line (ratchet-override / exemption) that would become public looks like it holds a key or an address:"; printf '%s\n' "$overrides"
  git reset -q --hard; git checkout -q "$back"; exit 1
fi
c=$(git commit-tree "$tree" -p "$parent" -m "同步：私人庫 ${sha:0:9}（$ref）
${overrides:+
$overrides}

Co-Authored-By: Claude <noreply@anthropic.com>
${fullstack:+$fullstack
}${PUBLIC_PUSH_TRAILER:-}")
git reset -q --hard; git checkout -q "$back"
if [ "$branch" = main ]; then git push -q open "$c:refs/heads/main"; else git push -q --force open "$c:refs/heads/$branch"; fi
echo "pushed $c to Onden-open/$branch"
