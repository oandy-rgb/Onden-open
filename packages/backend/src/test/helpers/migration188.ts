// Migration 188 (saved views into function_refs) as SQL text, for tests that replay an older migration or write
// the pre-188 collection_views column by hand and then need the app to see those views.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedQ } from "./seedQ.js";

export const MIGRATION_188 = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/188_views_into_function_refs.sql"), "utf8");

/** Run migration 188 over every node (idempotent). */
export const moveViewsIntoRefs = (): Promise<unknown> => seedQ(MIGRATION_188);
