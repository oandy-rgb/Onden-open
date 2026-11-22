#!/usr/bin/env bash
# Self-test for upgrade.sh / rollback: runs them against a fake `docker` that
# only records calls, so it needs no Docker or Postgres. Checks the promises
# that matter: a failed backup changes nothing, the backup runs before the
# image pull and restart, rollback needs a typed "yes", rollback switches the
# version before it restores, and a refused restore puts the version back.
#   scripts/upgrade-selftest.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups"
CALLS="$T/calls"

cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $* | version=$(sed -n 's/^ONDEN_VERSION=//p' "$ENV_FILE")" >> "$CALLS"
case "$*" in
  *"compose version"*) exit 0 ;;
  *" ps --status running --services"*) echo postgres; echo backend; exit 0 ;;
  *" config --services"*) printf 'postgres\nbackend\nfrontend\nnginx\n'; exit 0 ;;
  *" run "*" backup once "*)
    [[ "${FAKE_BACKUP_FAIL:-0}" == 1 ]] && { echo "[backup] ERROR: pg_dump failed" >&2; exit 1; }
    echo "[backup] STAMP=20260101T000000Z"; exit 0 ;;
  *" pull "*) [[ "${FAKE_PULL_FAIL:-0}" == 1 ]] && exit 1; exit 0 ;;
  # restore.sh (compose mode): its reads answer like a live database, the load into onden_restoring prints the renewal row, the swap is
  # remembered so that upgrade.sh can tell the restore went through (onden_before_restore_<stamp>)
  *" exec -T postgres psql "*"-f -"*) cat >/dev/null
    [[ "${FAKE_RESTORE_SLOW:-0}" == 1 ]] && { touch "$CALLS.loading"; sleep 20 & wait; exit 130; }
    [[ "${FAKE_RESTORE_REFUSE:-0}" == 1 ]] && { echo "ERROR:  onden-restore: no-origins-table" >&2; exit 3; }
    echo "onden-renewal renewed c2c99cde-163c-4164-b342-8bb94744b0cc 1d27eb1c-f154-47d9-a868-068881ab3bcc 1 1 -"; exit 0 ;;
  *" exec -T postgres psql "*"ALTER DATABASE"*) touch "$CALLS.swapped"; exit 0 ;;
  *" exec -T postgres psql "*"datname = 'onden_before_restore_rollback"*) [[ "${FAKE_ASK_FAIL:-0}" == 1 ]] && exit 2; [[ -f "$CALLS.swapped" ]] && echo 1 || echo 0; exit 0 ;;
  *" exec -T postgres psql "*"onden_before_restore_"*) [[ -f "$CALLS.swapped" ]] && echo 1 || echo 0; exit 0 ;;
  *" exec -T postgres psql "*"FROM pg_database WHERE datname"*) echo 1; exit 0 ;;
  *" exec -T postgres psql "*"pg_stat_activity"*) exit 0 ;;
  *" exec -T postgres psql "*"pg_get_userbyid"*) echo onden; exit 0 ;;
  *" exec -T postgres psql "*"to_regclass"*) echo f; exit 0 ;;
  *" exec -T postgres psql "*"pg_database_size"*) echo 1000; exit 0 ;;
  *" exec -T postgres sh -c "*"df -Pk"*) echo "overlay 100000000 1 99999999 1% /"; exit 0 ;;
  *" exec -T postgres psql "*) cat >/dev/null; exit 0 ;;
  *" run "*" backend "*) cat >/dev/null; [[ "${FAKE_CONTENT_FAIL:-0}" == 1 ]] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" CALLS ENV_FILE="$T/env" ONDEN_BACKUP_DIR="$T/backups" HEALTH_TIMEOUT_S=3

