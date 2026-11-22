// Run one migration's SQL again on the shared test database (a test that proves the migration can run twice).
// A migration's `CREATE OR REPLACE FUNCTION` puts back the function as it was THEN: if a later migration redefined it,
// every test file that runs afterwards on the same database would get the old one (found with migration 194 run again
// after 199: sync_workspace lost 'space:' and each write to space_members failed). So the functions of every later
// migration are put back, in order, in the same transaction. Triggers are the same, but only the ones the rerun migration
// itself (re)defines: 200 gave the content_nodes and note_pointers stamp triggers new arguments (order_key), and 190 or 194 run
// again would put the old ones back. (A later migration's trigger the rerun does not touch is left alone: it may need
// columns a test that rebuilt an older table shape has not got.) One a later migration creates only to drop it again
// (a helper function of its backfill) is not put back.
import { listMigrations } from "../../dbMigrations.js";
import { seedQ } from "./seedQ.js";

// The body's quote is `$$` or a named one (`$fn$`: sync_genesis_pass, 202 and 209), and the statement ends at the same quote.
// Both start at the beginning of a line (the m flag): a migration's comment that spells the statement (migration 226's header did, PR #1946)
// was read as one, and the rerun failed with a syntax error. Every migration starts these statements at the beginning of a line.
const FUNCTION = /^CREATE OR REPLACE FUNCTION[\s\S]*?\n\$(\w*)\$ LANGUAGE [^;]*;/gm;
// "CREATE OR REPLACE TRIGGER <name> AFTER INSERT ON <table> …;": the timing and events sit between the name and ON (the pattern used to
// expect ON right after the name, matched nothing, and a rerun of 194 left the pointer triggers watching sort_order for every later file).
const TRIGGER = /^CREATE OR REPLACE TRIGGER (\w+)\s+(?:BEFORE|AFTER|INSTEAD OF)\b[^;]*?\bON (\w+)[\s\S]*?;(?:\n|$)/gm;
const functionName = (statement: string) => /^CREATE OR REPLACE FUNCTION (\w+)/.exec(statement)?.[1];

/** `version` is the file name without `.sql`, e.g. "194_stamps_s2". */
export async function rerunMigration(version: string): Promise<void> {
  const all = await listMigrations();
  const at = all.findIndex((m) => m.version === version);
  if (at < 0) throw new Error(`no migration ${version}`);
  const mine = all[at]!.sql;
  const redefinedByRerun = new Set([...mine.matchAll(TRIGGER)].map((hit) => `${hit[2]}.${hit[1]}`));
  const later = all.slice(at + 1).flatMap((m) => [
    ...(m.sql.match(FUNCTION) ?? []).filter((statement) => {
      const name = functionName(statement);
      return !name || !new RegExp(`DROP FUNCTION (?:IF EXISTS )?${name}\\b`).test(m.sql);
    }),
    ...[...m.sql.matchAll(TRIGGER)].filter((hit) => redefinedByRerun.has(`${hit[2]}.${hit[1]}`)).map((hit) => hit[0]),
  ]);
  await seedQ([mine, ...later].join("\n"));
}
