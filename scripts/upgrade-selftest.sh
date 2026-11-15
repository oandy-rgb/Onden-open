#!/usr/bin/env bash
# Self-test for upgrade.sh / rollback: runs them against a fake `docker` that
# only records calls, so it needs no Docker or Postgres. Checks the promises
# that matter: a failed backup changes nothing, the backup runs before the
# image pull and restart, rollback needs a typed "yes".
#   scripts/upgrade-selftest.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups"
CALLS="$T/calls"

cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$*" in
  *"compose version"*) exit 0 ;;
  *" ps --status running --services"*) echo postgres; echo backend; exit 0 ;;
  *" config --services"*) printf 'postgres\nbackend\nfrontend\nnginx\n'; exit 0 ;;
  *" run "*" backup once "*)
    [[ "${FAKE_BACKUP_FAIL:-0}" == 1 ]] && { echo "[backup] ERROR: pg_dump failed" >&2; exit 1; }
    echo "[backup] STAMP=20260101T000000Z"; exit 0 ;;
  *" pull "*) [[ "${FAKE_PULL_FAIL:-0}" == 1 ]] && exit 1; exit 0 ;;
  *" exec -T postgres psql "*) cat >/dev/null; exit 0 ;;
  *" run "*" backend "*) cat >/dev/null; exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" CALLS ENV_FILE="$T/env" ONDEN_BACKUP_DIR="$T/backups" HEALTH_TIMEOUT_S=3

fail=0
check() { if "$@"; then echo "  ✓ $DESC"; else echo "  ✗ $DESC"; fail=1; fi; }
fresh() { : > "$CALLS"; printf 'ONDEN_VERSION=v1\nPOSTGRES_PASSWORD=x\n' > "$ENV_FILE"; }
called() { grep -q -- "$1" "$CALLS"; }
line_of() { grep -n -- "$1" "$CALLS" | head -n 1 | cut -d: -f1; }

echo "backup fails → nothing changes"
fresh
FAKE_BACKUP_FAIL=1 "$ROOT/scripts/upgrade.sh" v2 >/dev/null 2>&1 && rc=0 || rc=$?
DESC="exit non-zero"; check test "$rc" -ne 0
DESC=".env version untouched"; check grep -qx 'ONDEN_VERSION=v1' "$ENV_FILE"
DESC="no pull, no restart"; check bash -c "! grep -qE ' (pull|up) ' '$CALLS'"

echo "upgrade ok → backup before pull before up"
fresh
"$ROOT/scripts/upgrade.sh" v2 >/dev/null 2>&1 && rc=0 || rc=$?
DESC="exit 0 (stub backend answers exec)"; check test "$rc" -eq 0
DESC=".env now v2"; check grep -qx 'ONDEN_VERSION=v2' "$ENV_FILE"
DESC="other .env lines kept"; check grep -qx 'POSTGRES_PASSWORD=x' "$ENV_FILE"
DESC="order backup < pull < up"; check test "$(line_of 'backup once')" -lt "$(line_of ' pull ')" -a "$(line_of ' pull ')" -lt "$(line_of ' up -d')"

echo "pull fails → version restored, no restart"
fresh
FAKE_PULL_FAIL=1 "$ROOT/scripts/upgrade.sh" v2 >/dev/null 2>&1 && rc=0 || rc=$?
DESC="exit non-zero"; check test "$rc" -ne 0
DESC=".env back to v1"; check grep -qx 'ONDEN_VERSION=v1' "$ENV_FILE"
DESC="no restart"; check bash -c "! grep -q ' up ' '$CALLS'"

echo "rollback"
printf 'pre-upgrade from=v1 to=v2\n' > "$T/backups/onden-20260101T000000Z.note.txt"
: | gzip > "$T/backups/onden-20260101T000000Z.sql.gz"
: | gzip > "$T/backups/onden-content-20260101T000000Z.tar.gz"
fresh; printf 'ONDEN_VERSION=v2\n' > "$ENV_FILE"
echo no | "$ROOT/scripts/rollback.sh" >/dev/null 2>&1 && rc=0 || rc=$?
DESC="answer 'no' cancels"; check test "$rc" -ne 0
DESC="nothing stopped or restored"; check bash -c "! grep -qE ' (stop|up) |psql' '$CALLS'"
echo yes | "$ROOT/scripts/rollback.sh" >/dev/null 2>&1 && rc=0 || rc=$?
DESC="answer 'yes' succeeds"; check test "$rc" -eq 0
DESC="services stopped, postgres kept"; check bash -c "grep -q ' stop backend frontend nginx' '$CALLS'"
DESC="database restored"; check called psql
DESC=".env back to v1"; check grep -qx 'ONDEN_VERSION=v1' "$ENV_FILE"
DESC="safety backup before stop"; check test "$(line_of 'pre-rollback')" -lt "$(line_of ' stop ')"

[[ $fail == 0 ]] && echo "通過" || { echo "失敗"; exit 1; }
