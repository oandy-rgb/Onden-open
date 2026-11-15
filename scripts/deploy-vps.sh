#!/usr/bin/env bash
# Deploy a commit to the production VPS, the steps of docs/agents/deploy.md in one command. Run on the laptop, in the repo.
#
#   scripts/deploy-vps.sh build    <commit> [--backend]   upload the commit and build its images; prod is not touched
#   scripts/deploy-vps.sh switch   <commit> [--backend]   lock, backup, rollback tags, switch, checks, browser boot probe,
#                                                         then the browser version and the desktop app (deploy-clients.sh)
#   scripts/deploy-vps.sh deploy   <commit> [--backend]   build, then switch
#   scripts/deploy-vps.sh rollback <before-tag> [--backend]
#   scripts/deploy-vps.sh status
#
# Frontend only by default; --backend builds and switches the backend too (its migrations run when it starts).
# `build` writes onden-vps-<svc>:pre-<tree>-<commit>, never :latest, so it can run while the tests do: an untested
# build is never what a restart picks up. `switch` takes the build whose tree equals the commit's, so a build of the
# tested merge stack serves main after the stack is merged (same tree, other commit). The page and the backend then
# report the stack commit as their build id (X-Onden-Build); current/REVISION is the main commit.
# Each remote script is one { … } < /dev/null block: parsed whole before it runs, with stdin closed, because what it
# starts (backup.sh) would otherwise read the rest of the script from ssh's stdin and the run would stop there.
# ssh joins its arguments into one command line, so "backend frontend" would arrive as two words: lists go over comma-joined.
set -euo pipefail

HOST=${ONDEN_VPS_HOST:-100.84.227.77}
URL=${ONDEN_VPS_URL:-https://oandy-vps.tail9249f1.ts.net}
ROOT=/srv/onden
REPO=$(cd "$(dirname "$0")/.." && pwd)

die() { echo "deploy-vps: $*" >&2; exit 1; }
vps() { ssh -o BatchMode=yes "$HOST" "$@"; }

cmd=${1:-}; shift || true
target=""; svcs="frontend"
for a in "$@"; do
  case "$a" in
    --backend) svcs="backend frontend" ;;
    -*) die "unknown option $a" ;;
    *) [ -z "$target" ] || die "one commit only"; target=$a ;;
  esac
done

resolve() {
  [ -n "$target" ] || die "$cmd needs a commit"
  git -C "$REPO" fetch -q origin
  sha=$(git -C "$REPO" rev-parse --verify "$target^{commit}") || die "no commit $target"
  tree=$(git -C "$REPO" rev-parse "$sha^{tree}" | cut -c1-12)
}

upload() {
  if vps "test -f $ROOT/releases/$sha/REVISION"; then return; fi
  echo "== upload $sha"
  vps "mkdir -p $ROOT/releases/$sha.part"
  # Foreground: an ssh command left in the background gets /dev/null as stdin and the archive never arrives.
  git -C "$REPO" archive "$sha" | vps "tar -x -C $ROOT/releases/$sha.part && echo $sha > $ROOT/releases/$sha.part/REVISION && mv -T $ROOT/releases/$sha.part $ROOT/releases/$sha"
}

