// Migration 126 (roles-owner-member proposal §7.3, §8.1, §8.3): nobody and no
// token reaches more after the conversion than before.
//
// Runs on a SCRATCH database built from db/schema.sql and put back into the
// legacy shape (LEGACY_SHAPE_SQL below; schema.sql itself already carries 126),
// so the legacy data can be written as it really looked:
//   1. seed workspace data with the old vocabulary (member roles, manager,
//      token read/write lists, issuer clamp, revoked / expired / issuer-removed
//      tokens, a pending invite, a workspace with no owner);
//   2. take the BEFORE picture with the frozen legacy rule (helpers/
//      accessSnapshot.ts legacyAccessSnapshot, plain SQL);
//   3. apply db/migrations/127_owner_member.sql;
//   4. take the AFTER picture with the application code, bound to the scratch
//      database;
//   5. assert after ⊆ before for every person and every token, plus the exact
//      conversions and the audit log.
//
// SAFETY: needs a *_test DATABASE_URL (it creates/drops its own `…_test`
// scratch database next to it); skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { legacyAccessSnapshot, snapshotAll, wideningsOf, type AccessSnapshot } from "./helpers/accessSnapshot.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../db");
const SCRATCH = "onden_ownermember_scratch_test";
const WRITE_TOOLS = ["searchNodes", "getNode", "applyTag", "createNode"];
const READ_TOOLS = ["searchNodes", "getNode"];

