// Moving the sign-in library from better-auth 1.6 to 1.7 (migration 219): the people who could sign in before can sign in after.
// The rows here are written the way 1.6.18 left them — the four tables, a password hash made by 1.6.18's hasher (@better-auth/utils 0.4.1,
// fixed below), a GitHub link, a session cookie signed the way 1.6.18 signed it — and then read back through 1.7's own sign-in.
// 1.7 reads two things more strictly than 1.6 did (see the migration's header): a password row must be keyed by its person's id, and a
// (provider, account id) pair must name one row. The migration fixes the first where the answer is certain and refuses to start otherwise.
// SAFETY: only runs against a *_test database; skips otherwise.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

process.env.ONDEN_SIGNUP = "first-only"; // the owner's rule: only the first account; auth.ts reads it once, at import
const { auth, resolveAuthSecret } = await import("../auth.js");

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/219_sign_in_rows_for_better_auth_1_7.sql"), "utf8");

// The columns better-auth 1.6.18 made (read from its runMigrations() on 2026-11-20). 1.7.3 and later ask for exactly these: 1.7.0–1.7.2's
// required `issuer` column and its unique index were taken back in 1.7.3 (better-auth PR #11153), and this repo never ran 1.7.0–1.7.2.
const COLUMNS_1_6_18: Record<string, string[]> = {
  account: ["id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"],
  session: ["id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"],
  user: ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"],
  verification: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"],
};

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

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    owner = await person("owner", [{ providerId: "credential", password: OWNER_HASH_1_6 }, { providerId: "github", accountId: githubId }]);
    // A password row keyed by the email instead of the person's id: 1.6 signed it in, 1.7 does not look at it.
    legacy = await person("legacy", [{ providerId: "credential", accountId: mail("legacy"), password: LEGACY_HASH_1_6 }]);
    social = await person("social", [{ providerId: "google", accountId: `google-${tag}` }]);
  }, 60_000);

  afterAll(async () => {
    if (made.length) await seedQ(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [made]); // account and session rows go with it (ON DELETE CASCADE)
  });

  it("1.7 asks for the same tables and columns 1.6.18 made: the upgrade adds no column", async () => {
    const { rows } = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`,
      [Object.keys(COLUMNS_1_6_18)]);
    const actual: Record<string, string[]> = {};
    for (const row of rows) (actual[row.table_name] ??= []).push(row.column_name);
    expect(actual).toEqual(COLUMNS_1_6_18);
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

  it("a fresh database (the library makes its tables after migrate()): nothing to do, no error", async () => {
    const schema = `m219_fresh_${tag}`;
    try {
      await seedQ(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; ${MIGRATION}`);
    } finally {
      await seedQ(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
