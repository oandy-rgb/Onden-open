// Moving the sign-in library from better-auth 1.6 to 1.7 (migration 219): the people who could sign in before can sign in after.
// The rows here are written the way 1.6.18 left them — the four tables as 1.6.18 created them, a password hash made by 1.6.18's hasher (@better-auth/utils 0.4.1,
// fixed below), a GitHub link, a session cookie signed the way 1.6.18 signed it — and then read back through 1.7's own sign-in.
// 1.7 reads two things more strictly than 1.6 did (see the migration's header): a password row must be keyed by its person's id, and a
// (provider, account id) pair must name one row. The migration fixes the first where the answer is certain and refuses to start otherwise.
// SAFETY: only runs against a *_test database; skips otherwise.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowUnstampedWrite, q, withTransaction } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

process.env.ONDEN_SIGNUP = "first-only"; // the owner's rule: only the first account; auth.ts reads it once, at import
const { auth, resolveAuthSecret } = await import("../auth.js");

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/219_sign_in_rows_for_better_auth_1_7.sql"), "utf8");

// The four tables exactly as better-auth 1.6.18's runMigrations() made them on PostgreSQL (read back from its catalog on 2026-11-20:
// column types, nullability, defaults, the generated constraint and index names). The test starts from these, not from what 1.7 makes.
// 1.7.3 and later ask for exactly this: 1.7.0–1.7.2's required `issuer` column and its unique index were taken back in 1.7.3
// (better-auth PR #11153), and this repo never ran 1.7.0–1.7.2.
const AUTH_TABLES = ["account", "session", "user", "verification"];
const DDL_1_6_18 = `
  CREATE TABLE "user" (id text NOT NULL PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, "emailVerified" boolean NOT NULL, image text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);
  CREATE TABLE session (id text NOT NULL PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE);
  CREATE TABLE account (id text NOT NULL PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL);
  CREATE TABLE verification (id text NOT NULL PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL);
  CREATE INDEX "session_userId_idx" ON session ("userId");
  CREATE INDEX "account_userId_idx" ON account ("userId");
  CREATE INDEX verification_identifier_idx ON verification (identifier);`;

