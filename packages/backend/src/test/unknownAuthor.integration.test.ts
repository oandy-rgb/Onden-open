// What this node does when an event or a stamp names an operator id it has never heard of: the shape of a session's write that arrives from another
// node (a session's actor row is not carried by a snapshot: spine/snapshotTables.json). FOUND: the event is refused at INSERT (migration 071's
// domain_events_actor_ref trigger), so there is no reader to throw; what breaks is taking the event in. Pinned with it.fails below; the batch that
// fixes it is the one that makes the change bundle carry the session's display name (the receiver then creates the actor row first).
// A stamp's author is plain text with no such check, and every reader copes with it. So a session's write from another node reaches this node only as
// stamps, which no reader names; when its events can be taken in, nothing here can tell it was a session's (its actors row never leaves its node),
// and it is shown like a removed member's (the readers below).
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, event } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, newPerson, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { readStampedPages } from "../services/stampedSnapshot.js";
import { seedQ } from "./helpers/seedQ.js";
import { endTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { updateNode } from "../services/nodeUpdate.js";
import { listNoteVersions } from "../services/history/index.js";
import { notesEditedOn } from "../services/history/activity.js";
import { listInkEdits } from "../services/history/inkChanges.js";
import { rewindsBetween, rewindWorkspace } from "../services/history/rewind.js";
import { listInkVersionRows } from "../services/nodeReads.js";
import { writeHistoryFile } from "../services/backupHistory.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createNote } from "../services/noteCreate.js";
import { removeActor } from "../services/actors.js";
import { localDayId } from "../localDay.js";
import { shownAuthorKind, shownAuthorName } from "../services/authorName.js";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import type { ActorCtx } from "../types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@unknown.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {}, internalAdapter: { deleteUserSessions: async () => undefined } }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

describe.skipIf(!isTestDatabase())("an operator this node does not know", () => {
  let w: Awaited<ReturnType<typeof standardWorld>>;
  let note = "";
  const stranger = randomUUID();
  beforeAll(async () => {
    w = await standardWorld("unknownAuthor");
    ownWorkspace = w.ws;
    note = await newNote(w.ws, "written elsewhere", w.spaceA, "body");
  });
  afterAll(async () => { await pool.end(); });

  it("today an event naming an unknown uuid operator is REFUSED at insert (so a session's write from another node cannot be taken in)", async () => {
    await expect(event(w.ws, "NODE_UPDATED", "node", note, { title: "x", body_hash: "h" }, "user", stranger)).rejects.toThrow(/resolves to no actor/);
  });

  // The wanted behaviour: the event is taken in and the readers show a fallback label. Fails today (see the test above). Fixed by: the change-bundle batch.
  it.fails("WANTED: an event naming an unknown operator is taken in", async () => {
    await event(w.ws, "NODE_UPDATED", "node", note, { title: "x", body_hash: "h" }, "user", stranger);
  });

  it("a stamp whose author is unknown is read by a snapshot without throwing", async () => {
    await q(`UPDATE sync_stamps SET author = $2 WHERE workspace_id = $1 AND row_key = $3 AND table_name = 'content_nodes'`, [w.ws, stranger, note]);
    let carried = "";
    await readStampedPages(w.owner.ctx, w.ws, { since: null, layer: "rows" }, async (page) => { carried += JSON.stringify(page); });
    expect(carried).toContain(stranger);
  });

  it("the note's history and the event list still answer for a note whose latest stamp is by an unknown author", async () => {
    signedInAs = w.owner.ext;
    try {
      for (const path of [`/api/nodes/${note}/history`, `/api/nodes/${note}/versions`, `/api/events?target_id=${note}`]) {
        expect([path, (await app.request(path)).status]).toEqual([path, 200]);
      }
    } finally { signedInAs = null; }
  });

  // Who a reader says wrote something (services/authorName.ts): the evidence that an author was a session is this node's own `actors` row of type
  // 'session', which is kept (sessionActorKept.integration.test.ts). A removed person or AI has no row and is shown as before sessions existed
  // (origin/main before this batch): no name, the kind its event recorded, left out of the day's activity. A session is sent as the kind 'session'
  // with no name (the screen words it); nothing is ever shown or written as a fixed label. Each author writes a note, a drawing and a rewind.
  describe("what each reader shows for a removed member, a removed AI and an ended session", () => {
    type Who = "member" | "agent" | "session";
    const made: Record<Who, { note: string; rewindNote: string; id: string }> = { member: { note: "", rewindNote: "", id: "" }, agent: { note: "", rewindNote: "", id: "" }, session: { note: "", rewindNote: "", id: "" } };
    let from = new Date(0), to = new Date(0);
    const drawing = encodeInk({ version: 1, strokes: [{ id: "s0", points: [[0, 0], [10, 10], [20, 5], [30, 30]], color: "#112233", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } } as InkDocument);
    async function writeAs(actor: ActorCtx, label: string) {
      const note = await newNote(w.ws, `${label} note`, w.spaceA, "first");
      await updateNode(w.ws, note, { markdown: `${label} typed this` }, { actor });
      await setNodeAttribute({ workspaceId: w.ws, actor, nodeId: note, attribute: { key: "ink_data", value: drawing, value_type: "text" } });
      const before = (await q<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
      const rewindNote = (await createNote({ actor, workspaceId: w.ws, title: `${label} rewound`, markdown: "x", spaceId: w.spaceA, event: { uiContext: "test.author" } })).node.id;
      const done = await rewindWorkspace(w.ws, { at: new Date(before.getTime() - 1000), restoreIds: [], undeleteIds: [], deleteIds: [rewindNote] }, { actor });
      expect(done.rewind_id, `${label}: the rewind did something`).toBeTruthy();
      return { note, rewindNote };
    }
    beforeAll(async () => {
      from = (await q<{ t: Date }>(`SELECT now() - interval '1 second' AS t`)).rows[0]!.t;
      // a person (the world's member, in space A) and an AI, both removed afterwards
      made.member = { ...(await writeAs(w.member.ctx, "member")), id: w.member.id };
      const agentId = (await seedQ<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Helper AI', 'agent') RETURNING id::text`, [w.ws])).rows[0]!.id;
      // the AI's saves: written by a stand-in person, then marked as the AI's in the log (an AI's own write path asks for a runner and a review rule)
      const standIn = await newPerson(w.ws, "Stand-in");
      await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [w.spaceA, standIn.id]);
      const agentWrites = await writeAs(standIn.ctx, "agent");
      await retag([agentWrites.note, agentWrites.rewindNote], standIn.id, agentId);
      made.agent = { ...agentWrites, id: agentId };
      // a session of the owner, ended
      const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
      const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
      made.session = { ...(await writeAs(session, "session")), id: session.id };
      await endTemporarySession(w.owner.ctx, w.ws, opened.sessionId);
      await removeActor(w.owner.ctx, w.member.id);
      await removeActor(w.owner.ctx, agentId);
      await removeActor(w.owner.ctx, standIn.id);
      to = (await q<{ t: Date }>(`SELECT now() + interval '1 second' AS t`)).rows[0]!.t;
    });
    /** Mark the events about these notes by `fromId` as the AI's (the log's own columns; a trigger keeps events append-only, so with triggers off). */
    async function retag(notes: string[], fromId: string, agentId: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`UPDATE domain_events SET actor_id = $3, actor_type = 'ai_agent' WHERE target_id = ANY($1::text[]) AND actor_id = $2`, [notes, fromId, agentId]);
        // History reads the versions those saves recorded: an AI's version names its kind and no person (migration 220: only a person's id is kept)
        await client.query(`UPDATE note_versions SET author_kind = 'ai', author_id = NULL WHERE note_id = ANY($1::uuid[]) AND author_id = $2::uuid`, [notes, fromId]);
        await client.query("COMMIT");
      } finally { client.release(); }
    }
    const kindOf: Record<Who, string> = { member: "human", agent: "agent", session: "session" };
    const WHO: Who[] = ["member", "agent", "session"];
    /** Nothing a reader answers carries the author's id or any fixed label. */
    const clean = (who: Who, value: unknown) => {
      const text = JSON.stringify(value);
      expect(text, `${who}: the id`).not.toContain(made[who].id);
      expect(text, `${who}: no label is sent`).not.toMatch(/臨時|工作階段/);
    };

    it("a note's versions (list and raw): no name; the kind its event recorded, or 'session'", async () => {
      for (const who of WHO) for (const raw of [false, true]) {
        const versions = (await listNoteVersions(w.ws, w.owner.ctx, made[who].note, { raw }))! as Array<{ markdown: string; actor_name: string | null; actor_kind: string }>;
        const theirs = versions.filter((v) => v.markdown === `${who} typed this`);
        expect(theirs.length, `${who} raw=${raw}`).toBeGreaterThan(0);
        expect(theirs.map((v) => [v.actor_name, v.actor_kind]), `${who} raw=${raw}`).toEqual(theirs.map(() => [null, kindOf[who]]));
        clean(who, versions);
      }
    });
    it("a drawing's versions and edits: no name; the kind, or 'session'", async () => {
      for (const who of WHO) {
        const versions = (await listInkVersionRows(w.owner.ctx, w.ws, made[who].note, "handwriting"))!;
        expect(versions.map((v) => [v.actor_name, v.actor_kind]), who).toEqual([[null, kindOf[who]]]);
        clean(who, versions);
        const edits = (await listInkEdits(w.ws, w.owner.ctx, made[who].note, "handwriting"))!;
        expect(edits.map((e) => [e.actor_name, e.actor_kind]), who).toEqual([[null, kindOf[who]]]);
        clean(who, edits);
      }
    });
    it("the day's activity: a removed member or AI is left out (as before), a session is the kind 'session' with no name", async () => {
      // the day the edits were MADE (read from their events), not "today": a run that crosses midnight must not look at the wrong day
      for (const who of WHO) {
        const madeAt = (await q<{ t: Date }>(`SELECT max(created_at) AS t FROM domain_events WHERE target_id = $1`, [made[who].note])).rows[0]!.t;
        const notes = await notesEditedOn(w.owner.ctx, w.ws, localDayId(madeAt));
        const row = notes.find((n) => n.id === made[who].note);
        expect(row, `${who}: the note is listed`).toBeDefined();
        expect(row!.actors, who).toEqual(who === "session" ? [{ name: null, kind: "session" }] : []);
        clean(who, notes);
      }
    });
    it("a day's rewinds: the card says \"\" and the kind ('session' for a session; a removed member or AI has no row: the kind its event recorded)", async () => {
      const cards = await rewindsBetween(w.owner.ctx, w.ws, from, to);
      for (const who of WHO) {
        const card = cards.find((c) => c.notes.some((n) => n.id === made[who].rewindNote));
        expect(card, `${who}: the rewind is listed`).toBeDefined();
        // a removed AI was 'human' before round 2 point 8 (rewindAuthor read only the row); now as every reader: the event's own actor_type
        expect([card!.actor_name, card!.actor_kind], who).toEqual(["", kindOf[who]]);
        clean(who, card);
      }
    });
    it("the event list (/api/events) answers each event with its raw actor_id and actor_type and no name, for a session as for a removed member; it does not throw", async () => {
      // What the screen does with an id it cannot look up (packages/frontend): the event list shows the kind label of actor_type only
      // (components/SideDrawers.tsx actorTypeLabel: 'user' → 「使用者」), and an AI by agentNameOf(id), 「AI」 when unknown; the id itself is never shown.
      // A session's event is actor_type 'user' (eventActorType): this list does not say it was a session (a decision for a later batch, proposal §7).
      signedInAs = w.owner.ext;
      try {
        for (const who of WHO) {
          const res = await app.request(`/api/events?target_id=${made[who].note}`);
          expect(res.status, who).toBe(200);
          const body = await res.json() as { events?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
          const events = Array.isArray(body) ? body : body.events ?? [];
          expect(events.length, `${who}: the note's events are listed`).toBeGreaterThan(0);
          const own = events.filter((e) => e.actor_id === made[who].id);
          expect(own.length, `${who}: its events name its id`).toBeGreaterThan(0);
          expect([...new Set(own.map((e) => e.actor_type))], who).toEqual([who === "agent" ? "ai_agent" : "user"]);
          for (const e of own) expect(Object.keys(e).filter((k) => /name/.test(k) && k !== "event_type"), `${who}: no name is sent`).toEqual([]);
        }
      } finally { signedInAs = null; }
    });

    it("the history a backup writes: no name for any of them, so no label travels with the file; the type the event recorded", async () => {
      for (const who of WHO) {
        const dir = await mkdtemp(join(tmpdir(), "author-"));
        try {
          const path = join(dir, "history.jsonl");
          await writeHistoryFile(w.ws, made[who].note, path);
          const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { markdown: string; actor: { type: string; name: string | null } });
          const theirs = lines.filter((l) => l.markdown === `${who} typed this`);
          expect(theirs.map((l) => l.actor), who).toEqual([{ type: who === "agent" ? "ai_agent" : "user", name: null }]);
          clean(who, lines);
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
    });
    it("control: a member who is still here is named, and the ended session's row is kept (the evidence)", async () => {
      expect((await q<{ type: string }>(`SELECT type FROM actors WHERE id = $1::uuid`, [made.session.id])).rows[0]?.type).toBe("session");
      expect((await q(`SELECT 1 FROM actors WHERE id = $1::uuid`, [made.member.id])).rows).toEqual([]);
      const named = await newNote(w.ws, "the owner wrote", w.spaceA, "a");
      await updateNode(w.ws, named, { markdown: "b" }, { actor: w.owner.ctx });
      const list = (await listNoteVersions(w.ws, w.owner.ctx, named, { raw: true }))! as Array<{ actor_name: string | null; actor_kind: string }>;
      expect(list.filter((v) => v.actor_kind === "human").map((v) => v.actor_name)).toContain("Owner");
    });
    it("the rule: only a row of type 'session' is a session; a missing row is no evidence", () => {
      expect([shownAuthorName("session", "你（臨時）"), shownAuthorKind("session", "human")]).toEqual([null, "session"]);
      expect([shownAuthorName(null, null), shownAuthorKind(null, "human")]).toEqual([null, "human"]);
      expect([shownAuthorName(undefined, null), shownAuthorKind(undefined, "agent")]).toEqual([null, "agent"]);
      expect([shownAuthorName("human", "Ada"), shownAuthorKind("agent", "agent")]).toEqual(["Ada", "agent"]);
    });
  });
});
