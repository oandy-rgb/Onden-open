#!/usr/bin/env bash
# ── Onden backup ─────────────────────────────────────────────────────────
# Dumps the compose stack's Postgres (service `postgres`, db/user `onden` —
# see compose.yaml) to ./backups/onden-<UTC timestamp>.sql.gz and, when the
# backend container is running, tars its content volume (media + git store,
# the `content_data` volume mounted at /app/packages/backend/content) to
# ./backups/onden-content-<UTC timestamp>.tar.gz.
#
# Why pg_dump inside the container by default: the compose stack does not
# publish the Postgres port to the host, and the container's pg_dump is
# version-matched to the server (a host pg_dump older than the server refuses
# to run). DATABASE_URL overrides this for non-compose deployments — then
# pg_dump runs on the host and must be installed there.
#
# The dump uses --clean --if-exists so restore.sh can load it into a live
# (non-empty) database without hand-dropping objects first.
#
# Retention: keeps the newest BACKUP_KEEP (default 14) of each artifact kind;
# older ones are deleted after a successful new backup — a failed run never
# eats history.
#
# Environment:
#   DATABASE_URL   dump this URL with host pg_dump instead of the compose stack
#   BACKUP_KEEP    how many backups of each kind to keep (default 14)
#   BACKUP_DIR     output directory (default ./backups next to the repo root)
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/backup.sh [--help]

Backs up the Onden compose stack:
  1. pg_dump of the `postgres` service (db onden) -> backups/onden-<UTC>.sql.gz
  2. tar of the backend content volume (media + git store, mounted at
     /app/packages/backend/content) -> backups/onden-content-<UTC>.tar.gz
     (skipped with a hint if the backend container is not running)

Environment:
  DATABASE_URL  if set, dump this URL with the host's pg_dump instead of
                exec-ing into the compose postgres (non-compose deployments).
                The content tar is still attempted via compose if available.
  BACKUP_KEEP   number of backups of each kind to keep (default 14)
  BACKUP_DIR    output directory (default <repo>/backups)

Restore with: scripts/restore.sh backups/onden-<ts>.sql.gz --yes
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

# Resolve the repo root from the script location so the compose file and the
# backups dir don't depend on the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
KEEP="${BACKUP_KEEP:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

# compose() wraps `docker compose` pinned to the repo's compose.yaml; COMPOSE_OK
# gates the compose-dependent paths so a DATABASE_URL-only run still works on a
# host without docker.
COMPOSE_OK=0
compose() { docker compose -f "$REPO_ROOT/compose.yaml" "$@"; }
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_OK=1
fi

service_running() { # service_running <name> -> 0 if the compose service is up
  [[ "$COMPOSE_OK" == 1 ]] || return 1
  compose ps --status running --services 2>/dev/null | grep -qx "$1"
}

# ── 1. Database dump ─────────────────────────────────────────────────────
SQL_OUT="$BACKUP_DIR/onden-$TS.sql.gz"

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v pg_dump >/dev/null 2>&1 || {
    echo "ERROR: DATABASE_URL is set but pg_dump is not installed on this host." >&2
    exit 1
  }
  echo "[backup] pg_dump via DATABASE_URL (host pg_dump)"
  pg_dump --clean --if-exists --no-owner "$DATABASE_URL" | gzip > "$SQL_OUT.partial"
else
  if [[ "$COMPOSE_OK" != 1 ]]; then
    echo "ERROR: docker compose is not available. Install docker (with the compose plugin) or set DATABASE_URL to dump directly." >&2
    exit 1
  fi
  if ! service_running postgres; then
    echo "ERROR: the compose 'postgres' service is not running." >&2
    echo "       Start the stack (docker compose up -d) or set DATABASE_URL to dump a reachable server." >&2
    exit 1
  fi
  echo "[backup] pg_dump via compose exec (service postgres, db onden)"
  # -T: no TTY (we pipe stdout). Credentials come from the container's own env
  # (POSTGRES_USER/DB); no password needed for a local socket connection.
  compose exec -T postgres pg_dump --clean --if-exists --no-owner -U onden -d onden | gzip > "$SQL_OUT.partial"
fi

# .partial → final rename only after the pipeline succeeded (set -o pipefail
# above makes a mid-stream pg_dump failure fatal), so a truncated dump can
# never masquerade as a good backup.
mv "$SQL_OUT.partial" "$SQL_OUT"
echo "[backup] wrote $SQL_OUT ($(du -h "$SQL_OUT" | cut -f1))"

# ── 2. Content volume (media + git store) ────────────────────────────────
# compose.yaml mounts the named volume `content_data` INSIDE the backend
# container at /app/packages/backend/content (media lives at content/media) —
# there is no host bind to tar directly, so we stream a tar out of the
# running container. If the backend is down, copy by hand with:
#   docker compose cp backend:/app/packages/backend/content ./backups/content-<ts>
CONTENT_OUT="$BACKUP_DIR/onden-content-$TS.tar.gz"
if service_running backend; then
  echo "[backup] tarring backend content volume (media + git store)"
  compose exec -T backend tar -czf - -C /app/packages/backend content > "$CONTENT_OUT.partial"
  mv "$CONTENT_OUT.partial" "$CONTENT_OUT"
  echo "[backup] wrote $CONTENT_OUT ($(du -h "$CONTENT_OUT" | cut -f1))"
else
  echo "[backup] NOTE: backend container not running — content volume (media) NOT backed up." >&2
  echo "         When it is up: docker compose cp backend:/app/packages/backend/content ./backups/content-$TS" >&2
fi

# ── 3. Retention ─────────────────────────────────────────────────────────
# Applied per artifact kind, newest-first by name (the UTC timestamp in the
# filename sorts lexicographically = chronologically).
prune() { # prune <glob-prefix>
  local pattern="$1"
  # shellcheck disable=SC2012 — filenames are our own timestamped names, no
  # spaces/newlines possible; ls -1 sorting by name is exactly what we want.
  ls -1 "$BACKUP_DIR"/$pattern 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "[backup] pruning $old (keeping last $KEEP)"
    rm -f "$old"
  done
}
prune "onden-*.sql.gz"
prune "onden-content-*.tar.gz"

echo "[backup] done."
