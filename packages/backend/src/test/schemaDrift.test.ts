// Schema-drift guard (升級遷移). Pure file check — runs in the DB-free lane,
// every time, no Postgres needed. schema.sql is the generated snapshot a fresh
// deploy loads (initdb) so that migrate() is a no-op on boot; it pre-seeds
// schema_migrations with EVERY migration version. If you add a migration and
// forget to seed it in schema.sql (the exact manual step 054 needed), a fresh
// deploy would re-apply that migration on top of the snapshot — at best a
// no-op, at worst a double-apply error. This test fails the moment the two
// drift apart, so the snapshot can't silently fall behind db/migrations/.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // …/src/test
const migrationsDir = resolve(here, "../../db/migrations");
const schemaPath = resolve(here, "../../db/schema.sql");

describe("schema.sql stays in sync with db/migrations", () => {
  const versions = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  const schema = readFileSync(schemaPath, "utf-8");

  it("has migration files to check", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  it("seeds every migration version in schema_migrations", () => {
    const missing = versions.filter(
      (v) => !schema.includes(`VALUES ('${v}')`),
    );
    expect(missing, `schema.sql is missing schema_migrations seeds for: ${missing.join(", ")}`).toEqual([]);
  });
});
