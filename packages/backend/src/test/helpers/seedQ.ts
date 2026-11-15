import type pg from "pg";
import { q, withTransaction, allowUnstampedWrite } from "../../db.js";

/** Raw SQL for building a test world (rows a scenario starts from). q() refuses
 *  a core-table write outside a transaction because production writes must go
 *  through mutate() or withEventTransaction(); a fixture has no event to emit,
 *  so it opens its own one-statement transaction. Use it for setup only — code
 *  under test must still reach the tables through its real entry (a fixture may also write the stamped
 *  personal tables, which production code may only write inside mutate()/mutatePersonal()). */
export function seedQ<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  return allowUnstampedWrite("test fixture", () => withTransaction(() => q<T>(text, params)));
}