/** Everything about the four tables that a sign-in depends on, in one schema, with the schema's name taken out so two schemas compare. */
async function authCatalog(schema: string) {
  const unqualified = (text: string) => text.replaceAll(`${schema}.`, "");
  const columns = (await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position`, [schema, AUTH_TABLES])).rows;
  const indexes = (await q<{ tablename: string; indexname: string; indexdef: string }>(`SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = $1 AND tablename = ANY($2::text[]) ORDER BY tablename, indexname`, [schema, AUTH_TABLES])).rows.map((row) => ({ ...row, indexdef: unqualified(row.indexdef) }));
  const constraints = (await q<{ table: string; name: string; def: string }>(`SELECT c.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY c.relname, con.conname`, [schema, AUTH_TABLES])).rows.map((row) => ({ ...row, def: unqualified(row.def) }));
  return { columns, indexes, constraints };
}

/** Run statements in one transaction with `schema` first on the search path (SET LOCAL ends with the transaction). */
const inSchema = <T>(schema: string, fn: () => Promise<T>) => allowUnstampedWrite("test fixture", () => withTransaction(async () => {
  await q(`SET LOCAL search_path TO ${schema}`);
  return fn();
}));

// Made by @better-auth/utils 0.4.1 (what better-auth 1.6.18 hashed passwords with): scrypt N=16384 r=16 p=1, "salt:key" in hex.
const OWNER_PASSWORD = "owner-password-from-1.6";
const OWNER_HASH_1_6 = "f7f436472c786d525a936ab67bcb745e:8a1b821283b71f6d68df20e47b89f302bb8bfadf62224432758516b7b4b1c87a525b14688968b20810930b980422cc0a262f479417a922d9eab48a96901471bf";
const LEGACY_PASSWORD = "legacy-password-from-1.6";
const LEGACY_HASH_1_6 = "7861a4897ccc61827e338827d625200b:df7a831d1afc38d50172e7837f86744393be31913fcce01cdb27e5de94bc020710fc2556c458ca661a16bdf3e1fd8eb595e5ae403778abe0846623c04b30e130";

/** How better-call 1.3.6 (under better-auth 1.6.18) signed a cookie value: `value.base64(HMAC-SHA256(secret, value))`, URI-encoded. */
const signedCookie1_6 = (value: string, secret: string) => encodeURIComponent(`${value}.${createHmac("sha256", secret).update(value).digest("base64")}`);

describe.skipIf(!isTestDatabase())("better-auth 1.6 → 1.7: migration 219 keeps every sign-in working", () => {
  const made: string[] = [];
  const tag = randomUUID().slice(0, 8);
  const mail = (who: string) => `${who}-${tag}@upgrade-17.test`;

  async function person(who: string, rows: { providerId: string; accountId?: string; password?: string }[]): Promise<string> {
    const userId = randomUUID();
    made.push(userId);
    await seedQ(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, now(), now())`, [userId, who, mail(who)]);
    for (const row of rows) {
      await seedQ(`INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [randomUUID(), row.accountId ?? userId, row.providerId, userId, row.password ?? null]);
    }
    return userId;
  }
  const accountsOf = async (userId: string) =>
    (await q<{ providerId: string; accountId: string; password: string | null }>(`SELECT "providerId", "accountId", password FROM "account" WHERE "userId" = $1 ORDER BY "providerId", "accountId"`, [userId])).rows;
  const signIn = (who: string, password: string) => auth.api.signInEmail({ body: { email: mail(who), password } });
  const refusal = (promise: Promise<unknown>) => promise.then(() => "applied", (error: Error) => error.message);

  let owner = "", legacy = "", social = "";
  const githubId = `gh-${tag}`;

  let reference: Awaited<ReturnType<typeof authCatalog>>, before17: typeof reference, after17: typeof reference;
  beforeAll(async () => {
    // What 1.6.18 made, built in a schema of its own so it can be compared with the shared one.
    const ref = `m219_ref_${tag}`;
    try {
      await seedQ(`CREATE SCHEMA ${ref}`);
      await inSchema(ref, () => q(DDL_1_6_18));
      reference = await authCatalog(ref);
    } finally {
      await seedQ(`DROP SCHEMA IF EXISTS ${ref} CASCADE`);
    }
    // The shared database starts from 1.6.18's tables: made here when no file has made them yet, otherwise checked to be the same below.
    if ((await q<{ t: string | null }>(`SELECT to_regclass('public.account')::text AS t`)).rows[0]!.t === null) await inSchema("public", () => q(DDL_1_6_18));
    before17 = await authCatalog("public");
    await (await auth.$context).runMigrations(); // what the backend does on boot, now with 1.7
    after17 = await authCatalog("public");

    owner = await person("owner", [{ providerId: "credential", password: OWNER_HASH_1_6 }, { providerId: "github", accountId: githubId }]);
    // A password row keyed by the email instead of the person's id: 1.6 signed it in, 1.7 does not look at it.
    legacy = await person("legacy", [{ providerId: "credential", accountId: mail("legacy"), password: LEGACY_HASH_1_6 }]);
    social = await person("social", [{ providerId: "google", accountId: `google-${tag}` }]);
  }, 60_000);

  afterAll(async () => {
    if (made.length) await seedQ(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [made]); // account and session rows go with it (ON DELETE CASCADE)
  });

  it("the tables start as 1.6.18 made them, and 1.7's own migration changes nothing in them: no column, type, default, index or constraint", () => {
    expect(reference.columns.length).toBe(34); // the reference is real: 13 + 8 + 7 + 6 columns
    expect(before17).toEqual(reference);
    expect(after17).toEqual(reference);
  });

  it("after the migration: the owner's password, a password row 1.6 keyed by email, GitHub and Google all reach their person", async () => {
    const before = await accountsOf(owner);
    await seedQ(MIGRATION);

    expect((await signIn("owner", OWNER_PASSWORD)).user.id).toBe(owner);
    expect((await signIn("legacy", LEGACY_PASSWORD)).user.id).toBe(legacy);
    await expect(signIn("owner", "a wrong password")).rejects.toMatchObject({ body: { code: "INVALID_EMAIL_OR_PASSWORD" } });

    const ctx = await auth.$context;
    expect(await ctx.internalAdapter.findAccountOwnerByKey({ providerId: "github", accountId: githubId })).toMatchObject({ kind: "owned", user: { id: owner } });
    expect(await ctx.internalAdapter.findAccountOwnerByKey({ providerId: "google", accountId: `google-${tag}` })).toMatchObject({ kind: "owned", user: { id: social } });

    // Only the legacy row's key moved; its password, and every other row, are as they were.
    expect(await accountsOf(owner)).toEqual(before);
    expect(await accountsOf(legacy)).toEqual([{ providerId: "credential", accountId: legacy, password: LEGACY_HASH_1_6 }]);
  });

  it("a second run changes nothing", async () => {
    const snapshot = async () => [await accountsOf(owner), await accountsOf(legacy), await accountsOf(social)];
    await seedQ(MIGRATION); // the first run (the tests run in a shuffled order, so this one does not count on the test above)
    const before = await snapshot();
    await seedQ(MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect((await signIn("legacy", LEGACY_PASSWORD)).user.id).toBe(legacy);
  });

  it("someone signed in under 1.6 stays signed in: 1.7 reads the session cookie 1.6 set", async () => {
    const token = `t-${randomUUID()}`;
    await seedQ(`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ($1, now() + interval '1 day', $2, now(), now(), $3)`, [randomUUID(), token, owner]);
    const cookie = `better-auth.session_token=${signedCookie1_6(token, resolveAuthSecret())}`;
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id).toBe(owner);
  });

  it("sign-up stays closed after the first account (ONDEN_SIGNUP first-only)", async () => {
    await expect(auth.api.signUpEmail({ body: { name: "Stranger", email: mail("stranger"), password: "a-long-enough-password" } }))
      .rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
    expect((await q(`SELECT 1 FROM "user" WHERE email = $1`, [mail("stranger")])).rows).toEqual([]);
  });

  it("two rows with the same provider and account id: refuses to start and changes nothing (1.7 would refuse that sign-in)", async () => {
    const twin = `twin-${tag}`;
    const a = await person("twin-a", [{ providerId: "github", accountId: twin }]);
    const b = await person("twin-b", [{ providerId: "github", accountId: twin }, { providerId: "credential", accountId: mail("twin-b"), password: LEGACY_HASH_1_6 }]);
    const before = [await accountsOf(a), await accountsOf(b)];
    expect(await refusal(seedQ(MIGRATION))).toMatch(/219.*github/s);
    expect([await accountsOf(a), await accountsOf(b)]).toEqual(before); // not even the unambiguous password row moved
    await seedQ(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[a, b]]);
  });

  it("a person whose password rows give no single answer: refuses to start and changes nothing", async () => {
    const torn = await person("torn", [
      { providerId: "credential", accountId: `${mail("torn")}-1`, password: OWNER_HASH_1_6 },
      { providerId: "credential", accountId: `${mail("torn")}-2`, password: LEGACY_HASH_1_6 },
    ]);
    const before = await accountsOf(torn);
    expect(await refusal(seedQ(MIGRATION))).toMatch(/219.*credential/s);
    expect(await accountsOf(torn)).toEqual(before);
    await seedQ(`DELETE FROM "user" WHERE id = $1`, [torn]);
  });

  it("a fresh database (the library makes its tables after migrate()): nothing to do, and it reaches no other schema's tables", async () => {
    const fresh = `m219_fresh_${tag}`;
    // A row the migration would re-key if it read the shared account table.
    const stray = await person("stray", [{ providerId: "credential", accountId: mail("stray"), password: LEGACY_HASH_1_6 }]);
    try {
      await seedQ(`CREATE SCHEMA ${fresh}`);
      const seen = await inSchema(fresh, async () => {
        const where = (await q<{ schema: string; account: string | null }>(`SELECT current_schema() AS schema, to_regclass('account')::text AS account`)).rows[0];
        await q(MIGRATION);
        return where;
      });
      expect(seen).toEqual({ schema: fresh, account: null }); // it ran where there is no account table
      expect(await accountsOf(stray)).toEqual([{ providerId: "credential", accountId: mail("stray"), password: LEGACY_HASH_1_6 }]);
      expect(await refusal(signIn("stray", LEGACY_PASSWORD))).toMatch(/Invalid email or password/); // still the 1.6 shape, so 1.7 still refuses it
    } finally {
      await seedQ(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
      await seedQ(`DELETE FROM "user" WHERE id = $1`, [stray]);
    }
  });
});
