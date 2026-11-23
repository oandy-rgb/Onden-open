// The read-only preview blocks in the headers of migrations 220, 230 and 231 (db/migrations/220_note_versions.sql, between `preview:begin` and
// `preview:end`), as an operator would paste it into a read-only transaction: the tests run exactly that text, so the header the operator
// reads is the query whose numbers the tests compare with what the migration writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The preview block of a migration's header (`file`: its name in db/migrations), comment marks taken off. Also migration 230's
 *  (trashGroups.integration.test.ts). */
export function previewSqlOf(file: string): string {
  const migration = readFileSync(join(import.meta.dirname, "../../../db/migrations", file), "utf8");
  return migration.slice(migration.indexOf("-- preview:begin"), migration.indexOf("-- preview:end")).split("\n")
    .slice(1).map((line) => line.replace(/^-- ?/, "")).filter((line) => !/^(BEGIN READ ONLY|ROLLBACK);$/.test(line)).join("\n");
}
export const PREVIEW_SQL = previewSqlOf("220_note_versions.sql");
/** Migration 231's block (a tag's description and whiteboard versions; history batch 8). */
export const TAG_PREVIEW_SQL = previewSqlOf("231_tag_description_versions.sql");
