#!/usr/bin/env bash
# ── Onden restore ────────────────────────────────────────────────────────
# Loads a scripts/backup.sh dump (onden-<ts>.sql.gz) back into the compose
# stack's Postgres (service `postgres`, db/user `onden` — see compose.yaml),
# or into DATABASE_URL if set.
#
# DESTRUCTIVE: the dump was taken with --clean --if-exists, so restoring
# DROPs and recreates every object in the target database. That is the point
# — but it means an accidental invocation destroys current data, so the
# script refuses to run without an explicit --yes.
#
# Stop the backend first (docker compose stop backend): a live backend holds
# open connections and keeps writing mid-restore; DROPs will block or the
# restored state will be immediately dirtied. Restart it afterwards — boot
# re-runs migrations, which is a no-op on a same-version dump and forward-
# migrates an older one.
#
# Once the dump is loaded, and before anything else writes to it, the database
# takes a new node id (scripts/lib/renewNodeId.sh, migration 213; docs/agents/
# deploy.md「還原」). The dump brought back the node id and the write numbers
# the server had when it was backed up; the server went on numbering after
# that, so without a new id the restored database would hand out the same
# (node id, number) pairs again for other writes. Nothing already stored is
# rewritten: the writes made before the backup keep the old id.
# It runs on the schema the dump carries, before the backend's own migrations
# (boot): those migrations then write under the new id, and the older backend
# of scripts/upgrade.sh rollback (which calls this script before it switches
# the version) still finds a database it knows.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh <backups/onden-<ts>.sql.gz> --yes

Restores a backup.sh database dump into the compose `postgres` service
(db onden), or into DATABASE_URL if that env var is set.

DESTRUCTIVE: drops and recreates all objects in the target database.
Refuses to run without --yes.

Recommended sequence:
  docker compose stop backend
  scripts/restore.sh backups/onden-<ts>.sql.gz --yes
  docker compose start backend

After loading, the restored database takes a new node id (the writes it
holds keep the old one), so it never numbers a write the way the server
did after the backup was taken.

Media/content volume: restore the matching onden-content-<ts>.tar.gz with
  docker compose cp - is not streamable; instead:
  gunzip -c backups/onden-content-<ts>.tar.gz | \
    docker compose exec -T backend tar -xzf - -C /app/packages/backend
EOF
}

DUMP=""
CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --yes) CONFIRMED=1 ;;
    -*) echo "ERROR: unknown flag: $arg" >&2; usage >&2; exit 1 ;;
    *) DUMP="$arg" ;;
  esac
done

if [[ -z "$DUMP" ]]; then
  usage >&2
  exit 1
fi
if [[ ! -f "$DUMP" ]]; then
  echo "ERROR: dump file not found: $DUMP" >&2
  exit 1
fi
case "$DUMP" in
  *.sql.gz) ;;
  *) echo "ERROR: expected a .sql.gz produced by scripts/backup.sh, got: $DUMP" >&2; exit 1 ;;
esac
if [[ "$CONFIRMED" != 1 ]]; then
  echo "ERROR: refusing to restore without --yes." >&2
  echo "       This DROPs and recreates every object in the target database." >&2
  echo "       Run: scripts/restore.sh $DUMP --yes" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
compose() { docker compose -f "$REPO_ROOT/compose.yaml" "$@"; }
# shellcheck source=lib/renewNodeId.sh
source "$SCRIPT_DIR/lib/renewNodeId.sh"

# 舊備份含 Apache AGE（現在的映像沒有）：用 scripts/lib/strip-age.sed 略過 age 相關行。
strip_age() { sed -f "$SCRIPT_DIR/lib/strip-age.sed"; }

# ON_ERROR_STOP: a half-applied restore that exits 0 is worse than a loud
# failure — abort on the first SQL error instead of plowing on.
if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null 2>&1 || {
    echo "ERROR: DATABASE_URL is set but psql is not installed on this host." >&2
    exit 1
  }
  echo "[restore] restoring $DUMP into DATABASE_URL (host psql)"
  gunzip -c "$DUMP" | strip_age | psql --set ON_ERROR_STOP=on --quiet "$DATABASE_URL" >/dev/null
  db_psql=(psql "$DATABASE_URL")
  db_psql_shown='psql "$DATABASE_URL"' # never print the URL itself: it carries the password
else
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: docker compose is not available. Install docker (with the compose plugin) or set DATABASE_URL." >&2
    exit 1
  fi
  if ! compose ps --status running --services 2>/dev/null | grep -qx postgres; then
    echo "ERROR: the compose 'postgres' service is not running." >&2
    echo "       Start it first: docker compose up -d postgres" >&2
    exit 1
  fi
  if compose ps --status running --services 2>/dev/null | grep -qx backend; then
    echo "[restore] WARNING: the backend container is running — its open connections can block the restore's DROPs and it keeps writing meanwhile. Consider: docker compose stop backend" >&2
  fi
  echo "[restore] restoring $DUMP into compose service postgres (db onden)"
  gunzip -c "$DUMP" | strip_age | compose exec -T postgres psql --set ON_ERROR_STOP=on --quiet -U onden -d onden >/dev/null
  db_psql=(compose exec -T postgres psql -U onden -d onden)
  db_psql_shown="docker compose -f $REPO_ROOT/compose.yaml exec -T postgres psql -U onden -d onden"
fi

renewed=0
renewal=$(renewNodeId "${db_psql[@]}") || renewed=$?
case "$renewed" in
  0) read -r old_id new_id _ _ <<<"$renewal"
     echo "[restore] the restored database is a new node: id ${old_id} -> ${new_id} (writes made before the backup keep the old id)" ;;
  3) echo "[restore] WARNING: this backup was made by a version before the node-id step (migration 213); the restored database keeps the node id it had when it was backed up (docs/agents/deploy.md「還原」)." >&2 ;;
  *) echo "ERROR: the data is restored, but giving it a new node id failed (nothing of that step was changed)." >&2
     echo "       Do not start the backend yet. Run: bash scripts/lib/renewNodeId.sh $db_psql_shown" >&2
     exit 1 ;;
esac

echo "[restore] done. Restart the backend if you stopped it: docker compose start backend"
