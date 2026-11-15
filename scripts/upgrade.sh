#!/usr/bin/env bash
# ── Onden upgrade / rollback (self-hosted compose stack) ─────────────────
#   scripts/upgrade.sh <version>     upgrade to a release (backup first)
#   scripts/upgrade.sh rollback      go back to the version before the last upgrade
#   scripts/rollback.sh              same as the line above
#   scripts/upgrade.sh --help
#
# Why this exists: migrations run when the backend boots and only go forward.
# Rolling the image back does not roll the database back (the old backend then
# refuses to start, see db.ts DatabaseNewerThanCodeError). So an upgrade first
# takes a backup that the rollback restores.
#
# The running version is the ONDEN_VERSION variable in .env; compose uses it as
# the image tag. This script only writes that one line and runs docker compose.
#
# Environment:
#   ENV_FILE            default <repo>/.env
#   ONDEN_BACKUP_DIR    read from .env too; default <repo>/backups
#   HEALTH_TIMEOUT_S    how long to wait for the backend (default 180)
set -euo pipefail

VERSION_VAR=ONDEN_VERSION
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

usage() {
  cat <<'EOF2'
Usage:
  scripts/upgrade.sh <version>   upgrade (takes a backup first; aborts if it fails)
  scripts/upgrade.sh rollback    restore the backup taken before an upgrade
  scripts/rollback.sh            same as "upgrade.sh rollback"

See docs/self-host/upgrade.md.
EOF2
}

compose() { docker compose -f "$REPO_ROOT/compose.yaml" --env-file "$ENV_FILE" "$@"; }
say() { printf '%s\n' "$*"; }
die() { printf '錯誤：%s\n' "$*" >&2; exit 1; }

