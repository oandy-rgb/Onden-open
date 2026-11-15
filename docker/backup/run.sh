#!/bin/sh
# ── Scheduled backup (compose service `backup`) ──────────────────────────
# Every BACKUP_INTERVAL_HOURS (default 24) writes the same two files
# scripts/backup.sh does, so scripts/restore.sh restores either:
#   /backups/onden-<UTC>.sql.gz          pg_dump --clean --if-exists --no-owner
#   /backups/onden-content-<UTC>.tar.gz  the content volume (media + git store)
# Keeps the newest BACKUP_KEEP (default 14) of each kind; old ones are removed
# only after a new backup succeeded, so a failing run never eats history.
#
# `run.sh once [note]` takes one backup right now and exits (0 = both files
# written and the dump passes `gzip -t`, non-zero = nothing usable). It never
# prunes and is used by scripts/upgrade.sh right before a new version's
# migrations run. The optional note (e.g. "pre-upgrade v1.2.0->v1.3.0") goes
# into onden-<UTC>.note.txt next to the dump, which scripts/rollback.sh lists.
# The last stdout line is `[backup] STAMP=<UTC>` so a caller can find the files.
#
# A restart (redeploy, reboot) does not take an extra backup: the first run
# waits until the newest dump is BACKUP_INTERVAL_HOURS old.
set -eu
umask 077

INTERVAL_S=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
[ "$INTERVAL_S" -ge 3600 ] || INTERVAL_S=3600
KEEP=${BACKUP_KEEP:-14}
OUT=/backups

prune() { # prune <glob>
  # Our own timestamped names: no spaces, name order = time order.
  ls -1 $OUT/$1 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "[backup] pruning $old"
    rm -f "$old"
  done
}

backup_once_files() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  sql="$OUT/onden-$ts.sql.gz"
  # set -e does not see a failure on the left of a pipe in POSIX sh, so check
  # pg_dump's status through a marker file.
  rm -f "$OUT/.pgdump-failed"
  { pg_dump -h postgres -U onden -d onden --clean --if-exists --no-owner || touch "$OUT/.pgdump-failed"; } \
    | gzip > "$sql.partial"
  if [ -e "$OUT/.pgdump-failed" ]; then
    rm -f "$sql.partial" "$OUT/.pgdump-failed"
    echo "[backup] ERROR: pg_dump failed; keeping the previous backups" >&2
    return 1
  fi
  mv "$sql.partial" "$sql"
  echo "[backup] wrote $sql ($(du -h "$sql" | cut -f1))"

  content="$OUT/onden-content-$ts.tar.gz"
  # site-bundles is the stored static copy of the site: made again on demand,
  # and a copy of the media and pages already in the database and media/.
  # Explicit check: callers run this under `||`, where set -e is off.
  tar -czf "$content.partial" --exclude=content/site-bundles -C /content-src content || {
    rm -f "$content.partial"
    echo "[backup] ERROR: tar of the content volume failed" >&2
    return 1
  }
  mv "$content.partial" "$content"
  echo "[backup] wrote $content ($(du -h "$content" | cut -f1))"

  # The container runs as root; hand the files to whoever owns the backups
  # directory so restore.sh and off-host copies work without sudo.
  chown "$(stat -c %u:%g "$OUT")" "$sql" "$content"
}

backup_once() {
  backup_once_files || return 1
  prune "onden-[0-9]*.sql.gz"
  prune "onden-content-*.tar.gz"
  # A note outlives nothing: drop notes whose dump was pruned.
  for note in $OUT/onden-[0-9]*.note.txt; do
    [ -e "$note" ] || continue
    [ -e "${note%.note.txt}.sql.gz" ] || rm -f "$note"
  done
}

# Manual backup for scripts/upgrade.sh. No pruning: a failed or repeated
# upgrade must never delete the very backup it may need to roll back to.
backup_now() {
  note=${1:-}
  backup_once_files || return 1
  gzip -t "$sql" || { echo "[backup] ERROR: $sql failed gzip -t" >&2; return 1; }
  tar -tzf "$content" >/dev/null || { echo "[backup] ERROR: $content failed tar -t" >&2; return 1; }
  [ -z "$note" ] || printf '%s\n' "$note" > "${sql%.sql.gz}.note.txt"
  chown "$(stat -c %u:%g "$OUT")" "${sql%.sql.gz}.note.txt" 2>/dev/null || true
  echo "[backup] STAMP=$ts"
}

newest_age_s() {
  newest=$(ls -1 $OUT/onden-[0-9]*.sql.gz 2>/dev/null | sort -r | head -n 1)
  [ -n "$newest" ] || { echo "$INTERVAL_S"; return; }
  echo $(( $(date +%s) - $(stat -c %Y "$newest") ))
}

mkdir -p "$OUT"
if [ "${1:-}" = "once" ]; then
  rm -f "$OUT"/*.partial "$OUT/.pgdump-failed"
  backup_now "${2:-}"
  exit $?
fi
# A run killed mid-dump (container stop) leaves a .partial behind.
rm -f "$OUT"/*.partial "$OUT/.pgdump-failed"
age=$(newest_age_s)
if [ "$age" -lt "$INTERVAL_S" ]; then
  wait_s=$(( INTERVAL_S - age ))
  echo "[backup] newest backup is ${age}s old; next run in ${wait_s}s"
  sleep "$wait_s"
fi
while :; do
  backup_once || true
  sleep "$INTERVAL_S"
done
