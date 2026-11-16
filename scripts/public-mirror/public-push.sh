#!/usr/bin/env bash
# public-push.sh <private ref> <branch on Onden-open> : the tree of <ref> without docs images and the scan reports,
# as one commit on top of the public branch (or of public main for a new branch). Run in a clean worktree of the private repo.
set -euo pipefail
ref=$1; branch=$2; here=$(dirname "$0")
[ -z "$(git status --porcelain)" ] || { echo "worktree not clean"; exit 1; }
sha=$(git rev-parse "$ref"); back=$(git rev-parse --abbrev-ref HEAD); [ "$back" != HEAD ] || back=$(git rev-parse HEAD)
git fetch -q open
git checkout -q --detach "$sha"
git ls-files docs | grep -iE '\.(png|jpe?g|webp|gif)$' | tr '\n' '\0' | xargs -0 -r git rm -q
[ -d docs/research/scan-2026-11-14 ] && git rm -rq docs/research/scan-2026-11-14
# The deploy log stays private (owner, 2026-11-16): backup and rollback names, disk use.
[ -f docs/deploy-log.md ] && git rm -q docs/deploy-log.md
python3 "$here/strip_links.py"
node scripts/check-md-links.mjs | tail -1
git add -A
[ "$(git ls-files | grep -ciE '^docs/.*\.(png|jpe?g|webp|gif)$')" = 0 ] && [ "$(git ls-files | grep -c 'scan-2026-11-14')" = 0 ] && [ ! -e docs/deploy-log.md ] || { echo "strip failed"; exit 1; }
tree=$(git write-tree)
parent=$(git rev-parse -q --verify "open/$branch" || git rev-parse open/main)
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
overrides=$(git log --format=%B "$(git merge-base origin/main "$sha")..$sha" | grep -iE '^ratchet-override:[[:space:]]*[^[:space:]]' | sort -u || true)
c=$(git commit-tree "$tree" -p "$parent" -m "同步：私人庫 ${sha:0:9}（$ref）
${overrides:+
$overrides}

Co-Authored-By: Claude <noreply@anthropic.com>
${PUBLIC_PUSH_TRAILER:-}")
git reset -q --hard; git checkout -q "$back"
git push -q open "$c:refs/heads/$branch"
echo "pushed $c to Onden-open/$branch"
