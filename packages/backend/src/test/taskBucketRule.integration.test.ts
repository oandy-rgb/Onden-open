// The agenda bucket rule (taskBucketCaseSql) against the fixture the
// client's taskBucket also runs (frontend taskBucketRule.test.ts).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { q } from "../db.js";
import { taskBucketCaseSql } from "../services/tasksStore.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/taskBuckets.json"), "utf8")) as {
  now: string; cases: Array<{ status: string; when: string | null; someday: boolean; bucket: string }>;
};

describe.skipIf(!isTestDb)("agenda bucket rule (server)", () => {
  it("buckets every fixture case like the client does", async () => {
    // Pin "now": the rule takes today as an argument.
    const [date] = fixture.now.split("T");
    const rule = taskBucketCaseSql(date);
    const rows = await q<{ i: number; bucket: string }>(
      `SELECT c.i, ${rule} AS bucket
         FROM jsonb_to_recordset($1::jsonb) AS c(i int, status text, "when" text, someday text)
         CROSS JOIN LATERAL (SELECT c.status AS value) s
         CROSS JOIN LATERAL (SELECT c."when" AS value) w
         CROSS JOIN LATERAL (SELECT c.someday AS value) sd
        ORDER BY c.i`,
      [JSON.stringify(fixture.cases.map((k, i) => ({ i, status: k.status, when: k.when, someday: k.someday ? "true" : null })))],
    );
    expect(rows.rows.map((r) => r.bucket)).toEqual(fixture.cases.map((k) => k.bucket));
  });
});
