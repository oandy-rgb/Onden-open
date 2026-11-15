#!/usr/bin/env bash
# 備份還原演練：在本機拋棄式資料庫還原一份備份，跑 migration，核對資料不變條件。
# 只在本機執行，從不連線任何遠端主機；只碰名稱以 _drill 結尾的本機資料庫；不印任何筆記內容。
#
#   scripts/restore-drill.sh <backup-dir> [--commit <ref>] [--bootstrap]
#   scripts/restore-drill.sh <backup-dir> --no-docker --database-url postgres://u:p@localhost:5432/x_drill
#
# <backup-dir> 是 backup-vps.sh 產生的 manual-<時間戳>/（database.dump、content.tar、SHA256SUMS）。
# 預設用 docker/postgres/Dockerfile 建一個拋棄式容器（與正式站同一組 extension）。
# --no-docker 只給沒有 Docker 的環境：用本機 PostgreSQL，且備份必須由同版 pg_dump 產生。
# 結束碼：0 通過；1 有違反條件；2 用法或環境問題。說明：docs/agents/deploy.md「還原演練」。
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
backend="$repo/packages/backend"

backup="" commit="" bootstrap=0 use_docker=1 db_url_arg=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --commit) commit=${2:?--commit 需要 ref}; shift 2 ;;
    --bootstrap) bootstrap=1; shift ;;
    --no-docker) use_docker=0; shift ;;
    --database-url) db_url_arg=${2:?--database-url 需要網址}; shift 2 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "未知參數：$1" >&2; exit 2 ;;
    *) [[ -z $backup ]] || { echo "只能指定一個備份目錄" >&2; exit 2; }; backup=$1; shift ;;
  esac
done
[[ -n $backup ]] || { echo "用法：$0 <backup-dir> [--commit <ref>] [--bootstrap]" >&2; exit 2; }
[[ -d $backup ]] || { echo "找不到備份目錄：$backup" >&2; exit 2; }
backup=$(cd "$backup" && pwd)
if [[ $use_docker == 1 && -n $db_url_arg ]]; then echo "--database-url 只能和 --no-docker 一起用" >&2; exit 2; fi
if [[ $use_docker == 0 && -z $db_url_arg ]]; then echo "--no-docker 需要 --database-url" >&2; exit 2; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/onden-drill.XXXXXX")
container="" worktree="" created_db="" admin_url="" status=1
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; status=${2:-1}; exit "$status"; }

