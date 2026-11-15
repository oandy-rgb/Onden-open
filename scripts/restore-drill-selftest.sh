#!/usr/bin/env bash
# 還原演練的自我測試：用合成資料做一份備份，確認演練「通過時會過、有問題時會擋」。
# 用本機 PostgreSQL（--no-docker 模式；沒有 age / pgroonga / vector，合成 schema 已去掉）。
#
#   scripts/restore-drill-selftest.sh postgres://user:pass@localhost:5432/postgres
#
# 帳號需能建立／刪除資料庫。只動名稱以 _drill 結尾的資料庫，且只連本機。
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
admin_url=${1:?用法：$0 <本機 PostgreSQL 管理網址，資料庫 postgres>}
work=$(mktemp -d "${TMPDIR:-/tmp}/onden-drill-selftest.XXXXXX")
src_db="selftest_src_$$_drill"
export TMPDIR="$work"
trap 'psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$src_db\" WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

url_for() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$admin_url" "$1"; }
src_url=$(url_for "$src_db")

# 合成 schema：db/schema.sql 去掉本機沒有的 extension（age、pgroonga、vector）和依賴它們的索引／欄位型別。
# shellcheck disable=SC1003  # the final \\ is a regex, not an escaped quote
grep -v -E '^CREATE EXTENSION IF NOT EXISTS (pgroonga|vector)|^COMMENT ON EXTENSION (pgroonga|vector)|pgroonga \(|USING hnsw|transaction_timeout|^\\' \
  "$repo/packages/backend/db/schema.sql" | sed 's/public\.vector(384)/text/' >"$work/schema.sql"

psql "$admin_url" -qc "CREATE DATABASE \"$src_db\""
psql "$src_url" -q -v ON_ERROR_STOP=1 -f "$work/schema.sql" >/dev/null
psql "$src_url" -q -v ON_ERROR_STOP=1 -f "$repo/packages/backend/scripts/drillSyntheticSeed.sql" >/dev/null

# 備份：與 backup-vps.sh 同形（database.dump、content.tar、SHA256SUMS）。content.tar 放每個被引用的媒體檔。
make_backup() { # <dir> [省略的媒體檔]
  local dir=$1 skip=${2:-}
  mkdir -p "$dir" "$dir.content/media"
  pg_dump -Fc "$src_url" >"$dir/database.dump"
  for id in $(psql "$src_url" -Atc "SELECT DISTINCT (regexp_matches(markdown || ' ' || coalesce((SELECT string_agg(value,' ') FROM node_attributes a WHERE a.node_id = c.id),''), '/api/media/([0-9a-f]{32}\.[a-z]+)', 'g'))[1] FROM content_nodes c"); do
    [[ $id == "$skip" ]] || printf 'synthetic bytes for %s\n' "$id" >"$dir.content/media/$id"
  done
  tar -C "$dir.content" -cf "$dir/content.tar" .
  (cd "$dir" && sha256sum database.dump content.tar >SHA256SUMS)
}
make_backup "$work/good"
missing_id=$(printf '%032x.png' 6)
make_backup "$work/missing-media" "$missing_id"

# 假的 migration：用 git plumbing 做一個只存在於物件庫的 commit（不動工作樹、不建分支）。
fake_commit() { # <migration sql>
  local blob idx="$work/index.$RANDOM" tree
  blob=$(printf '%s\n' "$1" | git -C "$repo" hash-object -w --stdin)
  GIT_INDEX_FILE=$idx git -C "$repo" read-tree HEAD
  GIT_INDEX_FILE=$idx git -C "$repo" update-index --add --cacheinfo "100644,$blob,packages/backend/db/migrations/999_drill_selftest.sql"
  tree=$(GIT_INDEX_FILE=$idx git -C "$repo" write-tree)
  git -C "$repo" commit-tree "$tree" -p HEAD -m "drill selftest"
}

