-- 219: sign-in rows read by better-auth 1.7 (the sign-in library moves from 1.6.18 to 1.7.26).
--
-- The tables do not change: 1.7.3 and later ask for exactly the columns 1.6 made (1.7.0–1.7.2's required
-- account.issuer column and its unique index were taken back in 1.7.3; this repo never ran those versions).
-- What changes is how 1.7 READS two kinds of existing rows:
--   1. Email + password sign-in only accepts the person's 'credential' row whose "accountId" is the person's
--      own id ("userId"). 1.6 accepted any 'credential' row of that person. Every version of the library writes
--      it keyed by the id, so this normally changes no row; a row keyed otherwise is re-keyed here when the
--      answer is certain: it is that person's only 'credential' row and no other 'credential' row already uses
--      the id. Only "accountId" changes; the password hash and every other column stay as they are.
--   2. A sign-in through a provider (GitHub, Google) fails when two rows share ("providerId", "accountId").
--      Which person such a link belongs to cannot be decided from the data, so this migration stops instead
--      of guessing, and so does a person whose 'credential' rows give no single answer after step 1.
-- Stopping raises an error: migrate() rolls this whole migration back, nothing is changed, the backend does
-- not start on 1.7, and the previous image keeps working on the same database (219 is not recorded).
-- No row is deleted. Safe to run twice: a second run finds nothing to re-key.
-- Rolling back AFTER 219 has applied: the previous image refuses a database that records a migration it does not
-- know (db.ts DatabaseNewerThanCodeError), so the usual way back is scripts/rollback.sh (restore the pre-upgrade
-- backup). Without a restore, deleting the row '219_sign_in_rows_for_better_auth_1_7' from schema_migrations is
-- enough for that image to start: 219 changes no table, and a re-keyed password row is one 1.6 also signs in.
--
-- On a fresh database migrate() runs before the library creates its tables (server.ts), so there is no
-- "account" table yet and there is nothing to do.
DO $$
DECLARE
  duplicate text;
  unreadable text;
BEGIN
  IF to_regclass('account') IS NULL THEN
    RETURN;
  END IF;

  SELECT format('%s / %s (%s rows)', "providerId", "accountId", count(*)) INTO duplicate
    FROM account GROUP BY "providerId", "accountId" HAVING count(*) > 1
    ORDER BY "providerId", "accountId" LIMIT 1;
  IF duplicate IS NOT NULL THEN
    RAISE EXCEPTION 'migration 219: two sign-in rows name the same provider account (%); better-auth 1.7 refuses that sign-in. Nothing was changed. Decide which person the link belongs to, remove the other row, then start again.', duplicate;
  END IF;

  UPDATE account a SET "accountId" = a."userId"
   WHERE a."providerId" = 'credential'
     AND a."accountId" <> a."userId"
     AND NOT EXISTS (
       SELECT 1 FROM account b
        WHERE b."providerId" = 'credential' AND b.id <> a.id
          AND (b."userId" = a."userId" OR b."accountId" = a."userId"));

  SELECT a."userId" INTO unreadable
    FROM account a
   WHERE a."providerId" = 'credential'
     AND NOT EXISTS (
       SELECT 1 FROM account b
        WHERE b."providerId" = 'credential' AND b."userId" = a."userId" AND b."accountId" = a."userId")
   ORDER BY a."userId" LIMIT 1;
  IF unreadable IS NOT NULL THEN
    RAISE EXCEPTION 'migration 219: the person % has password (credential) rows, but none that better-auth 1.7 can read, and which one is theirs cannot be decided. Nothing was changed.', unreadable;
  END IF;
END
$$;