fail=0
check() { if "$@"; then echo "  ✓ $DESC"; else echo "  ✗ $DESC"; fail=1; fi; }
fresh() { : > "$CALLS"; rm -f "$CALLS.swapped"; printf 'ONDEN_VERSION=v1\nPOSTGRES_PASSWORD=x\n' > "$ENV_FILE"; }
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
printf 'SELECT 1;\n--\n-- PostgreSQL database dump complete\n--\n' | gzip > "$T/backups/onden-20260101T000000Z.sql.gz"
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
DESC="the older image is pulled with .env still on v2"; check bash -c "grep -- ' pull ' '$CALLS' | grep -q 'version=v2\$'"
DESC="the database is loaded with .env already on v1"; check bash -c "grep -- '-f -' '$CALLS' | grep -q 'version=v1\$'"
DESC="content restored after the database is swapped in"; check test "$(line_of 'ALTER DATABASE')" -lt "$(line_of 'entrypoint sh backend')"

echo "rollback, restore refused (a backup that cannot take a new node id)"
fresh; printf 'ONDEN_VERSION=v2\n' > "$ENV_FILE"
echo yes | FAKE_RESTORE_REFUSE=1 "$ROOT/scripts/rollback.sh" >/dev/null 2>&1 && rc=0 || rc=$?
DESC="exit non-zero"; check test "$rc" -ne 0
DESC=".env stays v2 (the database was not changed)"; check grep -qx 'ONDEN_VERSION=v2' "$ENV_FILE"
DESC="content not restored"; check bash -c "! grep -q 'entrypoint sh backend' '$CALLS'"
DESC="services started again on v2"; check bash -c "tail -n 1 '$CALLS' | grep -q ' up -d | version=v2\$'"

echo "rollback interrupted (Ctrl-C) while the database is being loaded"
fresh; printf 'ONDEN_VERSION=v2\n' > "$ENV_FILE"; rm -f "$CALLS.loading"
# its own process group (setsid execs it: pid = group id), sent SIGINT as a whole, as a terminal's Ctrl-C does
FAKE_RESTORE_SLOW=1 setsid bash -c 'echo yes | "$0"' "$ROOT/scripts/rollback.sh" >/dev/null 2>&1 & pid=$!
for _ in $(seq 1 100); do [[ -f "$CALLS.loading" ]] && break; sleep 0.1; done
kill -INT -- "-$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
DESC="the load had started"; check test -f "$CALLS.loading"
DESC=".env back to v2 (the database was not swapped)"; check grep -qx 'ONDEN_VERSION=v2' "$ENV_FILE"
DESC="services started again on v2"; check bash -c "tail -n 1 '$CALLS' | grep -q ' up -d | version=v2\$'"
DESC="content not restored"; check bash -c "! grep -q 'entrypoint sh backend' '$CALLS'"

echo "rollback interrupted, and the server cannot be asked whether the restore went through"
fresh; printf 'ONDEN_VERSION=v2\n' > "$ENV_FILE"; rm -f "$CALLS.loading"
FAKE_RESTORE_SLOW=1 FAKE_ASK_FAIL=1 setsid bash -c 'echo yes | "$0"' "$ROOT/scripts/rollback.sh" >"$T/ask.out" 2>&1 & pid=$!
for _ in $(seq 1 100); do [[ -f "$CALLS.loading" ]] && break; sleep 0.1; done
kill -INT -- "-$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
DESC=".env left on v1 (nothing guessed)"; check grep -qx 'ONDEN_VERSION=v1' "$ENV_FILE"
DESC="no services started"; check bash -c "! tail -n 3 '$CALLS' | grep -q ' up -d '"
DESC="says how to tell which happened"; check grep -q "onden_before_restore_rollback" "$T/ask.out"

echo "rollback: the database is restored, putting the uploads back fails"
fresh; printf 'ONDEN_VERSION=v2\n' > "$ENV_FILE"
echo yes | FAKE_CONTENT_FAIL=1 "$ROOT/scripts/rollback.sh" >"$T/content.out" 2>&1 && rc=0 || rc=$?
DESC="exit non-zero"; check test "$rc" -ne 0
DESC=".env on v1 (the database is v1's)"; check grep -qx 'ONDEN_VERSION=v1' "$ENV_FILE"
DESC="services not started"; check bash -c "! grep -q ' up -d | version=v1' '$CALLS'"
DESC="says what to run and not to roll back again"; check grep -q "不要再跑一次回退" "$T/content.out"

[[ $fail == 0 ]] && echo "通過" || { echo "失敗"; exit 1; }
