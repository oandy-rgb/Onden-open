#!/usr/bin/env bash
# scripts/restore.sh the way the servers run it: compose mode, the repo's own compose.yaml and Postgres image (PG 18 with pgroonga), and a
# scripts/backup-vps.sh-shaped folder (pg_dump -Fc database.dump, content.tar, SHA256SUMS) made by the container's own pg_dump.
# Review of PR #1937, round 2, point 2: the production path, run for real in CI (.github/workflows/ci.yml job restore-scripts).
#
#   scripts/restore-ci-selftest.sh            needs docker with compose, and the image built: docker build -t onden-ci-postgres:selftest docker/postgres
#
# Cases: a restore over a database with data (new node id, the old one a former id, the replaced database kept, pgroonga search and a write
# work), a cut database.dump and a changed one (SHA256SUMS) refused with the database unchanged, and the same backup restored a second time
# (two former ids), and a -Fc backup carrying Apache AGE's data. Everything is in its own compose project, torn down at the end.
set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/onden-restore-ci.XXXXXX")
project="onden-restore-selftest-$$"
printf 'POSTGRES_PASSWORD=selftest\nONDEN_IMAGE=onden-ci\nONDEN_VERSION=selftest\n' > "$work/.env"
compose() { docker compose -p "$project" --env-file "$work/.env" -f "$repo/compose.yaml" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
export ONDEN_COMPOSE_PROJECT="$project" ONDEN_ENV_FILE="$work/.env" ONDEN_COMPOSE_FILE="$repo/compose.yaml"

fails=0
ok() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
q() { compose exec -T postgres psql -U onden -d "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }
nodeid() { q onden "SELECT node_id FROM sync_node" 2>/dev/null || echo none; }
state() { echo "$(nodeid) $(q onden "SELECT count(*) FROM content_nodes" 2>/dev/null) $(q onden "SELECT md5(string_agg(table_name::text, ',' ORDER BY table_name)) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null)"; }
restore() { bash "$repo/scripts/restore.sh" "$@" --yes; }
write() { q onden "UPDATE content_nodes SET title = title || '.' WHERE id = (SELECT id FROM content_nodes WHERE deleted_at IS NULL ORDER BY id LIMIT 1)" >/dev/null; }

compose up -d postgres >/dev/null || { echo "could not start the postgres service (built the image? docker build -t onden-ci-postgres:selftest docker/postgres)"; exit 2; }
for _ in $(seq 1 90); do compose exec -T postgres pg_isready -h 127.0.0.1 -U onden -d onden >/dev/null 2>&1 && break; sleep 1; done
compose exec -T postgres pg_isready -h 127.0.0.1 -U onden -d onden >/dev/null || { echo "postgres never became ready"; compose logs postgres | tail -20; exit 2; }
echo "server: $(q postgres "SHOW server_version")"

# the live database: compose.yaml's postgres service loads db/schema.sql at its first start (initdb); the drill's seed adds notes and stamps
compose exec -T postgres psql -U onden -d onden -X -q -v ON_ERROR_STOP=1 -f - < "$repo/packages/backend/scripts/drillSyntheticSeed.sql" >/dev/null || { echo "loading the seed failed"; exit 2; }
# REQUIRE_PGROONGA=1 (CI): the image must have it and every search below runs; without it (a run against some other server) the searches are skipped and say so
has_pgroonga=$(q onden "SELECT count(*) FROM pg_extension WHERE extname = 'pgroonga'")
if [[ $has_pgroonga == 1 ]]; then ok "the image has pgroonga, and the schema uses it"
elif [[ ${REQUIRE_PGROONGA:-0} == 1 ]]; then bad "no pgroonga in the image"
else echo "SKIP  no pgroonga on this server: the search checks below are skipped"; fi
# the backup: what scripts/backup-vps.sh makes
mkdir -p "$work/manual-1"
compose exec -T postgres pg_dump -U onden -d onden -Fc > "$work/manual-1/database.dump"
tar -C "$work" -cf "$work/manual-1/content.tar" .env
(cd "$work/manual-1" && sha256sum database.dump content.tar > SHA256SUMS)
backup_id=$(nodeid)
write; write # the server goes on after the backup

word=$(q onden "SELECT split_part(title, ' ', 1) FROM content_nodes WHERE deleted_at IS NULL AND title <> '' ORDER BY id LIMIT 1")
search() { q onden "SELECT count(*) FROM content_nodes WHERE title &@~ '${word//\'/\'\'}'"; }
search_check() { # <what>
  if [[ $has_pgroonga != 1 ]]; then echo "SKIP  $1 (no pgroonga here)"; return; fi
  [[ $(search) -gt 0 ]] && ok "$1" || bad "$1"
}

# ── a cut archive and a changed one: refused before anything is touched
before=$(state)
head -c 4000 "$work/manual-1/database.dump" > "$work/cut.dump"
out=$(restore "$work/cut.dump" 2>&1); rc=$?
[[ $rc == 1 && $(state) == "$before" && $out == *"damaged or incomplete"* ]] && ok "a cut pg_dump -Fc archive: refused, the database unchanged" || bad "cut rc=$rc :: $out"
cp -r "$work/manual-1" "$work/manual-2"; printf 'x' | dd of="$work/manual-2/database.dump" bs=1 seek=2000 conv=notrunc 2>/dev/null
out=$(restore "$work/manual-2" 2>&1); rc=$?
[[ $rc == 1 && $(state) == "$before" && $out == *"SHA256SUMS does not match"* ]] && ok "one byte of database.dump changed: SHA256SUMS refuses it, the database unchanged" || bad "changed rc=$rc :: $out"
search_check "after the refusals, pgroonga search on the live database still finds the note"

# ── the restore itself (compose mode, pg_restore in the container)
live_id=$(nodeid)
out=$(ONDEN_RESTORE_STAMP=S1 restore "$work/manual-1" 2>&1); rc=$?
new_id=$(nodeid)
former=$(q onden "SELECT string_agg(DISTINCT origin, ' ' ORDER BY origin) FROM sync_origins WHERE vouched_by = 'self-restore'")
if [[ $rc == 0 && $new_id != "$backup_id" && $new_id != "$live_id" && $former == "$backup_id" && $out == *"is a new node: id $backup_id -> $new_id"* ]]; then
  ok "backup-vps folder restored over the same server: id $backup_id -> $new_id, the backup's id is a former one"
else bad "restore rc=$rc new=$new_id former=$former :: $out"; fi
[[ $(q postgres "SELECT count(*) FROM pg_database WHERE datname = 'onden_before_restore_S1'") == 1 && $(q postgres "SELECT count(*) FROM pg_database WHERE datname = 'onden_restoring'") == 0 ]] \
  && ok "the replaced database is kept as onden_before_restore_S1; no onden_restoring left" || bad "copies"
search_check "pgroonga search on the restored database finds the note"
[[ $(q onden "WITH u AS (UPDATE content_nodes SET title = title || ' x' WHERE id = (SELECT id FROM content_nodes ORDER BY id LIMIT 1) RETURNING 1) SELECT count(*) FROM u") == 1 ]] && ok "a write goes through on the restored database" || bad "write after restore"

# ── the same backup again: the id this restore replaces is kept as a former one too; the earlier copy is listed
out=$(ONDEN_RESTORE_STAMP=S2 restore "$work/manual-1" 2>&1); rc=$?
former=$(q onden "SELECT string_agg(DISTINCT origin, ' ' ORDER BY origin) FROM sync_origins WHERE vouched_by = 'self-restore'")
want=$(printf '%s\n%s\n' "$backup_id" "$new_id" | sort | tr '\n' ' ' | sed 's/ $//')
[[ $rc == 0 && $former == "$want" && $out == *"copies kept by earlier restores"*"onden_before_restore_S1"* ]] && ok "restored twice: both former ids held; the earlier copy is listed before the restore" || bad "twice rc=$rc former=$former :: $out"

# ── a -Fc backup with Apache AGE's data in it (a 2026-10 backup, laptop drill 2026-11-22): the ag_catalog schema, a table and its data
# blocks in the table of contents are left out by scripts/lib/strip-age.sed, as scripts/restore-drill.sh does; the rest is restored
q postgres "CREATE DATABASE onden_agesrc TEMPLATE onden" >/dev/null
q onden_agesrc "CREATE SCHEMA ag_catalog; CREATE TABLE ag_catalog.ag_graph (graphid oid, name name, namespace regnamespace); INSERT INTO ag_catalog.ag_graph VALUES (16385, 'onden', 'public')" >/dev/null
mkdir -p "$work/manual-age"
compose exec -T postgres pg_dump -U onden -d onden_agesrc -Fc > "$work/manual-age/database.dump"
q postgres "DROP DATABASE onden_agesrc" >/dev/null
tar -C "$work" -cf "$work/manual-age/content.tar" .env
(cd "$work/manual-age" && sha256sum database.dump content.tar > SHA256SUMS)
toc_age=$(compose exec -T postgres pg_restore -l < "$work/manual-age/database.dump" | grep -c ' ag_catalog ' || true)
out=$(ONDEN_RESTORE_STAMP=S3 restore "$work/manual-age" 2>&1); rc=$?
age_left=$(q onden "SELECT count(*) FROM pg_namespace WHERE nspname = 'ag_catalog'")
[[ $toc_age -ge 2 && $rc == 0 && $age_left == 0 && $out == *"is a new node"* ]] && ok "a -Fc backup with ag_catalog data ($toc_age entries): AGE left out, restored, new node id" || bad "age rc=$rc toc=$toc_age left=$age_left :: $out"
[[ $out != *NOTICE* ]] && ok "no raw server NOTICE in the output" || bad "NOTICE in the output :: $out"

echo; [[ $fails == 0 ]] && echo "restore-ci-selftest: all passed" || { echo "restore-ci-selftest: $fails failed"; exit 1; }
