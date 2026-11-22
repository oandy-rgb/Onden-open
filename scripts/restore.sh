#!/usr/bin/env bash
# ── Onden restore ────────────────────────────────────────────────────────
# Puts a backup back as the database the backend uses: a scripts/backup.sh dump
# (onden-<ts>.sql.gz), a pg_dump -Fc archive (database.dump), or a
# scripts/backup-vps.sh folder (manual-<ts>/, its SHA256SUMS checked). Into the
# compose stack's Postgres (service `postgres`, db/user `onden`; for another
# stack set ONDEN_COMPOSE_PROJECT / ONDEN_ENV_FILE / ONDEN_COMPOSE_FILE /
# ONDEN_DOCKER_SUDO=1, as scripts/restore-vps.sh does), or DATABASE_URL if set.
#
# How (docs/agents/deploy.md「還原」), so that nothing can end half-done:
#   1. the whole backup is read once and checked BEFORE anything is touched:
#      it decompresses, it ends with pg_dump's "dump complete" line;
#   2. it is loaded into a NEW database (<name>_restoring), never into the live
#      one, and the node-id step below runs there;
#   3. only when all of that succeeded are the two swapped, by name, in one
#      transaction. The database that was replaced stays, renamed
#      <name>_before_restore_<UTC time>: the safety copy (drop it yourself once
#      you are satisfied; the script prints how).
# Any failure, a refused node-id step, or an interrupted run leaves the live
# database exactly as it was (at worst a <name>_restoring is left over; the
# next run drops it).
#
# The node id (scripts/lib/renewNodeId.sql, migration 213): the backup brought
# back the node id and the write numbers the server had when it was backed up;
# the server went on numbering after that, so the restored database takes a new
# id and keeps the backup's id as a former origin ('self-restore'); the id of
# the database it replaces is kept as a former origin too if it was another
# one. A backup older than migration 213 gets the migrations' own functions
# first. Where the rule cannot hold — a backup from migrations 190 to 205 (no
# table to record its old id in), or one with no node id replacing a database
# that has one — the restore is refused, unless --keep-node-id says to put it
# back anyway: then the database keeps the id it has, the script says loudly
# what that means, and the database records it (sync_restore_kept_node_id) so
# that the device-exchange code can refuse to exchange until it is joined again.
#
# Stop the backend first: the swap needs nobody connected to the database
# (the script checks and refuses otherwise). Boot re-runs migrations, which is a
# no-op on a same-version backup and forward-migrates an older one.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh <backup> --yes [--keep-node-id] [--no-space-check]

<backup> is one of:
  backups/onden-<ts>.sql.gz   a scripts/backup.sh dump
  …/database.dump             a pg_dump -Fc archive
  …/manual-<ts>/              a scripts/backup-vps.sh folder (SHA256SUMS checked)

Restores into the compose `postgres` service (db onden), or into DATABASE_URL
if that env var is set. Other compose stacks: ONDEN_COMPOSE_PROJECT,
ONDEN_ENV_FILE, ONDEN_COMPOSE_FILE, ONDEN_DOCKER_SUDO=1 (scripts/restore-vps.sh).

The backup is checked first, loaded into a new database, and swapped in only
when everything succeeded; the replaced database is kept as
<name>_before_restore_<time> (not when it held no workspace: an empty schema).
On any failure nothing is changed. Two restores of the same database at once:
the second is refused.

Old backups with Apache AGE (before 2026-11): its schema, extension and data
(ag_catalog) are left out, as scripts/restore-drill.sh does
(scripts/lib/strip-age.sed).

The restored database takes a new node id (the writes it holds keep the old
one, which it records as a former id). A backup that cannot be given a new id
(made by migrations 190 to 205; or one without any node id replacing a
database that has one) is refused, unless:
  --keep-node-id    restore it anyway, keeping the node id it has. This server
                    then must not exchange with devices that hold its old
                    numbers until they join it again; the database records
                    this (table sync_restore_kept_node_id).
  --no-space-check  skip the free-disk check (compose only).

Recommended sequence:
  docker compose stop backend
  scripts/restore.sh backups/onden-<ts>.sql.gz --yes
  docker compose start backend

