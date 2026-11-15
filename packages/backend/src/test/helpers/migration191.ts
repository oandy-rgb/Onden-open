// Migration 191 (tasks into function_refs) as SQL text, for tests that replay an older migration or write the pre-191
// shape (task nodes tagged with the tasks module's tag) by hand and then need the app to see those tasks.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const migration191Sql = (): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/191_tasks_into_function_refs.sql"), "utf8");
