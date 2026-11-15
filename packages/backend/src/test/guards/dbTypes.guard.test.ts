// Guard: src/dbSchema.generated.ts is what `npm run db:types` produces from the migrations as they are now.
// A migration that changes a table without regenerating leaves `db` (dbKysely.ts) typed against the old schema.
// Runs the generator in its own process on a throwaway in-memory PGlite, so it does not depend on the test database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND = join(import.meta.dirname, "..", "..", "..");

describe("generated database types", () => {
  it("match the migrations (run `npm run db:types` if this fails)", () => {
    const dir = mkdtempSync(join(tmpdir(), "onden-dbtypes-"));
    try {
      const out = join(dir, "schema.generated.ts");
      execFileSync(process.execPath, ["--import", "tsx", "scripts/db-types.ts", "--out", out], {
        cwd: BACKEND,
        stdio: "pipe",
        env: { ...process.env, ONDEN_DB_DRIVER: "pglite", ONDEN_PGLITE_DIR: "memory://" },
      });
      const fresh = readFileSync(out, "utf8");
      const committed = readFileSync(join(BACKEND, "src", "dbSchema.generated.ts"), "utf8");
      expect(fresh === committed, "src/dbSchema.generated.ts is out of date with the migrations: run `npm run db:types` in packages/backend and commit the result").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
