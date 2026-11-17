#!/usr/bin/env bash
# renewNodeId: give a database that was just restored from a backup a new node id (migration 213 sync_renew_node_id();
# docs/architecture/proposals/node-rebase-2026-11-16.md §6). The one shell entry: scripts/restore.sh and scripts/restore-drill.sh
# source this file and call it with the psql they already use; a person who restored a database by hand (pg_restore of a
# backup-vps.sh dump, a disk snapshot) runs it directly:
#
#   bash scripts/lib/renewNodeId.sh psql "postgres://…/onden"
#   bash scripts/lib/renewNodeId.sh docker compose exec -T postgres psql -U onden -d onden
#
# Run it ONCE per restore, before the backend starts: every run takes another new id (a second run on a database that has
# written since would only add another origin, but nothing is gained). The old id's stamps stay as they are, under the old id.
#
# Prints one line: `<old id or -> <new id> <clock rows renumbered> <origin rows added>`.
# Returns 0 when renewed, 3 when the database has no sync_renew_node_id() (it was backed up by a version before migration 213;
# nothing was changed), 1 when psql failed (nothing was changed: the function is one statement, one transaction).
renewNodeId() {
  local present
  present=$("$@" -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regprocedure('sync_renew_node_id()') IS NOT NULL") || return 1
  [[ $present == t ]] || return 3
  "$@" -X -At -F ' ' -v ON_ERROR_STOP=1 -c "SELECT coalesce(old_node_id, '-'), new_node_id, workspaces, origins_added FROM sync_renew_node_id()" || return 1
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  [[ $# -gt 0 ]] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
  rc=0; renewNodeId "$@" || rc=$?
  [[ $rc != 3 ]] || echo "renewNodeId: nothing changed: this database has no sync_renew_node_id() (it was backed up by a version before migration 213), so it keeps its node id (docs/agents/deploy.md, 還原)" >&2
  exit "$rc"
fi