Media/content volume: restore the matching onden-content-<ts>.tar.gz with
  gunzip -c backups/onden-content-<ts>.tar.gz | \
    docker compose exec -T backend tar -xzf - -C /app/packages/backend
EOF
}

BACKUP=""
CONFIRMED=0 KEEP_ID=0 SPACE_CHECK=1
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --yes) CONFIRMED=1 ;;
    --keep-node-id) KEEP_ID=1 ;;
    --no-space-check) SPACE_CHECK=0 ;;
    -*) echo "ERROR: unknown flag: $arg" >&2; usage >&2; exit 1 ;;
    *) BACKUP="$arg" ;;
  esac
done
[[ -n "$BACKUP" ]] || { usage >&2; exit 1; }

# ── what kind of backup
SUMS=""
if [[ -d "$BACKUP" ]]; then
  [[ -f "$BACKUP/database.dump" ]] || { echo "ERROR: $BACKUP has no database.dump (a scripts/backup-vps.sh folder has database.dump, content.tar, SHA256SUMS)" >&2; exit 1; }
  [[ -f "$BACKUP/SHA256SUMS" ]] && SUMS="$BACKUP/SHA256SUMS"
  BACKUP="$BACKUP/database.dump"
fi
[[ -f "$BACKUP" ]] || { echo "ERROR: backup not found: $BACKUP" >&2; exit 1; }
case "$BACKUP" in
  *.sql.gz) FORMAT=plain ;;
  *.dump) FORMAT=custom
          [[ -n $SUMS || ! -f "$(dirname "$BACKUP")/SHA256SUMS" ]] || SUMS="$(dirname "$BACKUP")/SHA256SUMS" ;;
  *) echo "ERROR: expected onden-<ts>.sql.gz (scripts/backup.sh), database.dump (pg_dump -Fc) or a manual-<ts>/ folder, got: $BACKUP" >&2; exit 1 ;;
esac
if [[ "$CONFIRMED" != 1 ]]; then
  echo "ERROR: refusing to restore without --yes." >&2
  echo "       This replaces the database the backend uses (the replaced one is kept as a renamed copy)." >&2
  echo "       Run: scripts/restore.sh $BACKUP --yes" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib/renewNodeId.sh
source "$SCRIPT_DIR/lib/renewNodeId.sh"
[[ -f $RENEWAL_SQL ]] || { echo "ERROR: $RENEWAL_SQL is missing; a restore cannot give the database a new node id without it. Nothing was changed." >&2; exit 1; }

# 舊備份含 Apache AGE（現在的映像沒有）：scripts/lib/strip-age.sed 是唯一的一份規則。純 SQL 逐行過濾；-Fc 過濾 pg_restore -l 的目錄、
# 再用 -L 只還原其餘項目（與 scripts/restore-drill.sh 同一種做法）。
strip_age() { sed -f "$SCRIPT_DIR/lib/strip-age.sed"; }

