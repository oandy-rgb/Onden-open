// Integration tests write to a real Postgres, so they run only against a
// database whose name ends in `_test` (onden_test, onden_review_test,
// onden_n54_test …); against anything else they skip, so a developer's real
// DATABASE_URL is never touched. Any `_test` name is accepted, digits
// included: a narrower gate made whole files skip — and look green — on a
// valid test database (src/test/testDatabaseGate.test.ts keeps every file's
// gate at least this wide).

import { databaseName, isDisposableDatabase } from "../../../../../scripts/lib/disposableDb.mjs";

export { databaseName };

/** Whether `url` names a local test database (`…_test`). The suite drops and
 *  rebuilds it, so a `_test` name on a remote host is refused too. */
export function isTestDatabase(url: string | undefined = process.env.DATABASE_URL): boolean {
  return isDisposableDatabase(url, "test", { localOnly: true });
}
