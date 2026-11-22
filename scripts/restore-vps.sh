#!/usr/bin/env bash
# Run on oandy-vps: put a scripts/backup-vps.sh backup (manual-<ts>/: database.dump, content.tar, SHA256SUMS) back as the server's data.
# The same restore as everywhere else (scripts/restore.sh: checked first, loaded into a new database, node id renewed there, swapped in
# by name; on any failure the live database is as it was; docs/agents/deploy.md「還原」), on this host's compose stack
# (-p onden-vps, $root/shared/.env, $root/current/compose.yaml). Holds deploy.lock (as scripts/deploy-vps.sh does) and keeps the backend
# stopped for the whole of it.
#
#   scripts/restore-vps.sh <root>/backups/manual-<ts> --yes [--with-content] [--keep-node-id] [--no-space-check]
#
# --with-content  also puts the uploads back (content.tar), while the backend is still stopped: the uploads volume is emptied and filled
#                 from the backup, so the files are those of the moment the database is from. Without it the database is the backup's
#                 and the files stay as they are now (uploads made after the backup are kept, uploads deleted after it are gone from the
#                 database's point of view but still on disk): say so, and leave it to the person.
set -euo pipefail

root=${ONDEN_VPS_ROOT:-/srv/onden}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# -gt 0 && ${1:-} != -h && ${1:-} != --help ]] || { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
backup=$1; shift
with_content=0 pass=()
for arg in "$@"; do
  case $arg in
    --with-content) with_content=1 ;;
    *) pass+=("$arg") ;;
  esac
done
[[ -d $backup && -f $backup/database.dump ]] || { echo "ERROR: $backup is not a scripts/backup-vps.sh folder (manual-<ts>/ with database.dump)" >&2; exit 1; }
[[ $with_content == 0 || -f $backup/content.tar ]] || { echo "ERROR: --with-content: $backup has no content.tar" >&2; exit 1; }

export ONDEN_COMPOSE_PROJECT=onden-vps ONDEN_ENV_FILE="$root/shared/.env" ONDEN_COMPOSE_FILE="$root/current/compose.yaml" ONDEN_DOCKER_SUDO=1
compose=(sudo docker compose -p onden-vps --env-file "$root/shared/.env" -f "$root/current/compose.yaml")
docker_cmd=(sudo docker)

# one change to the server at a time: deploy-vps.sh switch / rollback take the same lock
mkdir "$root/deploy.lock" 2>/dev/null || { echo "ERROR: deploy.lock is held: $(cat "$root/deploy.lock/owner" 2>/dev/null)" >&2; exit 3; }
echo "restore $(basename "$backup") $(date -u +%FT%TZ)" > "$root/deploy.lock/owner"
backend_stopped=0
finish() {
  [[ $backend_stopped == 1 ]] && "${compose[@]}" start backend >/dev/null || true
  rm -rf "$root/deploy.lock"
}
trap finish EXIT
"${compose[@]}" stop backend
backend_stopped=1

"$here/restore.sh" "$backup" "${pass[@]}"

if [[ $with_content == 1 ]]; then
  # SHA256SUMS was checked by restore.sh for database.dump; content.tar is checked here before the volume is touched
  (cd "$backup" && sha256sum -c --quiet --ignore-missing SHA256SUMS) || { echo "ERROR: $backup/SHA256SUMS does not match content.tar; the uploads were not touched (the database IS restored)." >&2; exit 1; }
  "${docker_cmd[@]}" run --rm -v onden-vps_content_data:/dst -v "$backup:/in:ro" nginx:1.31-alpine \
    sh -c 'find /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /dst -xf /in/content.tar' \
    || { echo "ERROR: putting the uploads back failed; the database IS restored, the uploads volume may be partly filled. Run this again with --with-content, or put content.tar back by hand, before starting the backend." >&2; backend_stopped=0; exit 1; }
  echo "[restore-vps] the uploads are those of the backup."
else
  cat <<'EOF'
[restore-vps] the uploads were NOT put back: the database is the backup's, the files are today's. Uploads made after the backup stay on disk
              (nothing points to them); uploads deleted after the backup are not there for the notes that point to them. To make them match,
              run this again with --with-content (it stops the backend for it), not by hand while the backend runs.
EOF
fi

# start, not up: the same container comes back with its ONDEN_BUILD_ID (scripts/backup-vps.sh says why)
"${compose[@]}" start backend >/dev/null
backend_stopped=0
echo "[restore-vps] done; the backend is running again."
