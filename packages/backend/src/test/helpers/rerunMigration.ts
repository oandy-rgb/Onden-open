// Run one migration's SQL again on the shared test database (a test that proves the migration can run twice).
// A migration's `CREATE OR REPLACE FUNCTION` puts back the function as it was THEN: if a later migration redefined it,
// every test file that runs afterwards on the same database would get the old one (found with migration 194 run again
// after 199: sync_workspace lost 'space:' and each write to space_members failed). So the functions of every later
// migration are put back, in order, in the same transaction.
import { listMigrations } from "../../dbMigrations.js";
import { seedQ } from "./seedQ.js";

const FUNCTION = /CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$ LANGUAGE [^;]*;/g;

/** `version` is the file name without `.sql`, e.g. "194_stamps_s2". */
export async function rerunMigration(version: string): Promise<void> {
  const all = await listMigrations();
  const at = all.findIndex((m) => m.version === version);
  if (at < 0) throw new Error(`no migration ${version}`);
  const later = all.slice(at + 1).flatMap((m) => m.sql.match(FUNCTION) ?? []);
  await seedQ([all[at]!.sql, ...later].join("\n"));
}
