// `db` (dbKysely.ts) runs through q(): it joins the open transaction, rolls back with it, and uses the
// pool outside one. Runs on whichever engine this run uses (real Postgres or PGlite).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { dbDriver, q, withSavepoint, withTransaction } from "../db.js";
import { db } from "../dbKysely.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const slugs: string[] = [];
const newSlug = () => { const s = `kysely-${randomUUID()}`; slugs.push(s); return s; };
const insertWorkspace = (slug: string) => db.insertInto("workspaces").values({ name: "kysely probe", slug }).returning("id").executeTakeFirstOrThrow();
const hasWorkspace = async (slug: string) => (await db.selectFrom("workspaces").select("id").where("slug", "=", slug).executeTakeFirst()) !== undefined;

describe.skipIf(!isTestDb)(`db (Kysely) on ${dbDriver}`, () => {
  afterAll(async () => { await q("DELETE FROM workspaces WHERE slug = ANY($1)", [slugs]); });

  it("a write inside withTransaction is visible outside after commit", async () => {
    const slug = newSlug();
    await withTransaction(async () => { await insertWorkspace(slug); });
    expect(await hasWorkspace(slug)).toBe(true);
  });

  it("a write inside withTransaction disappears with the rollback", async () => {
    const slug = newSlug();
    await expect(withTransaction(async () => {
      await insertWorkspace(slug);
      expect(await hasWorkspace(slug)).toBe(true);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await hasWorkspace(slug)).toBe(false);
  });

  it("shares the transaction with q(): each sees the other's uncommitted rows", async () => {
    const slug = newSlug();
    await expect(withTransaction(async () => {
      await q("INSERT INTO workspaces (name, slug) VALUES ('kysely probe', $1)", [slug]);
      expect(await hasWorkspace(slug)).toBe(true);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await hasWorkspace(slug)).toBe(false);
  });

  it("a savepoint rolls back only its own Kysely writes", async () => {
    const kept = newSlug();
    const dropped = newSlug();
    await withTransaction(async () => {
      await insertWorkspace(kept);
      await expect(withSavepoint(async () => { await insertWorkspace(dropped); throw new Error("inner"); })).rejects.toThrow("inner");
    });
    expect(await hasWorkspace(kept)).toBe(true);
    expect(await hasWorkspace(dropped)).toBe(false);
  });

  it("reports affected rows and refuses its own transactions", async () => {
    const slug = newSlug();
    await insertWorkspace(slug);
    const result = await db.updateTable("workspaces").set({ name: "renamed" }).where("slug", "=", slug).executeTakeFirst();
    expect(result.numUpdatedRows).toBe(1n);
    await expect(db.transaction().execute(async () => {})).rejects.toThrow(/withTransaction/);
  });
});
