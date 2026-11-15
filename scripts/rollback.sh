#!/usr/bin/env bash
# Roll back to the version before the last upgrade (restores the pre-upgrade
# backup). Same as `scripts/upgrade.sh rollback`; see docs/self-host/upgrade.md.
exec "$(dirname "${BASH_SOURCE[0]}")/upgrade.sh" rollback "$@"