# ── where the database is: psql_on <db> … runs psql on that database; tool <cmd> … runs pg_restore where the server is
STAMP="${ONDEN_RESTORE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ $STAMP =~ ^[0-9A-Za-z]+$ ]] || { echo "ERROR: ONDEN_RESTORE_STAMP must be letters and digits" >&2; exit 1; }
if [[ -n "${DATABASE_URL:-}" ]]; then
  for t in psql pg_restore; do
    [[ $t == pg_restore && $FORMAT == plain ]] && continue
    command -v "$t" >/dev/null 2>&1 || { echo "ERROR: DATABASE_URL is set but $t is not installed on this host." >&2; exit 1; }
  done
  [[ $DATABASE_URL =~ ^(postgres(ql)?://[^/?#]*)/([^/?#]+)(\?.*)?$ ]] || { echo "ERROR: DATABASE_URL must name a database (postgres://…/<name>)" >&2; exit 1; }
  url_base=${BASH_REMATCH[1]} TARGET=${BASH_REMATCH[3]} url_query=${BASH_REMATCH[4]:-}
  psql_on() { local db=$1; shift; psql "$url_base/$db$url_query" "$@"; }
  tool() { "$@"; }
  where="DATABASE_URL (host psql)" # never print the URL itself: it carries the password
else
  compose_args=(-f "${ONDEN_COMPOSE_FILE:-$REPO_ROOT/compose.yaml}")
  [[ -z "${ONDEN_COMPOSE_PROJECT:-}" ]] || compose_args=(-p "$ONDEN_COMPOSE_PROJECT" "${compose_args[@]}")
  [[ -z "${ONDEN_ENV_FILE:-}" ]] || compose_args=(--env-file "$ONDEN_ENV_FILE" "${compose_args[@]}")
  docker_cmd=(docker); [[ "${ONDEN_DOCKER_SUDO:-0}" != 1 ]] || docker_cmd=(sudo docker)
  compose() { "${docker_cmd[@]}" compose "${compose_args[@]}" "$@"; }
  if ! command -v docker >/dev/null 2>&1 || ! "${docker_cmd[@]}" compose version >/dev/null 2>&1; then
    echo "ERROR: docker compose is not available. Install docker (with the compose plugin) or set DATABASE_URL." >&2
    exit 1
  fi
  if ! compose ps --status running --services 2>/dev/null | grep -qx postgres; then
    echo "ERROR: the compose 'postgres' service is not running." >&2
    echo "       Start it first: docker compose up -d postgres" >&2
    exit 1
  fi
  TARGET=onden
  psql_on() { local db=$1; shift; compose exec -T postgres psql -U onden -d "$db" "$@"; }
  tool() { compose exec -T postgres "$@"; }
  where="compose service postgres (db onden)"
fi
RESTORING="${TARGET}_restoring" REPLACED="${TARGET}_before_restore_${STAMP}"
# Postgres cuts names longer than 63 bytes (with only a NOTICE): a cut name would make the swap's check ask for a database that is not there
if (( $(LC_ALL=C; printf '%s' "$REPLACED" | wc -c) > 63 )); then
  echo "ERROR: the database name $TARGET is too long for its copy's name ($REPLACED is over the 63 bytes Postgres allows). Nothing was changed." >&2; exit 1
fi

# one restore of a database at a time (a second one would drop the first's ${TARGET}_restoring under it): a lock directory on this host,
# named after where the database is (never the password); a lock whose process is gone is taken over
if [[ -n "${DATABASE_URL:-}" ]]; then lock_key="url ${url_base#*@} $TARGET"; else lock_key="compose ${compose_args[*]}"; fi
LOCK="${TMPDIR:-/tmp}/onden-restore-$(printf '%s' "$lock_key" | cksum | cut -d' ' -f1).lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [[ $holder =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
    echo "ERROR: another restore of this database is running (process $holder). Nothing was changed." >&2; exit 1
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { echo "ERROR: another restore of this database is starting. Nothing was changed." >&2; exit 1; }
fi
echo $$ >"$LOCK/pid"
out="" err=""
cleanup() { rm -f "$out" "$err"; drop_toc_list; rm -rf "$LOCK"; }
drop_toc_list() { :; }
trap cleanup EXIT
admin() { psql_on postgres -X -At -v ON_ERROR_STOP=1 "$@"; }
ident() { printf '"%s"' "${1//\"/\"\"}"; }


# the backup as SQL text, on stdout; fails (non-zero) when it does not decompress or does not end with pg_dump's last line
backup_sql() {
  if [[ $FORMAT == plain ]]; then gunzip -c "$BACKUP" | strip_age; else tool pg_restore --no-owner -L "$toc_list" -f - <"$BACKUP"; fi \
    | awk '{ print } /^-- PostgreSQL database dump complete$/ { done = 1 } END { exit done ? 0 : 7 }'
}

# ── 1. check the backup, before anything is touched
if [[ -n $SUMS ]]; then
  (cd "$(dirname "$SUMS")" && sha256sum -c --quiet --ignore-missing "$(basename "$SUMS")") \
    || { echo "ERROR: $SUMS does not match the files: the backup is damaged or was changed. Nothing was changed." >&2; exit 1; }
  grep -q ' database.dump$' "$SUMS" || { echo "ERROR: $SUMS does not list database.dump. Nothing was changed." >&2; exit 1; }
fi
# -Fc: the archive's table of contents without AGE's entries, where pg_restore runs (the host, or the postgres container)
toc_list=""
if [[ $FORMAT == custom ]]; then
  toc=$(tool pg_restore -l <"$BACKUP" | strip_age) \
    || { echo "ERROR: the backup is damaged or incomplete (pg_restore cannot read its table of contents). Nothing was changed." >&2; exit 1; }
  if [[ -n "${DATABASE_URL:-}" ]]; then toc_list=$(mktemp); printf '%s\n' "$toc" >"$toc_list"
  else toc_list="/tmp/onden-restore-$STAMP.list"; printf '%s\n' "$toc" | tool sh -c 'cat >"$1"' _ "$toc_list" \
         || { echo "ERROR: could not write the table of contents into the postgres container. Nothing was changed." >&2; exit 1; }
  fi
fi
drop_toc_list() { [[ -z $toc_list ]] || { if [[ -n "${DATABASE_URL:-}" ]]; then rm -f "$toc_list"; else tool rm -f "$toc_list" >/dev/null 2>&1; fi; } || true; }
echo "[restore] checking $BACKUP"
sql_bytes=$(backup_sql | wc -c) \
  || { echo "ERROR: the backup is damaged or incomplete (it does not decompress, or it does not end with pg_dump's \"dump complete\" line). Nothing was changed." >&2; exit 1; }

# ── 2. the live database: nobody connected; its node id; room on the disk
read_failed() { echo "ERROR: could not read the target database ($where); nothing was changed." >&2; exit 1; }
exists=$(admin -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'") || read_failed
# sessions of people and programs only: an autovacuum worker or another background process of the server is not a connection that
# would keep writing, and the swap below does not wait for one
others=$(admin -c "SELECT string_agg(coalesce(nullif(application_name, ''), 'unnamed') || ' (' || coalesce(client_addr::text, 'local') || ')', ', ') FROM pg_stat_activity WHERE datname = '$TARGET' AND backend_type = 'client backend' AND pid <> pg_backend_pid()") || read_failed
[[ -z $others ]] || { echo "ERROR: connections are open to the database: $others. Stop what holds them first (the backend: docker compose stop backend; a backup running at the same time). Nothing was changed." >&2; exit 1; }
overwritten="" owner=""
if [[ $exists == 1 ]]; then
  owner=$(admin -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$TARGET'") || read_failed
  # a failed read must not look like "no node id": the replaced database's id would then not be recorded as a former one
  has_node=$(psql_on "$TARGET" -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.sync_node') IS NOT NULL") || read_failed
  case $has_node in
    t) overwritten=$(psql_on "$TARGET" -X -At -v ON_ERROR_STOP=1 -c "SELECT node_id FROM public.sync_node WHERE singleton") || read_failed ;;
    f) ;;
    *) read_failed ;;
  esac
fi
# the copies earlier restores kept: each is a whole database; say so before taking room for another
# a database that holds no workspace (the empty schema compose's postgres starts with) is not kept as a copy: there is nothing in it to go back to
empty_target=0
if [[ $exists == 1 ]]; then
  has_ws=$(psql_on "$TARGET" -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.workspaces') IS NOT NULL") || read_failed
  case $has_ws in
    f) empty_target=1 ;;
    t) n_ws=$(psql_on "$TARGET" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.workspaces") || read_failed; [[ $n_ws != 0 ]] || empty_target=1 ;;
    *) read_failed ;;
  esac
fi
copies=$(admin -c "SELECT string_agg(datname || ' ' || pg_size_pretty(pg_database_size(datname)), ', ' ORDER BY datname) FROM pg_database WHERE datname LIKE '${TARGET}\\_before\\_restore\\_%'") || read_failed
[[ -z $copies ]] || echo "[restore] copies kept by earlier restores (drop the ones you no longer need: DROP DATABASE \"<name>\";): $copies"
call=$(renewalCall "$overwritten" "$KEEP_ID") || { echo "ERROR: the target database has a node id this script does not recognise; nothing was changed." >&2; exit 1; }
if [[ $SPACE_CHECK == 1 && -n "${DATABASE_URL:-}" ]]; then
  echo "[restore] note: with DATABASE_URL the free disk of the database server is not checked; the restore needs about as much free space as the database takes, since the replaced one is kept."
elif [[ $SPACE_CHECK == 1 ]]; then
  db_bytes=0
  [[ $exists != 1 ]] || db_bytes=$(admin -c "SELECT pg_database_size('$TARGET')") || read_failed
  free_kb=$(compose exec -T postgres sh -c 'df -Pk "${PGDATA:-/var/lib/postgresql/data}" | tail -n 1' | awk '{ print $4 }') || free_kb=""
  # the new database is about as large as the larger of the two; while it loads, the server's WAL grows by up to as much again, bounded by
  # its checkpoints (max_wal_size, 1 GB by default): so the size, 10% over, and the WAL on top
  base=$(( db_bytes > sql_bytes ? db_bytes : sql_bytes )); wal=$(( base < 1073741824 ? base : 1073741824 ))
  need=$(( base * 11 / 10 + wal ))
  if [[ $free_kb =~ ^[0-9]+$ ]] && (( free_kb * 1024 < need )); then
    echo "ERROR: not enough free disk for the restore: it keeps the replaced database until you drop it, and the load writes WAL, so it needs about $((need / 1048576)) MB free; there are $((free_kb / 1024)) MB. Nothing was changed. (Drop copies of earlier restores, free space, or --no-space-check.)" >&2
    exit 1
  fi
fi

# ── 3. load into a new database and give it its node id there
echo "[restore] loading into a new database ($RESTORING on $where)"
# a <name>_restoring left by an interrupted run is this script's own scratch copy: dropped even if a dying session still holds it
admin -c "SET client_min_messages TO warning" -c "DROP DATABASE IF EXISTS $(ident "$RESTORING") WITH (FORCE)" >/dev/null || read_failed
admin -c "CREATE DATABASE $(ident "$RESTORING") TEMPLATE template0${owner:+ OWNER $(ident "$owner")}" >/dev/null \
  || { echo "ERROR: could not create the database $RESTORING (does this role have CREATEDB?). Nothing was changed." >&2; exit 1; }
out=$(mktemp) err=$(mktemp)
discard() { admin -c "DROP DATABASE IF EXISTS $(ident "$RESTORING") WITH (FORCE)" >/dev/null 2>&1 || true; }
# What an interruption says must be true (review of #1937, round 2, point 1): before the swap the live database is as it was; once the
# swap may have been sent, the server is asked which of the two happened.
phase=loading
swapped() { # 0 = the restored database has the name; 1 = it has not; 2 = cannot tell
  local r
  if [[ $exists == 1 ]]; then r=$(admin -c "SELECT count(*) FROM pg_database WHERE datname = '$REPLACED'" 2>/dev/null) || return 2
  else r=$(admin -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'" 2>/dev/null) || return 2; fi
  [[ $r == 1 ]] && return 0; [[ $r == 0 ]] && return 1; return 2
}
on_interrupt() {
  trap - INT TERM
  local state=1
  # not `swapped; state=$?`: under set -e a non-zero return ends the script right there, before it says anything (laptop drill,
  # 2026-11-22: interrupted just before the swap, it exited 1 silently and left the copy)
  if [[ $phase != loading ]]; then if swapped; then state=0; else state=$?; fi; fi
  case $state in
    0) echo "[restore] interrupted, but the restore HAD completed: the database is the restored one$([[ $exists == 1 ]] && echo " (the replaced one is kept as $REPLACED)")." >&2 ;;
    1) discard; echo "[restore] interrupted: the live database is as it was." >&2 ;;
    *) echo "[restore] interrupted while swapping, and the server cannot be asked now: check whether a database named $RESTORING still exists (then nothing was swapped; run this script again) or not (then the restore completed)." >&2 ;;
  esac
  exit 130
}
trap on_interrupt INT TERM
loaded=0
# The renewal row comes last and only after the whole backup went in: the backup's producer failing (it does not decompress, it
# ends early) stops the group before the renewal statement, so there is no row and the new database is discarded.
{
  backup_sql || exit 1
  printf '\nRESET search_path;\n'
  cat "$RENEWAL_SQL"
  printf '%s\n' "$call"
} | psql_on "$RESTORING" -X -q -At -F ' ' -v ON_ERROR_STOP=1 -f - >"$out" 2>"$err" || loaded=$?