build() {
  upload
  echo "== build $svcs at tree $tree"
  vps bash -s -- "$sha" "$tree" "${svcs// /,}" <<'REMOTE'
{
set -euo pipefail
ROOT=/srv/onden; sha=$1; tree=$2; svcs=${3//,/ }
used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
if [ "$used" -ge 90 ]; then
  echo "disk $used% used: drop the oldest before-* tags first (docs/agents/deploy.md)"; docker images 'onden-vps-*' --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' | grep before-; exit 1
fi
todo=""
for svc in $svcs; do
  if docker images "onden-vps-$svc" --format '{{.Tag}}' | grep "^pre-$tree-" > /dev/null; then echo "$svc: already built for this tree"; else todo="$todo $svc"; fi
done
[ -n "$todo" ] || exit 0
log=$ROOT/build-${sha:0:12}.log
cd "$ROOT/releases/$sha"
start=$(date +%s)
if ! ONDEN_VERSION="pre-$tree-$sha" ONDEN_BUILD_ID="$sha" docker compose -p onden-vps --env-file "$ROOT/shared/.env" -f compose.yaml build $todo > "$log" 2>&1; then
  tail -40 "$log"; echo "build failed, log $log"; exit 1
fi
echo "built$todo in $(( $(date +%s) - start ))s, log $log"
} < /dev/null
REMOTE
}

switch() {
  upload
  echo "== switch to $sha ($svcs)"
  out=$(vps bash -s -- "$sha" "$tree" "${svcs// /,}" "${USER:-?}@$(hostname -s)" <<'REMOTE' | tee /dev/stderr
{
set -euo pipefail
ROOT=/srv/onden; sha=$1; tree=$2; svcs=${3//,/ }; who=$4
compose() { docker compose -p onden-vps --env-file "$ROOT/shared/.env" -f compose.yaml "$@"; }
mkdir "$ROOT/deploy.lock" 2>/dev/null || { echo "deploy.lock is held: $(cat "$ROOT/deploy.lock/owner" 2>/dev/null)"; exit 3; }
trap 'rm -rf "$ROOT/deploy.lock"' EXIT
echo "$who $sha $(date -u +%FT%TZ)" > "$ROOT/deploy.lock/owner"

prev=$(cat "$ROOT/current/REVISION")
declare -A tag
for svc in $svcs; do
  tag[$svc]=$(docker images "onden-vps-$svc" --format '{{.Tag}}' | grep "^pre-$tree-" | head -1 || true)
  [ -n "${tag[$svc]}" ] || { echo "no $svc build for tree $tree: run build first"; exit 1; }
done
build_id=${tag[frontend]##*-}

echo "-- backup"
backup=$(bash "$ROOT/shared/backup.sh" 2>&1 | grep -oE 'manual-[0-9]+' | tail -1)
[ -n "$backup" ] || { echo "backup failed"; exit 1; }
# Rollback tags of what runs now, before anything moves :latest.
for svc in backend frontend; do
  docker image inspect "onden-vps-$svc:before-${prev:0:7}" > /dev/null 2>&1 || docker tag "onden-vps-$svc:latest" "onden-vps-$svc:before-${prev:0:7}"
done
for svc in $svcs; do docker tag "onden-vps-$svc:${tag[$svc]}" "onden-vps-$svc:latest"; done

echo "-- switch"
cd "$ROOT/releases/$sha"
echo "$build_id" > BUILD_ID
since=$(date -u +%FT%TZ)
# Both always: the backend reports the build id the page compares (X-Onden-Build).
ONDEN_BUILD_ID="$build_id" compose up -d --no-build --no-deps backend frontend 2>&1 | grep -v '^ *Container .* \(Starting\|Started\|Waiting\|Healthy\|Running\)' || true
ln -sfn "$ROOT/releases/$sha" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
docker exec onden-vps-nginx-1 nginx -s reload 2>&1 | grep -v 'duplicate extension\|signal process started' || true

echo "-- checks"
ok=1
for _ in $(seq 60); do
  docker exec onden-vps-backend-1 node -e 'fetch("http://127.0.0.1:8787/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' 2> /dev/null && { ok=0; break; }
  sleep 1
done
[ $ok -eq 0 ] && echo "health ok" || echo "HEALTH FAILED"
served=$(curl -s -D - -o /dev/null http://127.0.0.1:5180/api/site | tr -d '\r' | awk -F': ' 'tolower($1)=="x-onden-build"{print $2}')
[ "$served" = "$build_id" ] && echo "X-Onden-Build $served" || { echo "X-ONDEN-BUILD MISMATCH: '$served', want $build_id"; ok=1; }
docker logs --since "$since" onden-vps-backend-1 2>&1 | grep -E '\[migrate\] applied' || echo "no migration applied"
docker logs --since "$since" onden-vps-backend-1 2>&1 | grep -iE '"level":("error"|50)|\berror\b' | head -5 || true
# Builds made for other trees were never switched to: drop them (the image just used keeps its :latest tag).
for svc in backend frontend; do
  docker images "onden-vps-$svc" --format '{{.Tag}}' | grep '^pre-' | grep -v "^pre-$tree-" | sed "s|^|onden-vps-$svc:|" | xargs -r docker rmi > /dev/null || true
done
# Rollback images: the 2 newest that differ from what now runs stay (owner, 2026-11-15: keep the last 2; it was 3, and
# a --backend build now needs ~12% of the disk), newest by when their release arrived. A tag on the running image costs nothing and stays; untagging the others frees them.
for svc in backend frontend; do
  live=$(docker image inspect -f '{{.Id}}' "onden-vps-$svc:latest")
  for t in $(docker images "onden-vps-$svc" --format '{{.Tag}}' | grep '^before-' || true); do
    echo "$(stat -c %Y "$ROOT/releases/${t#before-}"* 2> /dev/null | head -1 || echo 0) $(docker image inspect -f '{{.Id}}' "onden-vps-$svc:$t") $t"
  done | sort -rn | awk -v live="$live" '$2 != live && !($2 in seen) { seen[$2] = 1; n++ } $2 != live && n > 2 { print $3 }' |
    sed "s|^|onden-vps-$svc:|" | xargs -r docker rmi > /dev/null || true
done
# Build cache only (owner, 2026-11-14: after every deploy): two builds regrow it by ~18% of the disk. Images, the
# before-* rollback tags and the release directories are not touched; the next build is slower by the cold cache.
docker builder prune -f 2>&1 | tail -1 || true
# A prune has been suspected of taking image content with it (docs/agents/deploy.md): prove each image that runs or
# can be rolled back to still makes a container. A loss does not undo this deploy; it has to be seen.
for img in $(docker images 'onden-vps-*' --format '{{.Repository}}:{{.Tag}}' | grep -E ':(latest|before-[0-9a-f]+)$'); do
  c=$(docker create "$img" true 2> /dev/null) && docker rm "$c" > /dev/null || echo "IMAGE DAMAGED AFTER PRUNE: $img (rebuild it from its release directory)"
done
echo "PREV=$prev"
echo "BUILD_ID=$build_id"
echo "BACKUP=$backup"
echo "ROLLBACK=before-${prev:0:7}"
echo "WORKER=$(docker exec onden-vps-frontend-1 ls /app/packages/frontend/dist/client/_astro | grep -m1 '^localDbWorker-.*\.js$')"
echo "DISK=$(df --output=pcent / | tail -1 | tr -d ' ')"
[ $ok -eq 0 ] || { echo "checks failed: roll back with scripts/deploy-vps.sh rollback before-${prev:0:7}"; exit 1; }
} < /dev/null
REMOTE
  ) || die "switch failed (prod may be on the new release; see above)"
  val() { sed -n "s/^$1=//p" <<< "$out" | tail -1; }
  prev=$(val PREV); [ -n "$prev" ] || die "the switch printed no summary"

  echo "== browser boot probe"
  LANG=en_US.UTF-8 node "$REPO/scripts/deployBootProbe.mjs" "$URL/" "$(val WORKER)" || die "boot probe failed: roll back with scripts/deploy-vps.sh rollback $(val ROLLBACK)"

  # Prod is on the commit and checked; the browser version and the desktop app follow it. A failure here leaves prod
  # as it is (deployed): the row below says so, and deploy-clients.sh prints what to rerun.
  echo "== browser version and desktop app"
  clients="瀏覽器版與桌面版已更新到同一版"
  "$REPO/scripts/deploy-clients.sh" "$sha" || clients="瀏覽器版或桌面版沒有更新成功（要重跑 scripts/deploy-clients.sh）"

  prs=$(git -C "$REPO" log --merges --format=%s "$prev..$sha" | sed -nE 's/^Merge pull request (#[0-9]+).*/\1/p' | tac | paste -sd' ')
  migrations=$(git -C "$REPO" diff --name-only --diff-filter=A "$prev" "$sha" -- packages/backend/db/migrations | sed -E 's|.*/([0-9]+)_.*|\1|' | paste -sd' ')
  scope=$([ "$svcs" = frontend ] && echo "只有前端" || echo "前端＋後端")
  echo
  echo "deploy-log row (docs/deploy-log.md; fill in the note):"
  echo "| $(date -u '+%F %H:%M') | \`${sha:0:8}\` | ${prs:-—} | ${migrations:-無} | \`$(val ROLLBACK)\` | \`$(val BACKUP)\` | $scope：…。部署後：\`/health\` 200、\`X-Onden-Build\` 為 $(val BUILD_ID | cut -c1-8)、瀏覽器開機檢查無錯誤、worker 載入正常。$clients。磁碟 $(val DISK)。 |"
}

rollback() {
  [[ "$target" == before-* ]] || die "rollback needs a before-<sha> tag (scripts/deploy-vps.sh status lists them)"
  vps bash -s -- "$target" "${svcs// /,}" <<'REMOTE'
{
set -euo pipefail
ROOT=/srv/onden; to=$1; svcs=${2//,/ }
compose() { docker compose -p onden-vps --env-file "$ROOT/shared/.env" -f compose.yaml "$@"; }
mkdir "$ROOT/deploy.lock" 2>/dev/null || { echo "deploy.lock is held: $(cat "$ROOT/deploy.lock/owner" 2>/dev/null)"; exit 3; }
trap 'rm -rf "$ROOT/deploy.lock"' EXIT
echo "rollback $to $(date -u +%FT%TZ)" > "$ROOT/deploy.lock/owner"
cur=$(cat "$ROOT/current/REVISION")
rel=$(ls -d "$ROOT/releases/${to#before-}"* | head -1)
[ -d "$rel" ] || { echo "no release directory for $to"; exit 1; }
for svc in $svcs; do
  docker image inspect "onden-vps-$svc:$to" > /dev/null || exit 1
  docker tag "onden-vps-$svc:latest" "onden-vps-$svc:broken-${cur:0:7}"
  docker tag "onden-vps-$svc:$to" "onden-vps-$svc:latest"
done
build_id=$(cat "$rel/BUILD_ID" 2> /dev/null || cat "$rel/REVISION")
cd "$rel"
ONDEN_BUILD_ID="$build_id" compose up -d --no-build --no-deps backend frontend
ln -sfn "$rel" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
docker exec onden-vps-nginx-1 nginx -s reload 2>&1 | grep -v 'duplicate extension\|signal process started' || true
echo "rolled back $svcs to $to ($(cat "$rel/REVISION")); the broken images are tagged broken-${cur:0:7}"
} < /dev/null
REMOTE
}

status() {
  vps 'ROOT=/srv/onden; echo "live    $(cat $ROOT/current/REVISION)"; echo "lock    $(cat $ROOT/deploy.lock/owner 2>/dev/null || echo free)"
    echo "disk    $(df --output=pcent / | tail -1 | tr -d " ")"
    docker images "onden-vps-*" --format "{{.Repository}}:{{.Tag}}  {{.CreatedSince}}" | grep -E ":(pre|before|broken)-" | sort'
}

case "$cmd" in
  build) resolve; build ;;
  switch) resolve; switch ;;
  deploy) resolve; build; switch ;;
  rollback) rollback ;;
  status) status ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
