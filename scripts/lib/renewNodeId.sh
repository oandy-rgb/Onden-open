#!/usr/bin/env bash
# renewNodeId: give a database that was just restored from a backup a new node id, and keep its old id as a former origin
# (migration 213 sync_renew_node_id(); a snapshot names the old id as `former`, migration 214; docs/agents/deploy.md「還原」).
# The one shell entry: scripts/restore.sh and scripts/restore-drill.sh source this file; a person who restored a database by hand
# (pg_restore of a backup-vps.sh dump, a disk snapshot) runs it directly, before the backend starts:
#
#   bash scripts/lib/renewNodeId.sh psql "postgres://…/onden"
#   bash scripts/lib/renewNodeId.sh docker compose exec -T postgres psql -U onden -d onden
#
# The SQL is scripts/lib/renewNodeId.sql (made from the migrations by scripts/lib/renewNodeIdSql.mjs): it also renews a backup made
# before migration 213, by installing the migrations' own definitions where the database lacks them. Run it ONCE per restore: every run
# takes another new id (harmless, nothing is gained). The old id's stamps stay as they are, under the old id.
#
# Prints one line: `<old id or -> <new id> <clock rows renumbered> <origin rows added>`.
# Returns 0 when renewed; 3 when the database has no node id at all (made before migration 190: nothing was ever numbered, it takes a
# fresh id at its first write; nothing was changed); 4 when the rule cannot hold and nothing was changed (the reason is on stderr:
# a backup from migrations 190 to 205 has no table to record its old id); 1 when psql failed (nothing was changed: one transaction).

RENEWAL_SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/renewNodeId.sql"

# renewalCall <node id the overwritten database had, or empty> [1 = keep the id where it cannot be renewed]: the statement that follows the
# file, its one row tagged `onden-renewal`.
renewalCall() {
  local overwritten=${1:-} keep=false
  [[ ${2:-0} != 1 ]] || keep=true
  local cols="SELECT 'onden-renewal', outcome, coalesce(before_id, '-'), coalesce(after_id, '-'), clocks, origins, coalesce(reason, '-')"
  if [[ -z $overwritten ]]; then
    printf "%s FROM pg_temp.onden_renew_after_restore(NULL, %s);\n" "$cols" "$keep"
  elif [[ $overwritten =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    printf "%s FROM pg_temp.onden_renew_after_restore('%s', %s);\n" "$cols" "$overwritten" "$keep"
  else
    return 1
  fi
}

# renewalOutcome <psql stdout file> <psql stderr file> <psql exit code>: sets renewal_line (`old new clocks origins`) and renewal_refusal, and
# returns 0 renewed, 3 no node id at all, 4 refused, 5 kept (only when asked: --keep-node-id), 1 anything else (no renewal row: failed).
renewalOutcome() {
  local line refused _tag outcome before after clocks origins reason
  renewal_line="" renewal_refusal=""
  refused=$(grep -o 'onden-restore: [a-z-]*' "$2" 2>/dev/null | head -n 1 || true)
  if [[ -n $refused ]]; then renewal_refusal=${refused#onden-restore: }; return 4; fi
  [[ $3 == 0 ]] || return 1
  line=$(grep '^onden-renewal ' "$1" | tail -n 1 || true)
  read -r _tag outcome before after clocks origins reason <<<"$line"
  case "${outcome:-}" in
    renewed) renewal_line="$before $after $clocks $origins"; return 0 ;;
    no-node-id) return 3 ;;
    kept) renewal_line="$before $after 0 0"; renewal_refusal=$reason; return 5 ;;
    *) return 1 ;;
  esac
}

# renewalRefusalText <reason>: one paragraph for a person.
renewalRefusalText() {
  case "$1" in
    no-origins-table) echo "this backup was made by a version that numbered its writes but had no table to record a former node id (migrations 190 to 205, 2026-11-12 to 11-16). Restored with its id, the database would number writes the server had already numbered." ;;
    no-node-table) echo "this backup has no node id (made before migration 190), but the database it replaces has one, and the restored database has nowhere to record it." ;;
    bad-node-id) echo "the database being replaced has a node id this script does not recognise." ;;
    *) echo "the renewal refused the restore ($1)." ;;
  esac
}

# renewNodeId <psql command…>: renew a database that is already restored (no overwritten id: the person ran the restore by hand; for a
# pg_dump -Fc backup scripts/restore.sh does the whole restore, this is for what no script made: a disk snapshot, a pg_restore by hand).
renewNodeId() {
  local out err rc=0
  out=$(mktemp) err=$(mktemp)
  { cat "$RENEWAL_SQL"; renewalCall "" 0; } | "$@" -X -q -At -F ' ' -v ON_ERROR_STOP=1 --single-transaction -f - >"$out" 2>"$err" || rc=$?
  renewalOutcome "$out" "$err" "$rc" || rc=$?
  [[ $rc != 4 ]] || renewalRefusalText "$renewal_refusal" >&2
  [[ $rc != 1 ]] || cat "$err" >&2
  [[ -z $renewal_line ]] || echo "$renewal_line"
  rm -f "$out" "$err"
  return "$rc"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  [[ $# -gt 0 ]] || { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
  rc=0; renewNodeId "$@" || rc=$?
  [[ $rc != 3 ]] || echo "renewNodeId: nothing changed: this database has no node id (it was backed up by a version before migration 190, which never numbered a write); it takes a fresh one at its first write" >&2
  exit "$rc"
fi