renewed=0
renewalOutcome "$out" "$err" "$loaded" || renewed=$?
case "$renewed" in
  0|3|5) ;;
  4) discard
     echo "ERROR: restore refused, nothing was changed: $(renewalRefusalText "$renewal_refusal")" >&2
     echo "       If you must put this backup back anyway: scripts/restore.sh $BACKUP --yes --keep-node-id (read what it means in its --help)." >&2
     exit 1 ;;
  *) grep -v '^onden-renewal ' "$err" >&2 || true
     discard
     echo "ERROR: the restore failed; the database is as it was before (see the error above)." >&2
     exit 1 ;;
esac

# ── 4. swap, in one transaction: the restored database takes the name, the replaced one is kept
swap="BEGIN;"
[[ $exists != 1 ]] || swap+=" ALTER DATABASE $(ident "$TARGET") RENAME TO $(ident "$REPLACED");"
swap+=" ALTER DATABASE $(ident "$RESTORING") RENAME TO $(ident "$TARGET"); COMMIT;"
phase=swapping
# tests only: hold here, the swap not sent yet, until the file is removed (the window an interruption must still describe truthfully)
if [[ -n "${ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP:-}" ]]; then : >"$ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP"; while [[ -e $ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP ]]; do sleep 0.1; done; fi
if ! admin -c "$swap" >/dev/null; then
  if swapped; then phase=done; echo "[restore] the swap reported an error but went through: the database is the restored one." >&2
  else
    discard
    echo "ERROR: swapping the restored database in failed (is something connected to $TARGET?); it was dropped, and the live database is as it was. Run this script again once nothing is connected: it loads the backup again." >&2
    exit 1
  fi
