// The read-only preview block in the header of migration 220 (db/migrations/220_note_versions.sql, between `preview:begin` and
// `preview:end`), as an operator would paste it into a read-only transaction: the tests run exactly that text, so the header the operator
// reads is the query whose numbers the tests compare with what the migration writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(join(import.meta.dirname, "../../../db/migrations/220_note_versions.sql"), "utf8");
export const PREVIEW_SQL = MIGRATION.slice(MIGRATION.indexOf("-- preview:begin"), MIGRATION.indexOf("-- preview:end")).split("\n")
  .slice(1).map((line) => line.replace(/^-- ?/, "")).filter((line) => !/^(BEGIN READ ONLY|ROLLBACK);$/.test(line)).join("\n");
