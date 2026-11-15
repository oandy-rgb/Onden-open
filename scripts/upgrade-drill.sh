#!/usr/bin/env bash
# 升級路徑演練：從「基準版本」的 schema 加一批合成資料，升到目前 checkout 的 migration，核對資料不變。
# 自架使用者的升級就是這條路（舊資料庫 + 新程式開機時的 migrate()），所以每個發布前都要過。
#
#   scripts/upgrade-drill.sh [--from <tag|commit>]                       # Docker（與正式站同一組 extension）
#   scripts/upgrade-drill.sh [--from <ref>] --no-docker --database-url postgres://u:p@localhost:5432/postgres
#   scripts/upgrade-drill.sh --no-docker --database-url … --strip-extensions   # 本機 PostgreSQL 沒有 age/pgroonga/vector
#
# 基準版本：--from；沒給就用最新的 v* tag（上一個發布版本）；還沒有任何 tag 時用 BASELINE_COMMIT。
# 流程：基準的 db/schema.sql + 合成資料 → pg_dump（備份目錄形狀）→ scripts/restore-drill.sh 還原、
# 跑目前的 migration、比對筆記／標籤／連結等數量與雜湊。只連本機、只碰 _drill 結尾的資料庫。
# 結束碼：0 通過；1 有違反條件；2 用法或環境問題。規則與讀法：docs/agents/migrations.md。
set -euo pipefail

# 還沒有發布 tag 時的基準：schema.sql 含 migration 到 125（之後有 126 刪表、129 搬標籤等會動資料的 migration）。
BASELINE_COMMIT=99562e84

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
from="" use_docker=1 db_url_arg="" strip=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) from=${2:?--from 需要 tag 或 commit}; shift 2 ;;
    --no-docker) use_docker=0; shift ;;
    --database-url) db_url_arg=${2:?--database-url 需要網址}; shift 2 ;;
    --strip-extensions) strip=1; shift ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知參數：$1" >&2; exit 2 ;;
  esac
done
if [[ $use_docker == 0 && -z $db_url_arg ]]; then echo "--no-docker 需要 --database-url" >&2; exit 2; fi
if [[ $use_docker == 1 && -n $db_url_arg ]]; then echo "--database-url 只能和 --no-docker 一起用" >&2; exit 2; fi

