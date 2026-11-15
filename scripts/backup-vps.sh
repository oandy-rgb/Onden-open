#!/usr/bin/env bash
# Run on oandy-vps after deploying Onden to /srv/onden. The backend is stopped
# briefly so the PostgreSQL dump and content volume describe one quiet state.
set -euo pipefail

root=${ONDEN_VPS_ROOT:-/srv/onden}
stamp=$(date -u +%Y%m%d%H%M%S)
target="$root/backups/manual-$stamp"
umask 077
mkdir -m 0700 "$target"

compose=(sudo docker compose -p onden-vps --env-file "$root/shared/.env" -f "$root/current/compose.yaml")
backend_stopped=0
resume_backend() {
  if [[ $backend_stopped == 1 ]]; then
    "${compose[@]}" start backend >/dev/null
  fi
}
trap resume_backend EXIT

"${compose[@]}" stop backend
backend_stopped=1
"${compose[@]}" exec -T postgres pg_dump -U onden -d onden -Fc > "$target/database.dump"
sudo docker run --rm \
  -v onden-vps_content_data:/src:ro -v "$target:/out" \
  nginx:1.31-alpine tar -C /src -cf /out/content.tar .
sudo chown "$(id -un):$(id -gn)" "$target/content.tar"
chmod 600 "$target/content.tar"
(
  cd "$target"
  sha256sum database.dump content.tar > SHA256SUMS
  sha256sum -c SHA256SUMS
)

# start, not up: the same container comes back with its ONDEN_BUILD_ID, which a
# recreate here would drop (this shell doesn't have it) and pages would then be
# offered a reload.
"${compose[@]}" start backend >/dev/null
backend_stopped=0
printf 'Backup: %s\n' "$target"

# Keep a day of these (owner's choice, 2026-10-30): only after this backup
# verified, remove manual backups older than ONDEN_MANUAL_KEEP_HOURS (24).
keep_min=$(( ${ONDEN_MANUAL_KEEP_HOURS:-24} * 60 ))
find "$root/backups" -mindepth 1 -maxdepth 1 -type d -name 'manual-*' ! -path "$target" -mmin +"$keep_min" -print -exec rm -rf {} + \
  | sed 's/^/Removed old backup: /'
