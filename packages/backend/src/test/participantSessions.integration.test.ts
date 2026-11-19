// Temporary sessions (services/participantSessions.ts), through the real assembled app: opening one, what it may do, how it is attributed, when it
// stops, what it can never do, and that its credential is kept secret. The reach of a session over other spaces is sessionScope.property.integration.test.ts.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { ticketWithoutEvidence } from "./helpers/freshProofTicket.js";
import { seedQ } from "./helpers/seedQ.js";
import { mountedRoutes } from "./helpers/appRoutes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { endTemporarySession, endTemporarySessionsOpenedBy, listTemporarySessions, openTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { UnauthorizedError } from "../spine/actor.js";
import { updateNode } from "../services/nodeUpdate.js";
import { startSession as startAgentSession } from "../services/agentSessions.js";
import { log } from "../logger.js";
import { startFocus } from "../modules/tasks/focus.js";
import { saveItem } from "../modules/rss/save.js";
import { readStampedPages } from "../services/stampedSnapshot.js";
import { seedClassTag } from "./helpers/seedClassTag.js";

registerShippedModules();

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@sessions.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

type World = Awaited<ReturnType<typeof standardWorld>>;
let w: World;
let noteA = "", noteB = "";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
async function call(path: string, auth: { cookie: string } | { credential: string }, init: Init = {}) {
  signedInAs = "cookie" in auth ? auth.cookie : null;
  try {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { ...("credential" in auth ? { authorization: `Bearer ${auth.credential}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  } finally { signedInAs = null; }
}
const asSession = (credential: string, path: string, init?: Init) => call(path, { credential }, init);
const asOwner = (path: string, init?: Init) => call(path, { cookie: w.owner.ext }, init);

async function open(spaces: Array<{ spaceId: string; permission: "view" | "edit" }>, extra: { minutes?: number; maxRequests?: number; maxBytes?: number } = {}) {
  return openAs(w.owner, ownWorkspace, { spaces, ...extra });
}

describe.skipIf(!isTestDatabase())("temporary sessions", () => {
  beforeAll(async () => {
    w = await standardWorld("sessions");
    ownWorkspace = w.ws;
    await turnModuleOn(w.ws, "ai"); // the AI routes exist: a session is refused by the rule, not by their absence
    noteA = await newNote(w.ws, "note in A", w.spaceA, "body A");
    noteB = await newNote(w.ws, "note in B", w.spaceB, "body B");
  });
  afterAll(async () => { await pool.end(); });

  describe("opening", () => {
    it("the owner opens one through the route: the credential comes back once, the label is the owner's wording, and only a hash is kept", async () => {
      const ticket = await ticketWithoutEvidence(w.owner.ctx, "open_session");
      const res = await asOwner("/api/spaces/sessions", {
        method: "POST", headers: { "x-onden-fresh-proof": ticket },
        body: { spaces: [{ space_id: w.spaceA, permission: "edit" }], minutes: 30 },
      });
      expect(res.status).toBe(201);
      // no name is sent or stored: the screen words a session from what it is (round 2 point 9; was the fixed 「你（臨時）」)
      expect(res.json).not.toHaveProperty("label");
      expect(res.json.credential).toMatch(/^onds_[A-Za-z0-9_-]{43}$/);
      expect(res.json.spaces).toEqual([{ space_id: w.spaceA, permission: "edit" }]);
      expect(new Date(res.json.expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(res.json.expires_at).toBeDefined();
      const row = (await q<{ credential_hash: string }>(`SELECT credential_hash FROM participant_sessions WHERE id = $1`, [res.json.session_id])).rows[0]!;
      expect(row.credential_hash).toBe(sha256(res.json.credential));
      expect(row.credential_hash).not.toContain(res.json.credential);
    });

    it("needs the fresh confirmation: no ticket, a spent ticket and a ticket for another purpose are all refused, and nothing is created", async () => {
      const before = (await q(`SELECT 1 FROM participant_sessions WHERE workspace_id = $1`, [w.ws])).rows.length;
      const body = { spaces: [{ space_id: w.spaceA, permission: "view" }] };
      expect((await asOwner("/api/spaces/sessions", { method: "POST", body })).json.error).toBe("fresh_proof_required");
      const ticket = await ticketWithoutEvidence(w.owner.ctx, "open_session");
      expect((await asOwner("/api/spaces/sessions", { method: "POST", body, headers: { "x-onden-fresh-proof": ticket } })).status).toBe(201);
      expect((await asOwner("/api/spaces/sessions", { method: "POST", body, headers: { "x-onden-fresh-proof": ticket } })).json.error).toBe("fresh_proof_used");
      const other = await ticketWithoutEvidence(w.owner.ctx, "snapshot_export");
      expect((await asOwner("/api/spaces/sessions", { method: "POST", body, headers: { "x-onden-fresh-proof": other } })).json.error).toBe("fresh_proof_invalid");
      expect((await q(`SELECT 1 FROM participant_sessions WHERE workspace_id = $1`, [w.ws])).rows.length).toBe(before + 1);
    });

    it("is the owner's: a member who is not the owner is refused, whatever ticket they hold", async () => {
      const ticket = await ticketWithoutEvidence(w.member.ctx, "open_session");
      const res = await call("/api/spaces/sessions", { cookie: w.member.ext }, { method: "POST", headers: { "x-onden-fresh-proof": ticket }, body: { spaces: [{ space_id: w.spaceA, permission: "view" }] } });
      expect(res.status).toBe(403);
    });

    it("gives a session only what the person holds now: a space they are not in, or edit where they only view, is 'not found' either way", async () => {
      const ownerViewOnly = await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, 'view only', 'shared', '{}'::jsonb) RETURNING id::text`, [w.ws]);
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'view')`, [ownerViewOnly.rows[0]!.id, w.owner.id]);
      await expect(open([{ spaceId: ownerViewOnly.rows[0]!.id, permission: "edit" }])).rejects.toMatchObject({ code: "session_space_unavailable" });
      await expect(open([{ spaceId: randomUUID(), permission: "view" }])).rejects.toMatchObject({ code: "session_space_unavailable" });
      await expect(open([])).rejects.toMatchObject({ code: "session_spaces_invalid" });
      const viewing = await open([{ spaceId: ownerViewOnly.rows[0]!.id, permission: "view" }]);
      expect(viewing.spaces).toEqual([{ spaceId: ownerViewOnly.rows[0]!.id, permission: "view" }]);
    });

    it("is capped: the time and the limits a request asks for are cut to the most a session may have", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "view" }], { minutes: 10_000_000, maxRequests: 10_000_000, maxBytes: Number.MAX_SAFE_INTEGER });
      const row = (await q<{ max_requests: number; max_bytes: string; mins: number }>(
        `SELECT max_requests, max_bytes::text, extract(epoch FROM expires_at - created_at) / 60 AS mins FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!;
      expect(row.max_requests).toBe(100_000);
      expect(row.max_bytes).toBe(String(1024 * 1024 * 1024));
      expect(Math.round(row.mins)).toBe(24 * 60);
    });
  });

  describe("acting", () => {
    it("reads and writes what it was opened on, as the person would, and is attributed to itself: the actor of the event and the author of the stamp; the device it names is not recorded", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const device = randomUUID();
      const read = await asSession(s.credential, `/api/nodes/${noteA}`);
      expect(read.status).toBe(200);
      const patched = await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", headers: { "x-onden-device-id": device }, body: { title: "edited from a stranger's computer", base_markdown: "body A", markdown: "body A\nmore" } });
      expect(patched.status).toBe(200);
      const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!.actor_id;
      const event = (await q<{ actor_id: string; actor_type: string; device_id: string | null }>(
        `SELECT actor_id, actor_type, device_id::text FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_UPDATED' AND target_id = $2 ORDER BY id DESC LIMIT 1`, [w.ws, noteA])).rows[0]!;
      // the untrusted computer's device id is not recorded (spine/authority.ts recordedDeviceId; was recorded before PR #1856, round 2 point 6)
      expect(event).toEqual({ actor_id: actorId, actor_type: "user", device_id: null });
      const stamp = (await q<{ author: string; device: string | null }>(
        `SELECT author, device::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'title'`, [w.ws, noteA])).rows[0]!;
      expect(stamp).toEqual({ author: actorId, device: null });
      expect((await q<{ name: string }>(`SELECT name FROM actors WHERE id = $1`, [actorId])).rows[0]!.name).toBe(""); // no text in one language
    });

    it("never writes where it only views, or in a space it was not given (the same refusal the person would meet there)", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "view" }]);
      const viewing = await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "no", base_markdown: "body A" } });
      expect(viewing.status).toBe(403);
      const elsewhere = await asSession(s.credential, `/api/nodes/${noteB}`, { method: "PATCH", body: { title: "no", base_markdown: "body B" } });
      expect([403, 404]).toContain(elsewhere.status);
      expect((await asSession(s.credential, `/api/nodes/${noteB}`)).status).toBe(404);
      const titles = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY title`, [[noteA, noteB]])).rows.map((r) => r.title);
      expect(titles).not.toContain("no");
    });

    it("a new top-level note lands in the one space it may write in; with two it must say which (a session has no personal space to fall back on)", async () => {
      const one = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const landed = await asSession(one.credential, "/api/nodes", { method: "POST", body: { title: "from the session", markdown: "", source_type: "manual" } });
      expect(landed.status).toBe(201);
      expect((await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [landed.json.id])).rows[0]!.space_id).toBe(w.spaceA);
      const two = await open([{ spaceId: w.spaceA, permission: "edit" }, { spaceId: w.spaceB, permission: "edit" }]);
      const unnamed = await asSession(two.credential, "/api/nodes", { method: "POST", body: { title: "where?", markdown: "", source_type: "manual" } });
      expect(unnamed.status).toBe(403);
      const named = await asSession(two.credential, "/api/nodes", { method: "POST", body: { title: "in B", markdown: "", source_type: "manual", space_id: w.spaceB } });
      expect(named.status).toBe(201);
      expect((await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [named.json.id])).rows[0]!.space_id).toBe(w.spaceB);
    });

    it("is never wider than the person: when they lose edit in a space, the session can no longer write there; when they leave it, it cannot read it", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      expect((await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "still fine", base_markdown: "body A\nmore" } })).status).toBe(200);
      try {
        await q(`UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2::uuid`, [w.spaceA, w.owner.id]);
        expect((await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "now refused", base_markdown: "body A\nmore" } })).status).toBe(403);
        expect((await asSession(s.credential, `/api/nodes/${noteA}`)).status).toBe(200);
        await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [w.spaceA, w.owner.id]);
        expect((await asSession(s.credential, `/api/nodes/${noteA}`)).status).toBe(404);
      } finally {
        // put the person back as they were, whatever the assertions above said, so a failure here cannot make the other tests fail too
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit') ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = 'edit'`, [w.spaceA, w.owner.id]);
      }
    });
  });

  describe("stopping", () => {
    it("a session past its stored time is refused by every route, with no timer having run", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      expect((await asSession(s.credential, "/api/bootstrap")).status).toBe(200);
      await q(`UPDATE participant_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);
      const statuses = new Map<string, number>();
      for (const r of mountedRoutes(app, (m) => m === "GET")) {
        if (/\/stream$/.test(r.path) || r.path.startsWith("/api/auth/") || r.path === "/health" || r.path === "/api/site" || r.path.startsWith("/api/site/") || r.path.startsWith("/api/media/")) continue;
        statuses.set(r.path, (await asSession(s.credential, r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, noteA))).status);
      }
      expect(statuses.size).toBeGreaterThan(80);
      expect([...statuses].filter(([, status]) => status !== 401)).toEqual([]);
      expect((await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "late", base_markdown: "body A\nmore" } })).status).toBe(401);
    });

    it("ending is immediate: the next request is refused, the credential does not come back, another session is not touched, and its membership is gone", async () => {
      const mine = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const other = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      expect((await asSession(mine.credential, "/api/bootstrap")).status).toBe(200);
      const ended = await asOwner(`/api/spaces/sessions/${mine.sessionId}`, { method: "DELETE" });
      expect(ended.status).toBe(200);
      expect(ended.json).toEqual({ ok: true, ended: true });
      expect((await asSession(mine.credential, "/api/bootstrap")).status).toBe(401);
      expect((await asSession(mine.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "x", base_markdown: "body A" } })).status).toBe(401);
      expect((await asSession(other.credential, "/api/bootstrap")).status).toBe(200);
      const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [mine.sessionId])).rows[0]!.actor_id;
      expect((await q(`SELECT 1 FROM space_members WHERE actor_id = $1::uuid`, [actorId])).rows).toEqual([]);
      expect((await asOwner(`/api/spaces/sessions/${mine.sessionId}`, { method: "DELETE" })).json).toEqual({ ok: true, ended: false }); // ending twice says so
      expect((await asOwner(`/api/spaces/sessions/${randomUUID()}`, { method: "DELETE" })).status).toBe(404);
    });

    it("RULE: a request that was in flight when its session ended does not commit; the one that got the workspace lock first does, and is history", async () => {
      // The workspace lock orders writers; what the later one meets is what this test builds without a second connection: the actor the
      // request resolved at its start is stale by the time its write gets the lock. mutate() re-reads the actor under the lock (spine/currentActor.ts).
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const inFlight = await resolveTemporarySessionActor(s.credential, w.ws);
      expect(inFlight?.type).toBe("session");
      const before = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [noteA])).rows[0]!.title;
      const events = async () => (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [w.ws, inFlight!.id])).rows.length;
      // first: a write that is committed before the end stays
      await updateNode(w.ws, noteA, { title: "committed before the end" }, { actor: inFlight! });
      const eventsBefore = await events();
      expect(eventsBefore).toBeGreaterThan(0);
      await endTemporarySession(w.owner.ctx, w.ws, s.sessionId);
      await expect(updateNode(w.ws, noteA, { title: "after the end" }, { actor: inFlight! })).rejects.toBeInstanceOf(UnauthorizedError);
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [noteA])).rows[0]!.title).toBe("committed before the end");
      expect(await events()).toBe(eventsBefore);
      void before;
    });

    it("a session out of requests or bytes is refused with its own answer, not mistaken for a sign-out", async () => {
      const few = await open([{ spaceId: w.spaceA, permission: "view" }], { maxRequests: 2 });
      expect((await asSession(few.credential, "/api/bootstrap")).status).toBe(200);
      expect((await asSession(few.credential, "/api/bootstrap")).status).toBe(200);
      const third = await asSession(few.credential, "/api/bootstrap");
      expect(third.status).toBe(403);
      expect(third.json.error).toBe("session_limit_reached");
      const small = await open([{ spaceId: w.spaceA, permission: "edit" }], { maxBytes: 200 });
      const bytesOf = async (id: string) => Number((await q<{ n: string }>(`SELECT byte_count::text AS n FROM participant_sessions WHERE id = $1`, [id])).rows[0]!.n);
      // the bytes counted are the ones the server READ, not what a header says: this one claims to be 1 byte long and is 500, so it does not fit in 200
      const first = await asSession(small.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "x".repeat(500), base_markdown: "body A\nmore" }, headers: { "content-length": "1" } });
      expect(first.json?.error).toBe("session_limit_reached"); // exact: a body that does not fit in what is left is refused (it used to be the last one served)
      expect(await bytesOf(small.sessionId)).toBe(0); // and charged nothing
      const fits = await asSession(small.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "fits", base_markdown: "body A\nmore" } });
      expect(fits.status).toBe(200);
      const spent = await bytesOf(small.sessionId);
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThanOrEqual(200);
    });

    // A body is never taken into memory past the request cap or what the session has left (services/participantSessions.ts readTemporarySessionBody).
    describe("the size of one request body", () => {
      const patch = (credential: string, body: BodyInit, headers: Record<string, string> = {}, init: Record<string, unknown> = {}) =>
        app.request(`/api/nodes/${noteA}`, { method: "PATCH", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...headers }, body, ...init } as RequestInit);
      /** A body of `chunks` chunks of 1 MiB with no declared length; `pulled` counts the chunks the server took. */
      const stream = (chunks: number) => {
        const state = { pulled: 0 };
        const body = new ReadableStream<Uint8Array>({ pull(controller) { if (state.pulled >= chunks) { controller.close(); return; } state.pulled++; controller.enqueue(new Uint8Array(1024 * 1024).fill(97)); } });
        return { state, body };
      };
      const titleOf = async () => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [noteA])).rows[0]!.title;
      const bytesOf = async (id: string) => Number((await q<{ n: string }>(`SELECT byte_count::text AS n FROM participant_sessions WHERE id = $1`, [id])).rows[0]!.n);

      it("over the request cap with a declared length: refused 413 before a byte is read; the session is still usable; nothing written or charged", async () => {
        const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
        const title = await titleOf();
        const { state, body } = stream(30);
        const res = await patch(s.credential, body, { "content-length": String(30 * 1024 * 1024) }, { duplex: "half" });
        expect(res.status).toBe(413);
        expect(((await res.json()) as { error: string }).error).toBe("body_too_large");
        expect(state.pulled).toBeLessThanOrEqual(1);
        expect(await titleOf()).toBe(title);
        expect(await bytesOf(s.sessionId)).toBe(0);
        expect((await asSession(s.credential, "/api/bootstrap")).status).toBe(200);
      });

      it("over the request cap with no declared length: the stream is cut at the cap (not read to the end), refused 413; still usable", async () => {
        const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
        const title = await titleOf();
        const { state, body } = stream(200);
        const res = await patch(s.credential, body, {}, { duplex: "half" });
        expect(res.status).toBe(413);
        expect(state.pulled).toBeLessThan(30); // 20 MiB cap: stopped there, nowhere near the 200 MiB offered
        expect(await titleOf()).toBe(title);
        expect(await bytesOf(s.sessionId)).toBe(0);
        expect((await asSession(s.credential, "/api/bootstrap")).status).toBe(200);
      });

      it("more than the session has left: refused 403 before the body is read (declared), and cut as it is read (not declared); nothing written or charged", async () => {
        const s = await open([{ spaceId: w.spaceA, permission: "edit" }], { maxBytes: 3 * 1024 * 1024 });
        const title = await titleOf();
        const declared = stream(10);
        const first = await patch(s.credential, declared.body, { "content-length": String(10 * 1024 * 1024) }, { duplex: "half" });
        expect(first.status).toBe(403);
        expect(((await first.json()) as { error: string }).error).toBe("session_limit_reached");
        expect(declared.state.pulled).toBeLessThanOrEqual(1);
        const undeclared = stream(100);
        const second = await patch(s.credential, undeclared.body, {}, { duplex: "half" });
        expect(second.status).toBe(403);
        expect(undeclared.state.pulled).toBeLessThanOrEqual(8); // 3 MiB left of 100 offered: cut near the first chunk past it (a stream may pull a few ahead)
        expect(await titleOf()).toBe(title);
        expect(await bytesOf(s.sessionId)).toBe(0);
      });
    });

    it("ending the person's sessions at once (a person who is removed) ends each and drops its membership", async () => {
      const a = await open([{ spaceId: w.spaceA, permission: "view" }]);
      const b = await open([{ spaceId: w.spaceA, permission: "view" }]);
      expect(await endTemporarySessionsOpenedBy(w.ws, w.owner.id)).toBeGreaterThanOrEqual(2);
      expect((await asSession(a.credential, "/api/bootstrap")).status).toBe(401);
      expect((await asSession(b.credential, "/api/bootstrap")).status).toBe(401);
    });
  });

  describe("the credential", () => {
    it("a wrong, malformed, empty or other-prefix credential is the same refusal as an ended one", async () => {
      for (const credential of ["onds_" + "A".repeat(43), "onds_", "onds_short", "ondt_" + "A".repeat(43), "x", ""]) {
        const res = await asSession(credential, "/api/bootstrap");
        expect([credential, res.status]).toEqual([credential, 401]);
      }
    });

    it("each session's credential acts as that session and no other", async () => {
      const a = await open([{ spaceId: w.spaceA, permission: "view" }]);
      const b = await open([{ spaceId: w.spaceA, permission: "view" }, { spaceId: w.spaceB, permission: "view" }]);
      const noteInBOnly = await newNote(w.ws, "only in B", w.spaceB);
      expect((await asSession(a.credential, `/api/nodes/${noteInBOnly}`)).status).toBe(404);
      expect((await asSession(b.credential, `/api/nodes/${noteInBOnly}`)).status).toBe(200);
    });

    it("is never written down: not in the events, the database, the logs or the console", async () => {
      const lines: string[] = [];
      const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
      for (const spy of spies) spy.mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
      const logged = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(log, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
      try {
        const ticket = await ticketWithoutEvidence(w.owner.ctx, "open_session");
        const opened = (await asOwner("/api/spaces/sessions", { method: "POST", headers: { "x-onden-fresh-proof": ticket }, body: { spaces: [{ space_id: w.spaceA, permission: "edit" }] } })).json;
        await asSession(opened.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: "t", base_markdown: "body A\nmore" } });
        await asSession(opened.credential + "x", "/api/bootstrap");
        await asOwner("/api/spaces/sessions");
        await asOwner(`/api/spaces/sessions/${opened.session_id}`, { method: "DELETE" });
        const plain = opened.credential as string;
        const secret = plain.slice("onds_".length);
        expect(lines.filter((line) => line.includes(secret))).toEqual([]);
        const rows = await q<{ n: number }>(
          `SELECT (SELECT count(*) FROM domain_events WHERE workspace_id = $1 AND (payload::text LIKE '%' || $2 || '%' OR COALESCE(tx_meta::text, '') LIKE '%' || $2 || '%'))::int
                + (SELECT count(*) FROM participant_sessions WHERE workspace_id = $1 AND credential_hash LIKE '%' || $2 || '%')::int
                + (SELECT count(*) FROM actors WHERE workspace_id = $1 AND name LIKE '%' || $2 || '%')::int AS n`, [w.ws, secret]);
        expect(rows.rows[0]!.n).toBe(0);
      } finally {
        for (const spy of [...spies, ...logged]) spy.mockRestore();
      }
    });
  });

  describe("a tag name only used in another space (decision for the PERSON's own session; a guest session must decide again)", () => {
    it("making a tag with that name by the button is answered truthfully ('already exists'); typing it in the text says nothing (and attaches nothing)", async () => {
      const name = `zzhidden${randomUUID().slice(0, 6)}`;
      const tagId = (await seedClassTag(w.ws, { name })).tagId;
      await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [noteB, tagId]);
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      // the tag is not in the session's lists…
      expect((await asSession(s.credential, "/api/tags")).text.includes(name)).toBe(false);
      // …and creating it says what is true: the name is taken
      const made = await asSession(s.credential, "/api/tags", { method: "POST", body: { name } });
      expect([made.status, made.json?.error]).toEqual([409, "tag_name_conflict"]);
      const typed = await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { markdown: `body A {${name}}`, base_markdown: "body A" } });
      const noteTags = (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [noteA])).rows.map((r) => r.tag_id);
      // typing it is NOT the same rule: the note saves, no tag is made (no second one of that name), none is attached, and nothing says the name exists
      const same = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND node_type = 'class_tag'`, [w.ws, name])).rows[0]!.n;
      expect({ status: typed.status, attached: noteTags.includes(tagId), tagsWithThatName: same }).toEqual({ status: 200, attached: false, tagsWithThatName: 1 });
    });
  });

  describe("reads yours (the rest of the cases: properties/sessionReadsOwn.property.integration.test.ts)", () => {
    it("a session reads the preferences of the person who opened it", async () => {
      const mine = await asOwner("/api/me/prefs/nav", { method: "PUT", body: { value: { order: ["notes"], phone: 1 } } });
      expect(mine.status).toBe(200);
      try {
        const s = await open([{ spaceId: w.spaceA, permission: "view" }]);
        const read = await asSession(s.credential, "/api/me/prefs/nav");
        expect(read.json?.value).toEqual({ order: ["notes"], phone: 1 });
        // and it never writes them back
        const write = await asSession(s.credential, "/api/me/prefs/nav", { method: "PUT", body: { value: { order: ["x"], phone: 0 } } });
        expect(write.status).toBe(403);
        expect((await asOwner("/api/me/prefs/nav")).json?.value).toEqual({ order: ["notes"], phone: 1 });
      } finally {
        await seedQ(`DELETE FROM actor_prefs WHERE actor_id = $1::uuid`, [w.owner.id]);
      }
    });
  });

  describe("a session belongs to this server alone", () => {
    it("a snapshot of the workspace carries neither its participant row nor its membership rows (it would be a member nobody could ever end)", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!.actor_id;
      expect((await q(`SELECT 1 FROM space_members WHERE actor_id = $1::uuid`, [actorId])).rows.length).toBe(1); // it IS a member here
      let carried = "";
      await readStampedPages(w.owner.ctx, w.ws, { since: null, layer: "rows" }, async (page) => { carried += JSON.stringify(page); });
      expect(carried.length).toBeGreaterThan(1000);
      expect(carried.includes(actorId)).toBe(false);
      expect(carried.includes("participant_sessions")).toBe(false);
      expect(carried.includes(s.sessionId)).toBe(false);
    });

    it("a session whose row is gone, ended or past its time cannot act, even with its membership left behind, and is in no list", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }]);
      const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!.actor_id;
      const live = (await resolveTemporarySessionActor(s.credential, w.ws))!;
      // (a) the membership is copied to another server: the actors row and space_members row there, without participant_sessions
      await q(`DELETE FROM participant_sessions WHERE id = $1`, [s.sessionId]);
      await expect(updateNode(w.ws, noteA, { title: "from a copy" }, { actor: live })).rejects.toBeInstanceOf(UnauthorizedError);
      expect((await q(`SELECT 1 FROM space_members WHERE actor_id = $1::uuid`, [actorId])).rows.length).toBe(1); // still a row
      // (b) and (c): the row exists but ended / ran out, membership left behind
      const lists = [`/api/spaces/${w.spaceA}/members`, "/api/actors", `/api/spaces/${w.spaceA}/candidates`, "/api/spaces/overview"];
      for (const path of lists) expect([path, (await asOwner(path)).text.includes(actorId)]).toEqual([path, false]);
      expect((await asOwner(`/api/spaces/${w.spaceA}/members`)).json.members.map((m: { id: string }) => m.id)).not.toContain(actorId);
      expect((await asOwner(`/api/spaces/${w.spaceA}/members`)).json.sessions).toEqual(expect.not.arrayContaining([expect.objectContaining({ sessionId: s.sessionId })]));
    });
  });

  describe("the credential, in the places it could leak", () => {
    it("only the Authorization header carries it: in a URL it is ignored (the request is then anonymous)", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "view" }]);
      for (const query of [`token=${s.credential}`, `authorization=${s.credential}`, `access_token=${s.credential}`, `credential=${s.credential}`]) {
        expect([query.split("=")[0], (await asSession("", `/api/bootstrap?${query}`)).status]).toEqual([query.split("=")[0], 401]);
      }
    });

    it("no refusal, error answer or log line repeats it (a bad body, a limit, a wrong route, a 404, a refused route)", async () => {
      const lines: string[] = [];
      const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
      const logged = (["info", "warn", "error", "debug"] as const).map((l) => vi.spyOn(log, l).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
      try {
        const s = await open([{ spaceId: w.spaceA, permission: "edit" }], { maxRequests: 6 });
        const secret = s.credential.slice("onds_".length);
        const answers = [
          await asSession(s.credential, `/api/nodes/${noteA}`, { method: "PATCH", body: { title: 5 } }),   // a bad body
          await asSession(s.credential, `/api/nodes/${randomUUID()}`),                                   // a 404
          await asSession(s.credential, "/api/actors"),                                                  // a refused route
          await asSession(s.credential, "/api/does-not-exist"),                                          // no such route
          await asSession(s.credential, "/api/export/markdown.zip"),                                     // refused
          await asSession(s.credential, "/api/bootstrap"),                                               // fine, then…
          await asSession(s.credential, "/api/bootstrap"),                                               // …out of requests
        ];
        for (const a of answers) expect(a.text.includes(secret)).toBe(false);
        expect(lines.filter((l) => l.includes(secret))).toEqual([]);
      } finally { for (const spy of [...spies, ...logged]) spy.mockRestore(); }
    });
  });

  describe("what a session can never do", () => {
    let credential = "";
    beforeAll(async () => { credential = (await open([{ spaceId: w.spaceA, permission: "edit" }], { maxRequests: 100_000 })).credential; });
    const refused = async (label: string, path: string, init?: Init, accepted: number[] = [403]) => {
      const res = await asSession(credential, path, init);
      expect([label, accepted.includes(res.status), res.status < 500, res.text.slice(0, 120)]).toEqual([label, true, true, res.text.slice(0, 120)]);
      return res;
    };

    it("open a session, end one, change members, list the roster or its tokens", async () => {
      const ticket = await ticketWithoutEvidence(w.owner.ctx, "open_session");
      await refused("open", "/api/spaces/sessions", { method: "POST", headers: { "x-onden-fresh-proof": ticket }, body: { spaces: [{ space_id: w.spaceA, permission: "view" }] } });
      await refused("end", `/api/spaces/sessions/${randomUUID()}`, { method: "DELETE" });
      await refused("members", `/api/spaces/${w.spaceA}/members/${w.member.id}`, { method: "PUT", body: { permission: "view" } });
      await refused("roster", "/api/actors");
      await refused("mint token", `/api/actors/${w.member.id}/tokens`, { method: "POST", body: { name: "x" } });
      await refused("overview", "/api/spaces/overview");
      expect((await q(`SELECT 1 FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [w.spaceA, w.member.id])).rows.length).toBe(1);
    });

    it("start an AI (the mention, the panel chat, the selection actions) or use the AI tool surface", async () => {
      const sent = await refused("agent session", "/api/agent-sessions", { method: "POST", body: { node_id: noteA, block_text: "@ai hello" } });
      expect(sent.json.error).toBe("human_required");
      await refused("mcp tools", "/api/mcp/tools");
      const chat = await refused("panel chat", "/api/ai/panel-chat", { method: "POST", body: { node_id: noteA, agent_actor_id: randomUUID(), text: "hi", request_id: randomUUID() } });
      expect(chat.json.error).toBe("human_required");
      const selection = await refused("selection action", "/api/ai/selection-actions", { method: "POST", body: { node_id: noteA, agent_actor_id: randomUUID(), skill: "summarise", text: "x", request_id: randomUUID() } });
      expect(selection.json.error).toBe("human_required");
      await refused("mcp call", "/api/mcp/tools/getNode", { method: "POST", body: { args: { id: noteA } } });
      const actor = (await resolveTemporarySessionActor(credential, w.ws))!;
      await expect(startAgentSession(w.ws, { actor, nodeId: noteA, target: { kind: "agent", agentActorId: randomUUID() }, text: "@ai hi", requestId: randomUUID() } as never)).rejects.toMatchObject({ code: "human_required" });
      expect((await q(`SELECT 1 FROM agent_sessions WHERE workspace_id = $1`, [w.ws])).rows).toEqual([]);
    });

    it("take the workspace away: the export, the backup, the snapshot, a fresh-confirmation ticket", async () => {
      await refused("export", "/api/export/markdown.zip");
      await refused("backup", "/api/backup/full.zip");
      await refused("backup size", "/api/backup/size");
      await refused("snapshot", "/api/snapshot");
      await refused("snapshot readiness", "/api/snapshot/readiness");
      await refused("fresh proof", "/api/fresh-proof", { method: "POST", body: { purpose: "snapshot_export", evidence: { kind: "acknowledgement" } } });
    });

    it("write its person's personal data back, or read the workspace settings", async () => {
      const pref = await refused("prefs", "/api/me/prefs/nav", { method: "PUT", body: { value: { order: ["notes"], phone: 1 } } }); // a real key with a valid value: the refusal is the session's, not a bad request
      expect(pref.json.error).toMatch(/personal data/);
      expect((await q(`SELECT 1 FROM actor_prefs WHERE actor_id IN (SELECT id FROM actors WHERE workspace_id = $1)`, [w.ws])).rows).toEqual([]);
      const mine = await asOwner("/api/me/prefs/nav", { method: "PUT", body: { value: { order: ["notes"], phone: 1 } } }); // the person can: the control
      expect(mine.status).toBe(200);
      await seedQ(`DELETE FROM actor_prefs WHERE actor_id = $1::uuid`, [w.owner.id]);
      await refused("workspace config", "/api/workspace/config");
      await refused("config write", "/api/workspace/config", { method: "PATCH", body: { config: { title: "x" } } });
    });

    it("save an RSS article (it marks the article seen, a personal row): refused whole, nothing of the person's is written", async () => {
      const sub = (await seedQ<{ id: string }>(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, 'feed', $3) RETURNING id::text`, [w.ws, w.spaceA, `https://feed.test/${randomUUID()}`])).rows[0]!.id;
      const item = (await seedQ<{ id: string }>(`INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, body) VALUES ($1, $2, $3, 'an article', '<p>text</p>') RETURNING id::text`, [w.ws, sub, randomUUID()])).rows[0]!.id;
      const actor = (await resolveTemporarySessionActor(credential, w.ws))!;
      await expect(saveItem(actor, w.ws, item, undefined)).rejects.toMatchObject({ name: "AuthorityError" });
      expect((await q(`SELECT 1 FROM rss_seen WHERE staging_id = $1::uuid`, [item])).rows).toEqual([]); // this article only: on a shared database other files leave their own rows
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND source_type = 'rss'`, [w.ws])).rows).toEqual([]);
    });

    it("a person's own service entry, called with a session actor, says no for the same reason (requirePerson)", async () => {
      const actor = (await resolveTemporarySessionActor(credential, w.ws))!;
      await expect(openTemporarySession(actor, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] }, "ticket")).rejects.toMatchObject({ name: "AuthorityError" });
      await expect(endTemporarySession(actor, w.ws, randomUUID())).rejects.toMatchObject({ name: "AuthorityError" });
      await expect(listTemporarySessions(actor, w.ws)).rejects.toMatchObject({ name: "AuthorityError" });
      // a focus record is personal data written through mutate (not mutatePersonal): the one place that needed its own requirePerson
      await expect(startFocus(actor, {} as never)).rejects.toMatchObject({ name: "AuthorityError" });
      expect((await q(`SELECT 1 FROM focus_sessions WHERE workspace_id = $1`, [w.ws])).rows).toEqual([]);
    });
  });

  describe("the member list", () => {
    it("lists the live sessions of a space for the owner (label, time left, can end), not for a member, and never as a member", async () => {
      const s = await open([{ spaceId: w.spaceA, permission: "edit" }], { minutes: 45 });
      const owner = await asOwner(`/api/spaces/${w.spaceA}/members`);
      expect(owner.json.members.map((m: { name: string }) => m.name).sort()).toEqual(["Member", "Owner"]);
      const mine = owner.json.sessions.find((x: { sessionId: string }) => x.sessionId === s.sessionId);
      expect(mine).not.toHaveProperty("label");
      expect(mine).toMatchObject({ canEnd: true, spaces: [{ spaceId: w.spaceA, name: "space A", permission: "edit" }] });
      expect(mine.secondsLeft).toBeGreaterThan(44 * 60);
      expect(mine.secondsLeft).toBeLessThanOrEqual(45 * 60);
      const member = await call(`/api/spaces/${w.spaceA}/members`, { cookie: w.member.ext });
      expect(member.json.sessions).toEqual([]);
      expect(member.json.members.map((m: { type: string }) => m.type)).not.toContain("session");
      const viaSession = await asSession(s.credential, `/api/spaces/${w.spaceA}/members`);
      expect(viaSession.status).toBe(200);
      expect(viaSession.json.sessions).toEqual([]);
      const roster = await asOwner("/api/actors");
      expect(roster.json.map((a: { type: string }) => a.type)).not.toContain("session");
      const listed = await asOwner("/api/spaces/sessions");
      expect(listed.json.sessions.map((x: { sessionId: string }) => x.sessionId)).toContain(s.sessionId);
      expect((await asOwner(`/api/spaces/sessions/${s.sessionId}`, { method: "DELETE" })).status).toBe(200);
      expect((await asOwner(`/api/spaces/${w.spaceA}/members`)).json.sessions.map((x: { sessionId: string }) => x.sessionId)).not.toContain(s.sessionId);
    });
  });
});