env_get() { # env_get <NAME> -> value or empty
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/^[\"']//; s/[\"']$//"
}
env_set() { # env_set <NAME> <value>
  touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    sed "s|^$1=.*|$1=$2|" "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp" # keep the file's mode and owner
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

backup_dir() {
  local d; d="$(env_get ONDEN_BACKUP_DIR)"; d="${d:-${ONDEN_BACKUP_DIR:-./backups}}"
  case "$d" in /*) printf '%s' "$d" ;; *) printf '%s' "$REPO_ROOT/${d#./}" ;; esac
}

need_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
    || die "找不到 docker compose，請先安裝 Docker。"
}

wait_healthy() { # 0 = backend answered /health; 1 = gave up
  local waited=0
  while (( waited < HEALTH_TIMEOUT_S )); do
    if compose exec -T backend node -e \
      "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

explain_unhealthy() {
  say ""
  say "後端在 ${HEALTH_TIMEOUT_S} 秒內沒有回應。最近的紀錄："
  compose logs --no-color --tail 30 backend 2>&1 || true
}

# ── upgrade ──────────────────────────────────────────────────────────────
do_upgrade() {
  local target="$1" current
  [[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "版本名稱不合法：$target"
  need_docker
  current="$(env_get "$VERSION_VAR")"
  current="${current:-unknown}"
  say "目前版本：$current"
  say "目標版本：$target"
  [[ "$current" != "$target" ]] || die "已經是 $target，不需要升級。"

  compose ps --status running --services 2>/dev/null | grep -qx postgres \
    || die "資料庫（postgres）沒有在執行，無法備份。請先 docker compose up -d，確認正常後再升級。"

  say ""
  say "步驟 1/4：升級前備份（資料庫與上傳檔案）…"
  local out stamp
  if ! out="$(compose run --rm --no-deps -T backup once "pre-upgrade from=$current to=$target" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "備份失敗，沒有動任何東西（版本與服務都維持原樣）。請先排除備份問題（磁碟空間？資料庫狀態？）再升級。"
  fi
  printf '%s\n' "$out"
  stamp="$(printf '%s\n' "$out" | sed -n 's/^\[backup\] STAMP=//p' | tail -n 1)"
  [[ -n "$stamp" ]] || die "備份看似完成但找不到備份編號，為安全起見中止（沒有動任何東西）。"

  say ""
  say "步驟 2/4：下載新版本映像…"
  env_set "$VERSION_VAR" "$target"
  if ! compose pull --ignore-buildable; then
    env_set "$VERSION_VAR" "$current"
    die "下載 $target 失敗（版本名稱打錯？網路？）。版本設定已還原為 $current，服務沒有被動過。"
  fi

  say ""
  say "步驟 3/4：重新啟動（新版本啟動時會自動套用資料庫更新）…"
  if ! compose up -d; then
    print_failure_help "$current" "$stamp"
    exit 1
  fi

  say ""
  say "步驟 4/4：等待後端就緒（最多 ${HEALTH_TIMEOUT_S} 秒）…"
  if wait_healthy; then
    say ""
    say "✓ 升級完成：$current → $target"
    say "  升級前備份編號：$stamp（在 $(backup_dir)）"
    say "  若發現問題想退回：scripts/rollback.sh（會蓋掉升級後寫入的資料，執行前會再確認）"
  else
    explain_unhealthy
    print_failure_help "$current" "$stamp"
    exit 1
  fi
}

print_failure_help() { # <old version> <stamp>
  cat >&2 <<EOF2

✗ 升級沒有成功。你的資料有一份升級前的備份（編號 $2，位於 $(backup_dir)）。
  要退回 $1：
    scripts/rollback.sh
  它會列出升級前備份、請你確認後還原，並切回 $1。
  注意：還原會蓋掉升級之後寫入的資料。
  如果只是暫時性問題（網路、磁碟滿了），排除後可以再執行一次：
    scripts/upgrade.sh <版本>
EOF2
}

# ── rollback ─────────────────────────────────────────────────────────────
do_rollback() {
  need_docker
  local dir; dir="$(backup_dir)"
  local -a stamps=() froms=() tos=()
  local note stamp from to f
  # Newest first; only backups upgrade.sh made (they carry a pre-upgrade note
  # and both files), so a scheduled backup is never offered as "the old version".
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    note="$(head -n 1 "$f")"
    [[ "$note" == pre-upgrade\ from=*\ to=* ]] || continue
    stamp="$(basename "$f" .note.txt)"; stamp="${stamp#onden-}"
    [[ -f "$dir/onden-$stamp.sql.gz" && -f "$dir/onden-content-$stamp.tar.gz" ]] || continue
    from="${note#*from=}"; from="${from%% *}"; to="${note##*to=}"
    stamps+=("$stamp"); froms+=("$from"); tos+=("$to")
  done < <(ls -1 "$dir"/onden-[0-9]*.note.txt 2>/dev/null | sort -r)

  (( ${#stamps[@]} > 0 )) || die "在 $dir 找不到升級前備份。只有 scripts/upgrade.sh 做的備份可以用來回退；其他備份請用 scripts/restore.sh。"

  say "可用的升級前備份（新→舊）："
  local i
  for i in "${!stamps[@]}"; do
    say "  $((i + 1))) ${stamps[$i]}  升級前是 ${froms[$i]}，升到 ${tos[$i]}"
  done
  local pick=1
  if (( ${#stamps[@]} > 1 )); then
    read -r -p "要還原哪一份？輸入編號（預設 1）： " pick
    pick="${pick:-1}"
    [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#stamps[@]} )) || die "沒有這個編號：$pick"
  fi
  local sel=$((pick - 1))
  stamp="${stamps[$sel]}"; from="${froms[$sel]}"; to="${tos[$sel]}"

  cat <<EOF2

═══ 請注意 ═══
回退會做這些事：
  1. 停止 Onden 服務（網站暫時打不開）
  2. 把資料庫與上傳檔案還原成 $stamp 那一刻的樣子
  3. 切回版本 $from 並啟動
還原會「蓋掉」那一刻之後寫入的所有資料（新筆記、修改、上傳）。
為了不讓這些資料憑空消失，會先另外存一份「回退前」備份到 $dir，需要時還能找回。
EOF2
  read -r -p "確定要回退嗎？輸入 yes 繼續，其他任何輸入都會取消： " answer
  [[ "$answer" == "yes" ]] || die "已取消，沒有動任何東西。"

  compose ps --status running --services 2>/dev/null | grep -qx postgres \
    || compose up -d postgres
  say ""
  say "步驟 1/5：保存回退前的現況（以防反悔）…"
  local out
  if ! out="$(compose run --rm --no-deps -T backup once "pre-rollback current=${to}" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "回退前備份失敗，為安全起見中止，沒有動任何東西。"
  fi

  say "步驟 2/5：停止服務…"
  local -a others
  mapfile -t others < <(compose config --services | grep -vx postgres)
  compose stop "${others[@]}"

  say "步驟 3/5：還原資料庫…"
  "$SCRIPT_DIR/restore.sh" "$dir/onden-$stamp.sql.gz" --yes

  say "步驟 4/5：還原上傳檔案…"
  gunzip -c "$dir/onden-content-$stamp.tar.gz" \
    | compose run --rm --no-deps -T --entrypoint sh backend -c 'tar -xzf - -C /app/packages/backend'

  say "步驟 5/5：切回 $from 並啟動…"
  [[ "$from" == "unknown" ]] || env_set "$VERSION_VAR" "$from"
  [[ "$from" != "unknown" ]] || say "（升級前沒有記錄版本，.env 的 $VERSION_VAR 沒有改，請自行確認要用哪個版本。）"
  compose pull --ignore-buildable || true
  compose up -d
  if wait_healthy; then
    say ""
    say "✓ 已回退到 $from，資料是 $stamp 的樣子。"
  else
    explain_unhealthy
    die "服務啟動後後端沒有回應。資料已還原；請查看上面的紀錄，或參考 docs/self-host/upgrade.md。"
  fi
}

case "${1:-}" in
  ""|--help|-h) usage; [[ -n "${1:-}" ]] || exit 1 ;;
  rollback) do_rollback ;;
  -*) usage >&2; exit 1 ;;
  *) do_upgrade "$1" ;;
esac
