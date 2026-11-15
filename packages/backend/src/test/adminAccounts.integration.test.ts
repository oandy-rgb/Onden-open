// Container recovery commands (docs/self-host/recovery.md): reset-password,
// sessions revoke and users, against real better-auth accounts. Isolated
// *_test database only; skipped otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";

let ws: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const { auth } = await import("../auth.js");
const { run } = await import("../admin.js");
const { resetPassword, AdminCommandError, ADMIN_CLI_ACTOR_ID } = await import("../services/adminAccounts.js");

async function cli(...argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await run(argv, l => lines.push(l));
  return { code, text: lines.join("\n") };
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("admin recovery commands", () => {
  async function account() {
    const email = `${randomUUID()}@admin-cli.test`, password = `Old-${randomUUID()}!`;
    const up = await auth.api.signUpEmail({ body: { name: "Admin CLI", email, password } });
    return { userId: up.user.id, email, password };
  }
  const signIn = async (email: string, password: string) => {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    return { status: res.status, cookie: res.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ") };
  };
  const sessionOf = (cookie: string) => auth.api.getSession({ headers: new Headers({ cookie }) });
  const events = async (userId: string) => (await db.q<{ event_type: string; actor_type: string; actor_id: string; payload: unknown }>(
    "SELECT event_type, actor_type, actor_id, payload FROM domain_events WHERE workspace_id=$1 AND target_id=$2 ORDER BY id", [ws, userId])).rows;
  const hashOf = async (userId: string) => (await db.q<{ password: string }>(
    `SELECT password FROM "account" WHERE "userId"=$1 AND "providerId"='credential'`, [userId])).rows[0].password;

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Admin CLI',$1) RETURNING id", [randomUUID()])).rows[0].id;
  }, 30000);


  it("reset-password: old password and old sessions stop working, the new one signs in", async () => {
    const a = await account();
    const { cookie } = await signIn(a.email, a.password);
    expect(await sessionOf(cookie)).not.toBeNull();

    const { code, text } = await cli("reset-password", a.email);
    expect(code).toBe(0);
    const temp = /暫時密碼[^：]*：(\S+)/.exec(text)?.[1];
    expect(temp).toBeTruthy();
    expect(temp!.length).toBeGreaterThanOrEqual(20);

    await expect(auth.api.signInEmail({ body: { email: a.email, password: a.password } })).rejects.toThrow();
    expect((await signIn(a.email, temp!)).status).toBe(200);
    expect(await sessionOf(cookie)).toBeNull();
  });

  it("records a system event that holds neither the password nor its hash", async () => {
    const a = await account();
    const { text } = await cli("reset-password", a.email);
    const temp = /暫時密碼[^：]*：(\S+)/.exec(text)![1];
    const rows = await events(a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: "ADMIN_PASSWORD_RESET", actor_type: "system", actor_id: ADMIN_CLI_ACTOR_ID });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(temp);
    expect(dump).not.toContain(await hashOf(a.userId));
    expect(dump).not.toContain(a.email);
  });

  it("the same password rules as sign-up apply to a chosen password", async () => {
    const a = await account();
    await expect(resetPassword(a.email, "short")).rejects.toBeInstanceOf(AdminCommandError);
    await expect(resetPassword(a.email, "x".repeat(129))).rejects.toBeInstanceOf(AdminCommandError);
    expect((await signIn(a.email, a.password)).status).toBe(200);
    expect(await events(a.userId)).toEqual([]);
    await resetPassword(a.email, "a-chosen-password");
    expect((await signIn(a.email, "a-chosen-password")).status).toBe(200);
  });

  it("an unknown email or an account without a password changes nothing and records nothing", async () => {
    await expect(resetPassword(`${randomUUID()}@admin-cli.test`, "a-chosen-password")).rejects.toBeInstanceOf(AdminCommandError);
    const a = await account();
    await db.q(`DELETE FROM "account" WHERE "userId"=$1`, [a.userId]);
    await expect(resetPassword(a.email, "a-chosen-password")).rejects.toBeInstanceOf(AdminCommandError);
    expect(await events(a.userId)).toEqual([]);
  });

  it("sessions revoke ends every session and leaves the password alone", async () => {
    const a = await account();
    const one = await signIn(a.email, a.password), two = await signIn(a.email, a.password);
    const before = await hashOf(a.userId);
    const { code } = await cli("sessions", "revoke", a.email);
    expect(code).toBe(0);
    expect(await sessionOf(one.cookie)).toBeNull();
    expect(await sessionOf(two.cookie)).toBeNull();
    expect(await hashOf(a.userId)).toBe(before);
    expect((await signIn(a.email, a.password)).status).toBe(200);
    expect((await events(a.userId)).map(e => e.event_type)).toEqual(["ADMIN_SESSIONS_REVOKED"]);
  });

  it("users lists email, owner and last sign-in, and nothing sensitive", async () => {
    const a = await account();
    const { cookie } = await signIn(a.email, a.password);
    const { code, text } = await cli("users");
    expect(code).toBe(0);
    const line = text.split("\n").find(l => l.startsWith(a.email));
    expect(line).toContain("擁有者：");
    expect(line).toContain("最後登入：");
    expect(line).not.toContain("最後登入：—");
    const token = cookie.split("=")[1].split(".")[0];
    expect(text).not.toContain(await hashOf(a.userId));
    expect(text).not.toContain(decodeURIComponent(token));
    expect(text).not.toContain(a.userId);
  });

  it("--help lists every command; no arguments is a usage error", async () => {
    const help = await cli("--help");
    expect(help.code).toBe(0);
    for (const word of ["users", "reset-password", "sessions revoke", "--password-stdin"]) expect(help.text).toContain(word);
    expect((await cli()).code).toBe(1);
    expect((await cli("nope")).code).toBe(1);
  });
});