fails=0
run_case() { # <名稱> <預期結束碼> <預期輸出片段> <備份目錄> [演練參數…]
  local name=$1 want=$2 pattern=$3 backup=$4; shift 4
  local out rc=0
  out=$("$repo/scripts/restore-drill.sh" "$backup" --no-docker --database-url "$(url_for "st_${RANDOM}_drill")" "$@" 2>&1) || rc=$?
  if [[ $rc == "$want" ]] && grep -q -- "$pattern" <<<"$out"; then
    printf 'PASS  %s（結束碼 %s）\n' "$name" "$rc"
  else
    printf 'FAIL  %s（結束碼 %s，預期 %s，找「%s」）\n' "$name" "$rc" "$want" "$pattern"; fails=$((fails + 1))
  fi
  printf '%s\n' "$out" | sed 's/^/        /'
}

run_case "通過：沒有新 migration（含 bootstrap 讀取）" 0 "bootstrap 讀取成功" "$work/good" --bootstrap
run_case "通過：無害的新 migration" 0 "通過：還原演練沒有發現問題" "$work/good" \
  --commit "$(fake_commit 'CREATE TABLE drill_harmless (id int);')"
run_case "擋下：migration 刪掉一個標籤" 1 "標籤數量" "$work/good" \
  --commit "$(fake_commit "DELETE FROM content_nodes WHERE slug = 'tag-school';")"
run_case "擋下：migration 改寫筆記內文" 1 "內文雜湊改變" "$work/good" \
  --commit "$(fake_commit "UPDATE content_nodes SET markdown = markdown || ' x' WHERE slug = 'note-3';")"
run_case "擋下：migration 把筆記丟進垃圾桶" 1 "現行節點消失" "$work/good" \
  --commit "$(fake_commit "UPDATE content_nodes SET deleted_at = now() WHERE slug = 'note-4';")"
run_case "擋下：migration 讓標籤套用指向不存在的標籤" 1 "套用的標籤不存在" "$work/good" \
  --commit "$(fake_commit "SET LOCAL session_replication_role = replica; UPDATE node_tags SET tag_id = gen_random_uuid() WHERE node_id = (SELECT id FROM content_nodes WHERE slug = 'note-7');")"
run_case "列出但通過：migration 聲明改寫內文" 0 "已聲明 note-bodies" "$work/good" \
  --commit "$(fake_commit "-- drill: allows note-bodies
UPDATE content_nodes SET markdown = markdown || ' x' WHERE slug = 'note-3';")"
run_case "擋下：migration 本身失敗" 1 "migration 失敗：999_drill_selftest" "$work/good" \
  --commit "$(fake_commit "SELECT 1/0;")"
run_case "擋下：content.tar 少一個被引用的媒體檔" 1 "不在 content.tar" "$work/missing-media"

# 備份檔被改動：SHA256SUMS 必須擋下。
cp -r "$work/good" "$work/tampered"; printf 'x' >>"$work/tampered/content.tar"
run_case "擋下：備份檔被改動" 1 "SHA256SUMS 驗證失敗" "$work/tampered"

# 護欄：資料庫名稱不是 _drill，或不在本機。
for bad in "postgres://u:p@localhost:5432/onden" "postgres://u:p@db.example.com:5432/x_drill"; do
  rc=0; out=$("$repo/scripts/restore-drill.sh" "$work/good" --no-docker --database-url "$bad" 2>&1) || rc=$?
  if [[ $rc == 2 ]] && grep -q "拒絕\|必須以 _drill" <<<"$out"; then printf 'PASS  拒絕 %s\n' "$bad"; else printf 'FAIL  沒有拒絕 %s\n' "$bad"; fails=$((fails + 1)); fi
done

if [[ $fails == 0 ]]; then printf '\n自我測試全部通過\n'; else printf '\n自我測試有 %s 項失敗\n' "$fails"; exit 1; fi