const urlFor = (name: string) => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${name}`; return u.toString(); };

/** The pre-127 shape of the four things migration 127 changes, rebuilt on a
 *  database loaded from the current schema.sql (which includes 126): the role
 *  columns, the token space lists, and the signup trigger that read the role.
 *  Empty tables only (schema.sql seeds just the System actor). */
const LEGACY_SHAPE_SQL = `
  ALTER TABLE actors ADD COLUMN role text NOT NULL DEFAULT 'editor';
  UPDATE actors SET role = 'admin' WHERE external_id = 'system';
  ALTER TABLE actors ADD CONSTRAINT actors_role_check CHECK (role IN ('viewer', 'editor', 'reviewer', 'admin'));
  ALTER TABLE space_members ADD COLUMN role text;
  UPDATE space_members SET role = CASE permission WHEN 'view' THEN 'viewer' ELSE 'manager' END;
  ALTER TABLE space_members ALTER COLUMN role SET NOT NULL;
  ALTER TABLE space_members ADD CONSTRAINT space_members_role_check CHECK (role IN ('viewer', 'editor', 'manager'));
  -- the member stamp triggers (migration 199) read the permission column, which the legacy shape does not have
  DROP TRIGGER IF EXISTS space_members_sync_stamp_insert ON space_members;
  DROP TRIGGER IF EXISTS space_members_sync_stamp_update ON space_members;
  DROP TRIGGER IF EXISTS space_members_sync_stamp_delete ON space_members;
  ALTER TABLE space_members DROP COLUMN permission;
  ALTER TABLE agent_tokens ADD COLUMN read_space_ids uuid[], ADD COLUMN write_space_ids uuid[];
  ALTER TABLE agent_tokens DROP COLUMN access;
  DROP TABLE owner_member_migration_log;
  DELETE FROM schema_migrations WHERE version = '127_owner_member';
  -- 127 (the owner guard) came after 126: step back over it too.
  DROP TRIGGER IF EXISTS workspaces_guard_owner ON workspaces;
  ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_owner_actor_id_fkey;
  ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_actor_id_fkey FOREIGN KEY (owner_actor_id) REFERENCES actors(id) ON DELETE SET NULL;
  DELETE FROM schema_migrations WHERE version = '128_owner_guard';
  CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger AS $$
  DECLARE
    personal uuid;
    became_owner boolean := false;
  BEGIN
    IF NEW.type = 'human' AND NEW.role = 'admin' THEN
      UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
      became_owner := FOUND;
    END IF;
    IF became_owner THEN
      INSERT INTO space_members (space_id, actor_id, role)
      SELECT s.id, NEW.id, 'manager' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
      ON CONFLICT (space_id, actor_id) DO NOTHING;
    END IF;
    IF NEW.type = 'human' AND NOT EXISTS (
         SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
      INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
      VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
              jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
                'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
      RETURNING id INTO personal;
      INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
    END IF;
    RETURN NULL;
  END $$ LANGUAGE plpgsql;
`;

/** schema.sql is pg_dump output; psql-only `\` lines go. A server without an
 *  extension it names (pgroonga, or a pre-17 server's `transaction_timeout`)
 *  gets the same dump with those lines dropped: nothing here searches text. */
async function loadSchema(c: pg.Client): Promise<void> {
  const raw = (await readFile(resolve(dbDir, "schema.sql"), "utf-8")).split("\n").filter((l) => !l.startsWith("\\"));
  try { await c.query(raw.join("\n")); }
  catch {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await c.query(raw.filter((l) => !/pgroonga|transaction_timeout/i.test(l)).join("\n"));
  }
}

describe.skipIf(!isTestDatabase() || needsPostgresServer)("migration 127: owner / member (scratch database)", () => {
  let c: pg.Client;
  let ready = false;
  let WS = "", WS2 = "";
  const id: Record<string, string> = {};
  const sp: Record<string, string> = {};
  const tok: Record<string, string> = {};
  let before: Record<string, AccessSnapshot> = {};
  let after: Record<string, AccessSnapshot> = {};
  let epochBefore = 0n;

  const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await c.query(sql, params)).rows[0] as T;
  const actor = async (ws: string, name: string, type: "human" | "agent", role: string, extra: { ext?: string | null; email?: string } = {}) => {
    const ext = extra.ext === undefined ? (type === "human" ? `ext-${name}` : null) : extra.ext;
    return (await one<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, role, external_id, invite_email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [ws, name, type, role, ext, extra.email ?? null])).id;
  };
  const space = async (name: string, ai: boolean) => (await one<{ id: string }>(
    `INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1,$2,'shared',$3) RETURNING id::text`,
    [WS, name, JSON.stringify({ publish: false, external_ai: ai, backup: true, shared_seen: false })])).id;
  const member = (spaceId: string, actorId: string, role: "viewer" | "editor" | "manager") =>
    c.query(`INSERT INTO space_members (space_id, actor_id, role) VALUES ($1,$2,$3) ON CONFLICT (space_id, actor_id) DO UPDATE SET role = EXCLUDED.role`, [spaceId, actorId, role]);
  const token = async (key: string, actorId: string, o: {
    tools?: string[] | null; read?: string[] | null; write?: string[] | null; issuer?: string | null; revoked?: boolean; expired?: boolean; issuerRemoved?: boolean;
  } = {}) => {
    tok[key] = (await one<{ id: string }>(
      `INSERT INTO agent_tokens (actor_id, token_hash, name, allowed_tools, read_space_ids, write_space_ids, issued_by, revoked_at, expires_at, issuer_removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
      [actorId, `hash-${key}`, key, o.tools === undefined ? null : o.tools, o.read ?? null, o.write ?? null, o.issuer ?? null,
        o.revoked ? new Date() : null, o.expired ? new Date(Date.now() - 60_000) : null, o.issuerRemoved ? new Date() : null])).id;
  };
  const subject = (key: string) => `token:${tok[key]}`;
  const person = (key: string) => `person:${id[key]}`;
  const names = (xs: string[]) => xs.map((s) => Object.entries(sp).find(([, v]) => v === s)?.[0] ?? s).sort();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: urlFor("postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    await admin.end();
    c = new pg.Client({ connectionString: urlFor(SCRATCH) });
    await c.connect();
    await loadSchema(c);
    const hasRole = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'actors' AND column_name = 'role'`)).rows.length > 0;
    if (!hasRole) await c.query(LEGACY_SHAPE_SQL); // schema.sql carries 126; step back to the legacy shape
    ready = true;
    // Migrations newer than the snapshot but before this one (none today).
    const applied = new Set((await c.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version as string));
    const files = (await readdir(resolve(dbDir, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (applied.has(version) || version >= "127_owner_member") continue;
      await c.query("BEGIN"); await c.query(await readFile(resolve(dbDir, "migrations", f), "utf-8"));
      await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]); await c.query("COMMIT");
    }

    // ── legacy workspace ───────────────────────────────────────────────────
    // schema.sql carries the default workspace (and its System actor) already.
    WS = (await one<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('M', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`)).id;
    id.owner = await actor(WS, "owner", "human", "admin");         // the first admin: owner (trigger)
    id.admin2 = await actor(WS, "admin2", "human", "admin");        // an admin, not the owner
    id.reviewer = await actor(WS, "reviewer", "human", "reviewer");
    id.mgr = await actor(WS, "mgr", "human", "editor");             // manager of shared space A
    id.ed = await actor(WS, "ed", "human", "editor");
    id.vw = await actor(WS, "vw", "human", "viewer");
    id.invite = await actor(WS, "invite", "human", "editor", { ext: null, email: "invitee@example.com" });
    for (const n of ["bot1", "bot2", "bot3", "bot4", "bot5", "bot6"]) id[n] = await actor(WS, n, "agent", n === "bot1" ? "admin" : "editor");

    sp.A = await space("A", true); sp.B = await space("B", false); sp.C = await space("C", true); sp.D = await space("D", true);
    for (const s of Object.values(sp)) await member(s, id.owner!, "manager");
    await member(sp.A!, id.mgr!, "manager"); await member(sp.A!, id.ed!, "editor"); await member(sp.A!, id.vw!, "viewer");
    await member(sp.A!, id.admin2!, "editor"); await member(sp.A!, id.reviewer!, "editor"); await member(sp.A!, id.invite!, "editor");
    await member(sp.B!, id.ed!, "editor");
    await member(sp.C!, id.ed!, "viewer"); await member(sp.C!, id.vw!, "viewer");
    // bot1: one unrestricted token (no tool list = every tool).
    for (const [s, r] of [["A", "editor"], ["B", "editor"], ["C", "editor"], ["D", "viewer"]] as const) await member(sp[s]!, id.bot1!, r);
    await token("bot1.all", id.bot1!);
    // bot2: two read tokens with different read lists -> intersection.
    await member(sp.A!, id.bot2!, "editor"); await member(sp.C!, id.bot2!, "editor");
    await token("bot2.a", id.bot2!, { tools: READ_TOOLS, read: [sp.A!] });
    await token("bot2.ac", id.bot2!, { tools: READ_TOOLS, read: [sp.A!, sp.C!] });
    // bot3: two write tokens with different write lists -> edit only where both write.
    await member(sp.A!, id.bot3!, "editor"); await member(sp.C!, id.bot3!, "editor");
    await token("bot3.a", id.bot3!, { tools: WRITE_TOOLS, write: [sp.A!] });
    await token("bot3.ac", id.bot3!, { tools: WRITE_TOOLS, write: [sp.A!, sp.C!] });
    // bot4: a token clamped by its issuer ed (A editor, C viewer, not in B or D).
    for (const s of ["A", "B", "C", "D"]) await member(sp[s]!, id.bot4!, "editor");
    await token("bot4.issuedByEd", id.bot4!, { tools: WRITE_TOOLS, issuer: id.ed! });
    // bot5: a revoked token and an issuer-removed one; bot6: an expired one.
    await member(sp.A!, id.bot5!, "editor"); await member(sp.A!, id.bot6!, "editor");
    await token("bot5.revoked", id.bot5!, { tools: WRITE_TOOLS, revoked: true });
    await token("bot5.issuerRemoved", id.bot5!, { tools: WRITE_TOOLS, issuerRemoved: true });
    await token("bot6.expired", id.bot6!, { tools: READ_TOOLS, expired: true });

    // A second workspace that lost its owner: its earliest signed-in human admin becomes it.
    WS2 = (await one<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('W2', 'w2') RETURNING id::text`)).id;
    id.w2first = await actor(WS2, "w2first", "human", "admin");
    id.w2second = await actor(WS2, "w2second", "human", "admin");
    await c.query(`UPDATE workspaces SET owner_actor_id = NULL WHERE id = $1`, [WS2]);

    epochBefore = BigInt((await one<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).e);
    before = await snapshotAll(c, WS, "legacy");

    // ── the migration ──────────────────────────────────────────────────────
    await c.query("BEGIN");
    await c.query(await readFile(resolve(dbDir, "migrations", "127_owner_member.sql"), "utf-8"));
    await c.query("INSERT INTO schema_migrations (version) VALUES ('127_owner_member')");
    await c.query("COMMIT");

    // ── after, by the application code bound to the scratch database ───────
    const savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = urlFor(SCRATCH);
    vi.resetModules();
    try {
      const snap = await import("./helpers/accessSnapshot.js");
      const dbmod = await import("../db.js");
      after = await snap.snapshotAll(c, WS, "current");
      await dbmod.pool.end();
    } finally {
      process.env.DATABASE_URL = savedUrl;
      vi.resetModules();
    }
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    const admin = new pg.Client({ connectionString: urlFor("postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
  });

  const needsLegacy = (ctx: { skip: () => void }) => { if (!ready) ctx.skip(); };

  it("ran on a legacy schema", (ctx) => {
    needsLegacy(ctx);
    expect(Object.keys(before).length).toBeGreaterThan(15);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  it("§8.1.1–2: no person and no token can read, write or manage more than before", (ctx) => {
    needsLegacy(ctx);
    const widened = Object.keys(before).flatMap((key) => wideningsOf(before[key]!, after[key]!).map((w) => `${key} ${w}`));
    expect(widened).toEqual([]);
  });

  it("people keep reading and writing exactly what they did; only managing narrows", async (ctx) => {
    needsLegacy(ctx);
    for (const p of ["owner", "admin2", "reviewer", "mgr", "ed", "vw"]) {
      expect(after[person(p)]!.read, `${p} read`).toEqual(before[person(p)]!.read);
      expect(after[person(p)]!.write, `${p} write`).toEqual(before[person(p)]!.write);
    }
    // The owner still manages every shared space; a manager no longer manages the space they ran.
    expect(after[person("owner")]!.manage).toEqual(before[person("owner")]!.manage);
    expect(before[person("mgr")]!.manage).toContain(sp.A);
    expect(after[person("mgr")]!.manage).not.toContain(sp.A);
    expect(after[person("mgr")]!.write).toContain(sp.A); // edits it, though
    // Everyone still manages their own personal space.
    for (const p of ["ed", "vw", "mgr"]) {
      const own = (await one<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [id[p]!])).id;
      expect(after[person(p)]!.manage, `${p} manages their personal space`).toContain(own);
    }
  });

  it("§8.1.3: an issuer-removed token stays dead — and is revoked, so nothing can revive it", async (ctx) => {
    needsLegacy(ctx);
    expect(before[subject("bot5.issuerRemoved")]).toEqual({ read: [], write: [], manage: [] });
    expect(after[subject("bot5.issuerRemoved")]).toEqual({ read: [], write: [], manage: [] });
    const row = await one(`SELECT revoked_at FROM agent_tokens WHERE id = $1`, [tok["bot5.issuerRemoved"]]);
    expect(row.revoked_at).not.toBeNull();
    for (const k of ["bot5.revoked", "bot6.expired"]) expect(after[subject(k)]).toEqual({ read: [], write: [], manage: [] });
  });

  it("an agent with an unrestricted token keeps what the token could reach: A and C; B (AI off) and D (view only for writing) as before", (ctx) => {
    needsLegacy(ctx);
    expect(names(before[subject("bot1.all")]!.read)).toEqual(["A", "C", "D"]);
    expect(names(after[subject("bot1.all")]!.read)).toEqual(["A", "C", "D"]);
    expect(names(after[subject("bot1.all")]!.write)).toEqual(["A", "C"]);
  });

  it("decision 5, read side: two tokens with different read lists leave the agent the intersection", (ctx) => {
    needsLegacy(ctx);
    expect(names(before[subject("bot2.ac")]!.read)).toEqual(["A", "C"]);
    expect(names(after[subject("bot2.ac")]!.read)).toEqual(["A"]); // narrower: C is gone from the agent
    expect(names(after[subject("bot2.a")]!.read)).toEqual(["A"]);
  });

  it("decision 5, write side: edit only where every write token could write; elsewhere view", async (ctx) => {
    needsLegacy(ctx);
    expect(names(before[subject("bot3.ac")]!.write)).toEqual(["A", "C"]);
    expect(names(after[subject("bot3.ac")]!.write)).toEqual(["A"]);
    expect(names(after[subject("bot3.ac")]!.read)).toEqual(["A", "C"]); // still reads C, as view
    const perm = await one(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [sp.C, id.bot3]);
    expect(perm.permission).toBe("view");
  });

  it("§8.1.2: the issuer clamp does not become wider when the clamp rule is removed", async (ctx) => {
    needsLegacy(ctx);
    // ed is editor in A, viewer in C, outside B and D.
    expect(names(before[subject("bot4.issuedByEd")]!.read)).toEqual(["A", "C"]);
    expect(names(before[subject("bot4.issuedByEd")]!.write)).toEqual(["A"]);
    expect(names(after[subject("bot4.issuedByEd")]!.read)).toEqual(["A", "C"]);
    expect(names(after[subject("bot4.issuedByEd")]!.write)).toEqual(["A"]);
    // The agent itself no longer sits in the spaces its only token could not read.
    const left = (await c.query(`SELECT space_id::text FROM space_members WHERE actor_id = $1`, [id.bot4])).rows.map((r) => r.space_id as string);
    expect(names(left)).toEqual(["A", "C"]);
  });

  it("an agent with no live token keeps its membership (there is no credential to widen)", async (ctx) => {
    needsLegacy(ctx);
    for (const b of ["bot5", "bot6"]) {
      const rows = (await c.query(`SELECT space_id::text, permission FROM space_members WHERE actor_id = $1`, [id[b]])).rows;
      expect(rows.map((r) => r.space_id)).toEqual([sp.A]);
      expect(rows[0].permission).toBe("edit");
    }
  });

  it("converts member roles: viewer -> view; editor and manager -> edit; a pending invite keeps its seat", async (ctx) => {
    needsLegacy(ctx);
    const permission = async (s: string, a: string) =>
      (await one(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [sp[s], id[a]])).permission;
    expect(await permission("A", "vw")).toBe("view");
    expect(await permission("A", "ed")).toBe("edit");
    expect(await permission("A", "mgr")).toBe("edit");
    expect(await permission("A", "owner")).toBe("edit");
    expect(await permission("A", "invite")).toBe("edit");
  });

  it("token access: any write tool (or no tool list) -> write, else read; tool lists stay as stored", async (ctx) => {
    needsLegacy(ctx);
    const access = async (k: string) => await one(`SELECT access, allowed_tools FROM agent_tokens WHERE id = $1`, [tok[k]]);
    expect((await access("bot1.all")).access).toBe("write");
    expect((await access("bot1.all")).allowed_tools).toBeNull(); // "every tool" is kept, not narrowed
    expect((await access("bot2.a")).access).toBe("read");
    expect((await access("bot3.a")).access).toBe("write");
    expect((await access("bot3.a")).allowed_tools).toEqual(WRITE_TOOLS);
  });

  it("a workspace with no owner gets its earliest signed-in human admin; one with an owner is untouched", async (ctx) => {
    needsLegacy(ctx);
    expect((await one(`SELECT owner_actor_id::text AS o FROM workspaces WHERE id = $1`, [WS2])).o).toBe(id.w2first);
    expect((await one(`SELECT owner_actor_id::text AS o FROM workspaces WHERE id = $1`, [WS])).o).toBe(id.owner);
  });

  it("the old columns are gone and the new ones are constrained", async (ctx) => {
    needsLegacy(ctx);
    const cols = async (table: string) => (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map((r) => r.column_name as string);
    expect(await cols("actors")).not.toContain("role");
    expect(await cols("space_members")).not.toContain("role");
    expect(await cols("agent_tokens")).not.toEqual(expect.arrayContaining(["read_space_ids"]));
    expect(await cols("agent_tokens")).not.toContain("write_space_ids");
    await expect(c.query(`UPDATE space_members SET permission = 'manager' WHERE space_id = $1 AND actor_id = $2`, [sp.A, id.ed])).rejects.toThrow(/space_members_permission_check/);
    await expect(c.query(`UPDATE agent_tokens SET access = 'admin' WHERE id = $1`, [tok["bot2.a"]])).rejects.toThrow(/agent_tokens_access_check/);
  });

  it("writes every change to the audit log, and nothing for people whose reach did not change", async (ctx) => {
    needsLegacy(ctx);
    const log = (await c.query(`SELECT step, subject_id::text, space_id::text FROM owner_member_migration_log ORDER BY id`)).rows;
    const has = (step: string, who: string, space?: string) => log.some((r) => r.step === step && r.subject_id === id[who] && (space === undefined || r.space_id === sp[space]));
    expect(has("review_lost", "admin2")).toBe(true);
    expect(has("review_lost", "reviewer")).toBe(true);
    expect(has("review_lost", "owner")).toBe(false);
    expect(has("manager_to_edit", "mgr", "A")).toBe(true);
    expect(has("manager_to_edit", "owner")).toBe(false);          // the owner manages by being the owner
    expect(has("agent_removed_from_space", "bot2", "C")).toBe(true);
    expect(has("agent_removed_from_space", "bot4", "B")).toBe(true);
    expect(has("agent_removed_from_space", "bot4", "D")).toBe(true);
    expect(has("agent_removed_from_space", "bot1", "B")).toBe(true); // AI is off there: its token never reached it
    expect(has("agent_edit_to_view", "bot3", "C")).toBe(true);
    expect(has("agent_edit_to_view", "bot4", "C")).toBe(true);
    expect(log.some((r) => r.step === "owner_filled" && r.subject_id === id.w2first)).toBe(true);
    expect(log.some((r) => r.step === "token_revoked_issuer_removed")).toBe(true);
    expect(log.some((r) => r.step === "token_all_tools")).toBe(true);
  });

  it("asks every client to re-check what they can read (membership epoch moves)", async (ctx) => {
    needsLegacy(ctx);
    const e = BigInt((await one(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).e);
    expect(e).toBeGreaterThan(epochBefore);
  });

  it("the frozen legacy rule still works on the scratch database before migration (helper sanity)", async (ctx) => {
    needsLegacy(ctx);
    // After migration the legacy columns are gone; this guards the helper's own contract.
    await expect(legacyAccessSnapshot(c, WS, { actorId: id.ed! })).rejects.toThrow();
    expect(before[person("ed")]!.read.length).toBeGreaterThan(0);
  });
});