# shellcheck disable=SC2329  # runs via trap
cleanup() {
  local rc=$?
  set +e
  [[ -n $container ]] && docker rm -f "$container" >/dev/null 2>&1
  [[ -n $created_db ]] && psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$created_db\" WITH (FORCE)" >/dev/null 2>&1
  [[ -n $worktree ]] && git -C "$repo" worktree remove --force "$worktree" >/dev/null 2>&1
  rm -rf "${work:?}/media"
  if [[ $rc -eq 0 ]]; then rm -rf "$work"; else say "（紀錄與快照留在 $work；內含計數、id 與雜湊，不含筆記內容；媒體檔已刪）"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

drill_name_ok() { [[ $1 =~ ^[a-z0-9_]+_drill$ ]]; }

# ── 1. 備份完整性
step "1. 驗證備份檔"
for f in database.dump content.tar SHA256SUMS; do [[ -f $backup/$f ]] || die "備份缺少 $f" 2; done
(cd "$backup" && sha256sum -c SHA256SUMS >"$work/sha.log" 2>&1) || die "SHA256SUMS 驗證失敗（備份檔已損壞或被改動）"
say "✓ SHA256SUMS 相符"

# ── 2. 要跑 migration 的程式碼
src=$repo
if [[ -n $commit ]]; then
  step "2. 取出 $commit"
  sha=$(git -C "$repo" rev-parse --verify --quiet "$commit^{commit}") || die "找不到 commit：$commit" 2
  worktree="$work/src"
  git -C "$repo" worktree add --detach -q "$worktree" "$sha"
  for d in node_modules packages/backend/node_modules packages/markdown/node_modules; do
    [[ -d $repo/$d ]] && ln -s "$repo/$d" "$worktree/$d"
  done
  src=$worktree
  say "✓ 使用 ${sha:0:8} 的 migration（依賴沿用目前這份 checkout 的 node_modules）"
else
  step "2. 使用目前 checkout 的 migration"
  say "✓ $(git -C "$repo" rev-parse --short=8 HEAD 2>/dev/null || echo 未知)"
fi
[[ -d $src/packages/backend/db/migrations ]] || die "該版本沒有 packages/backend/db/migrations" 2

# ── 3. 拋棄式資料庫
step "3. 建立拋棄式資料庫"
if [[ $use_docker == 1 ]]; then
  command -v docker >/dev/null || die "找不到 docker；沒有 Docker 的環境改用 --no-docker --database-url" 2
  docker info >/dev/null 2>&1 || die "Docker daemon 沒有在跑" 2
  suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
  container="onden-drill-$suffix"
  dbname="o${suffix}_drill"
  drill_name_ok "$dbname" || die "資料庫名稱不合規則" 2
  pw=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  docker build -q -t onden-drill-postgres:local "$repo/docker/postgres" >/dev/null || die "建置 docker/postgres 失敗" 2
  docker run -d --name "$container" -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB="$dbname" \
    onden-drill-postgres:local postgres -c "shared_preload_libraries=pg_stat_statements" >/dev/null \
    || die "啟動容器失敗" 2
  ready=0
  for _ in $(seq 1 90); do
    # 初始化期間的暫時伺服器只聽 unix socket；TCP 通了才是正式伺服器。
    if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$dbname" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ $ready == 1 ]] || die "資料庫 90 秒內沒有就緒" 2
  port=$(docker port "$container" 5432/tcp | head -n1 | sed 's/.*://')
  export DATABASE_URL="postgres://postgres:$pw@127.0.0.1:$port/$dbname"
  say "✓ 容器 $container（127.0.0.1:$port，資料庫 $dbname）"
else
  parsed=$(node -e '
    const u = new URL(process.argv[1]);
    const host = u.hostname;
    const db = decodeURIComponent(u.pathname.slice(1));
    u.pathname = "/postgres";
    console.log([host, db, u.toString()].join("\n"));' "$db_url_arg") || die "--database-url 不是有效網址" 2
  host=$(sed -n 1p <<<"$parsed"); dbname=$(sed -n 2p <<<"$parsed"); admin_url=$(sed -n 3p <<<"$parsed")
  case $host in ""|localhost|127.0.0.1|"[::1]") ;; *) die "拒絕連線到非本機主機：$host" 2 ;; esac
  drill_name_ok "$dbname" || die "資料庫名稱必須以 _drill 結尾（收到：$dbname）" 2
  existing=$(psql "$admin_url" -Atc "SELECT 1 FROM pg_database WHERE datname = '$dbname'") || die "連不上本機 PostgreSQL" 2
  if [[ -n $existing ]]; then
    tables=$(psql "$db_url_arg" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')") || die "連不上 $dbname" 2
    [[ $tables == 0 ]] || die "$dbname 已有資料表；演練只用全新或空的資料庫" 2
  else
    psql "$admin_url" -qc "CREATE DATABASE \"$dbname\"" || die "無法建立 $dbname" 2
    created_db=$dbname
  fi
  export DATABASE_URL=$db_url_arg
  say "✓ 本機 PostgreSQL，資料庫 $dbname（不使用 Docker）"
fi

# ── 4. 還原
step "4. pg_restore"
restore_flags=(--no-owner --no-acl --exit-on-error)
# 舊備份含 Apache AGE（映像已不含）：從目錄拿掉 age 相關項目，用 -L 還原其餘部分。
if [[ $use_docker == 1 ]]; then
  docker exec -i "$container" pg_restore -l <"$backup/database.dump" | sed -f "$repo/scripts/lib/strip-age.sed" >"$work/restore.list" \
    || die "讀不了 database.dump 的目錄"
  docker cp "$work/restore.list" "$container:/tmp/restore.list" >/dev/null
  docker cp "$backup/database.dump" "$container:/tmp/database.dump" >/dev/null
  docker exec "$container" pg_restore -U postgres -d "$dbname" "${restore_flags[@]}" -L /tmp/restore.list /tmp/database.dump 2>"$work/pg_restore.log" \
    || die "pg_restore 失敗（共 $(grep -c 'error' "$work/pg_restore.log" || true) 行錯誤，見 $work/pg_restore.log）"
else
  pg_restore -l "$backup/database.dump" | sed -f "$repo/scripts/lib/strip-age.sed" >"$work/restore.list" \
    || die "讀不了 database.dump 的目錄"
  pg_restore -d "$DATABASE_URL" "${restore_flags[@]}" -L "$work/restore.list" "$backup/database.dump" 2>"$work/pg_restore.log" \
    || die "pg_restore 失敗（共 $(grep -c 'error' "$work/pg_restore.log" || true) 行錯誤，見 $work/pg_restore.log）"
fi
say "✓ 還原完成"

tsx() { (cd "$backend" && npx --no-install tsx "$@"); }

# ── 5. migration 前的不變條件
step "5. 記錄 migration 前的狀態"
tsx scripts/drillInvariants.ts snapshot --database-url "$DATABASE_URL" --out "$work/before.json" || die "讀取還原後的資料庫失敗"

# ── 6. migration（與後端開機同一支 migrate()）
step "6. 執行 migration"
DATABASE_URL=$DATABASE_URL tsx scripts/drillMigrate.ts "$src" >"$work/migrate.log" 2>&1 \
  || { grep '^migration 失敗' "$work/migrate.log" >&2 || say "migrate 執行失敗（見 $work/migrate.log）" >&2; die "migration 沒有跑完，備份在這個版本上不能直接升級"; }
say "✓ $(tail -n1 "$work/migrate.log")"

# ── 7. migration 後
step "7. 記錄 migration 後的狀態"
tsx scripts/drillInvariants.ts snapshot --database-url "$DATABASE_URL" --out "$work/after.json" || die "讀取 migration 後的資料庫失敗"

# 在「migration 後」快照之後才跑：以擁有者開啟 app 本身會寫入（例如補建個人空間、歡迎筆記），不屬於 migration。
if [[ $bootstrap == 1 ]]; then
  step "7b. 以擁有者讀取 bootstrap"
  # The app runs under Node here, which resolves @onden/* to each package's dist: build them from this checkout first,
  # or a stale dist fails the read with a missing export (2026-11-15). Same list as the server image.
  for pkg in $(node -e 'console.log(require(process.argv[1]).packages.join(" "))' "$src/packages/backend/docker/runtime-packages.json"); do
    (cd "$src" && npm run build -w "packages/$pkg" >>"$work/bootstrap.log" 2>&1) || die "建置 @onden/$pkg 失敗（見 $work/bootstrap.log）"
  done
  DATABASE_URL=$DATABASE_URL NODE_ENV=test tsx scripts/drillBootstrap.ts "$src" >"$work/bootstrap.log" 2>&1 \
    || { grep '^bootstrap 失敗' "$work/bootstrap.log" >&2 || true; die "應用程式讀不了這份資料庫"; }
  say "✓ $(grep '^bootstrap' "$work/bootstrap.log" | tail -n1)"
fi

# ── 8. 媒體
step "8. 解開 content.tar"
mkdir "$work/media"
tar -xf "$backup/content.tar" -C "$work/media" --no-same-owner --no-same-permissions 2>"$work/tar.log" || die "content.tar 解不開（見 $work/tar.log）"
say "✓ 已解到暫存目錄（結束時刪除）"

# ── 9. 比對
step "9. 比對"
if tsx scripts/drillInvariants.ts compare --before "$work/before.json" --after "$work/after.json" \
     --migrations-dir "$src/packages/backend/db/migrations" --media-dir "$work/media" --report "$work/report.json"; then
  printf '\n通過：還原演練沒有發現問題（備份 %s）\n' "$(basename "$backup")"
  status=0
else
  printf '\n未通過：上面標 ✗ 的項目必須處理；涉及的 id 可用來查（只有 id，沒有內容）\n' >&2
  status=1
fi
exit "$status"