if [[ -z $from ]]; then
  from=$(git -C "$repo" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  if [[ -n $from ]]; then echo "基準：上一個發布版本 $from"; else from=$BASELINE_COMMIT; echo "基準：還沒有發布 tag，使用 commit $from"; fi
else
  echo "基準：$from"
fi
sha=$(git -C "$repo" rev-parse --verify --quiet "$from^{commit}") || { echo "找不到基準：$from（淺層 clone 要先 git fetch --tags --unshallow）" >&2; exit 2; }
git -C "$repo" cat-file -e "$sha:packages/backend/db/schema.sql" 2>/dev/null || { echo "基準 $from 沒有 packages/backend/db/schema.sql" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/onden-upgrade-drill.XXXXXX")
container="" src_db="" admin_url="" drill_url=""
# shellcheck disable=SC2329  # runs via trap
cleanup() {
  local rc=$?
  set +e
  [[ -n $container ]] && docker rm -f "$container" >/dev/null 2>&1
  [[ -n $src_db ]] && psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$src_db\" WITH (FORCE)" >/dev/null 2>&1
  if [[ $rc -eq 0 ]]; then rm -rf "$work"; else echo "（暫存留在 $work）"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

url_for() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$1" "$2"; }

# 基準 schema
git -C "$repo" show "$sha:packages/backend/db/schema.sql" >"$work/base-schema.sql"
if [[ $strip == 1 ]]; then
  # shellcheck disable=SC1003  # the final \\ is a regex, not an escaped quote
  grep -v -E '^CREATE EXTENSION IF NOT EXISTS (age|pgroonga|vector)|^COMMENT ON EXTENSION (age|pgroonga|vector)|pgroonga \(|USING hnsw|transaction_timeout|^\\' \
    "$work/base-schema.sql" | sed 's/public\.vector(384)/text/' >"$work/schema.sql"
else
  cp "$work/base-schema.sql" "$work/schema.sql"
fi

# 規則：目前的程式必須認得基準裡所有已套用的 migration（不可刪除或改名舊 migration）。
echo "== 1. 基準的 migration 都還在"
current_versions=$(ls "$repo/packages/backend/db/migrations" | sed -n 's/\.sql$//p')
base_versions=$(sed -n "s/.*VALUES ('\([^']*\)').*/\1/p" "$work/base-schema.sql")
missing=$(comm -23 <(sort <<<"$base_versions") <(sort <<<"$current_versions") || true)
if [[ -n $missing ]]; then
  echo "✗ 基準已套用、目前卻找不到的 migration：" >&2; sed 's/^/    /' <<<"$missing" >&2
  echo "  舊 migration 不可刪除或改名；否則已升級過的資料庫會被判定為「比程式新」而拒絕啟動。" >&2
  exit 1
fi
echo "✓ 基準 $(wc -l <<<"$base_versions" | tr -d ' ') 個 migration 都在；目前共 $(wc -l <<<"$current_versions" | tr -d ' ') 個"

# 來源資料庫（只用來產生備份）
echo "== 2. 以基準 schema 建立資料庫並放入合成資料"
if [[ $use_docker == 1 ]]; then
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "沒有可用的 Docker；改用 --no-docker --database-url" >&2; exit 2; }
  suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n'); container="onden-updrill-$suffix"; src_db="o${suffix}_drill"
  pw=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  docker build -q -t onden-drill-postgres:local "$repo/docker/postgres" >/dev/null
  docker run -d --name "$container" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB="$src_db" \
    onden-drill-postgres:local postgres -c "shared_preload_libraries=pg_stat_statements" >/dev/null
  for _ in $(seq 1 90); do docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$src_db" >/dev/null 2>&1 && break; sleep 1; done
  port=$(docker port "$container" 5432/tcp | head -n1 | sed 's/.*://')
  src_url="postgres://postgres:$pw@127.0.0.1:$port/$src_db"
else
  admin_url=$(url_for "$db_url_arg" postgres)
  host=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$db_url_arg")
  case $host in ""|localhost|127.0.0.1|"[::1]") ;; *) echo "拒絕連線到非本機主機：$host" >&2; exit 2 ;; esac
  src_db="updrill_src_$$_drill"
  psql "$admin_url" -qc "CREATE DATABASE \"$src_db\"" || { echo "無法建立 $src_db" >&2; exit 2; }
  src_url=$(url_for "$db_url_arg" "$src_db")
  drill_url=$(url_for "$db_url_arg" "updrill_$$_drill")
fi
psql "$src_url" -q -v ON_ERROR_STOP=1 -f "$work/schema.sql" >/dev/null || { echo "✗ 基準 schema 載入失敗" >&2; exit 1; }
# 合成資料用基準自己的版本（欄位與當時的 schema 一致）；基準太舊沒有時才用目前的。
seed="$work/seed.sql"
git -C "$repo" show "$sha:packages/backend/scripts/drillSyntheticSeed.sql" >"$seed" 2>/dev/null \
  || cp "$repo/packages/backend/scripts/drillSyntheticSeed.sql" "$seed"
psql "$src_url" -q -v ON_ERROR_STOP=1 -f "$seed" >/dev/null || { echo "✗ 合成資料放不進基準 schema（種子與基準版本不相容）" >&2; exit 1; }
echo "✓ 基準資料庫就緒"

# 備份目錄（restore-drill.sh 的輸入形狀）
mkdir -p "$work/backup" "$work/content/media"
pg_dump -Fc "$src_url" >"$work/backup/database.dump"
for id in $(psql "$src_url" -Atc "SELECT DISTINCT (regexp_matches(markdown || ' ' || coalesce((SELECT string_agg(value,' ') FROM node_attributes a WHERE a.node_id = c.id),''), '/api/media/([0-9a-f]{32}\.[a-z]+)', 'g'))[1] FROM content_nodes c"); do
  printf 'synthetic bytes for %s\n' "$id" >"$work/content/media/$id"
done
tar -C "$work/content" -cf "$work/backup/content.tar" .
(cd "$work/backup" && sha256sum database.dump content.tar >SHA256SUMS)

echo "== 3. 升到目前的 migration（restore-drill.sh）"
if [[ $use_docker == 1 ]]; then
  "$repo/scripts/restore-drill.sh" "$work/backup"
else
  "$repo/scripts/restore-drill.sh" "$work/backup" --no-docker --database-url "$drill_url"
fi