fi
phase=done
trap - INT TERM

case "$renewed" in
  0) read -r old_id new_id _ origins <<<"$renewal_line"
     echo "[restore] the restored database is a new node: id ${old_id} -> ${new_id} (writes made before the backup keep the old id; former ids recorded: ${origins})" ;;
  3) echo "[restore] this backup has no node id (made before migration 190, which never numbered a write); the database takes a new id at its first write." ;;
  5) read -r kept_id _ <<<"$renewal_line"
     if [[ -n $kept_id ]]; then
       cat >&2 <<EOF
[restore] WARNING: --keep-node-id: the restored database was NOT given a new node id ($(renewalRefusalText "$renewal_refusal"))
          It may number writes the server had already numbered for other changes. Until every device that exchanged with this
          server joins it again, it must not exchange with them; the database records this (table sync_restore_kept_node_id).
EOF
     else
       cat >&2 <<EOF
[restore] WARNING: --keep-node-id: the restored database has NO node id ($(renewalRefusalText "$renewal_refusal"))
          It takes a new one at its first write. The id of the database it replaced${overwritten:+ ($overwritten)} is not recorded as a former
          one, so devices that hold writes numbered under it may send them again. Until every device that exchanged with this server
          joins it again, it must not exchange with them; the database records this (table sync_restore_kept_node_id).
EOF
     fi
     ;;
esac
if [[ $exists == 1 && $empty_target == 1 ]]; then
  if admin -c "DROP DATABASE $(ident "$REPLACED")" >/dev/null 2>&1; then echo "[restore] the replaced database held no workspace (an empty schema), so it was not kept."
  else echo "[restore] the replaced database held no workspace; dropping it failed, so it is kept as $REPLACED (DROP DATABASE \"$REPLACED\"; when nothing uses it)."; fi
elif [[ $exists == 1 ]]; then echo "[restore] the replaced database is kept as $REPLACED. Once you are satisfied: DROP DATABASE \"$REPLACED\";"; fi
echo "[restore] done. Restart the backend if you stopped it: docker compose start backend"
