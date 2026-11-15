import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Migration 135's SQL as it can run on today's schema: its module tag step also set content_nodes.tag_is_inheritable,
 *  a column migration 185 dropped, so that one assignment is left out. Tests that replay 135 on the current database
 *  read it from here. */
export function migration135Sql(): string {
  const sql = readFileSync(fileURLToPath(new URL("../../../db/migrations/135_tasks_module.sql", import.meta.url)), "utf8");
  const line = /^\s*tag_is_inheritable = COALESCE\(t\.tag_is_inheritable, false\),\n/m;
  if (!line.test(sql)) throw new Error("migration 135 no longer sets tag_is_inheritable: drop this helper");
  return sql.replace(line, "");
}
