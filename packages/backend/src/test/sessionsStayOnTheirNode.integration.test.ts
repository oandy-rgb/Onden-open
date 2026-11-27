// Nothing of a temporary session leaves the node it was opened on (docs/architecture/proposals/sessions-reads-own-2026-11-17.md §2).
//
// A session lives on ONE node: its `actors` row, its `space_members` rows and its `participant_sessions` row mean nothing on another (the credential is for this
// node's door). What it WROTE does travel: a note it made in a shared space is the person's note, with the stamps its writes made (author = the session's id).
// Two nodes (helpers/distSim/realNode.ts, the stamped bundle world): the session is opened on A, writes a note in a shared space, and is ended (or runs out and
// its membership is cleared by the next opening, the way the product does). A bundle for B is read and taken: B holds the note and its stamps, and holds NO actors
// row, NO space_members row, NO stamp whose row key names the session, and nothing of participant_sessions.
//
// Run on both engines (a node is a PGlite, or a database of the real server of DATABASE_URL).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, replicatedDigestAs, makeCaller, openNode } from "./helpers/stampedWorld.js";
import { compareDigests } from "../spine/snapshotSql.js";
import { admit, bundleFor, peerOf, take, type Peer } from "./helpers/stampedBundleWorld.js";
import { ticketWithoutEvidence } from "./helpers/freshProofTicket.js";
import { endTemporarySession, openTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { seedQ } from "./helpers/seedQ.js";
import type { ActorCtx } from "../types.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A holds the world; B joins A by snapshot and A admits it. */
async function twoNodes(): Promise<{ a: Peer; b: Peer }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const cap = await capture(na, world, 12_000);
  await fillFrom(nb, world, cap);
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  return { a, b };
}

type Made = { sessionId: string; actorId: string; noteId: string; title: string; session: ActorCtx };
/** On A: the owner opens a session on the space, the session writes a note there (through the route a person writes through). */
async function sessionWrites(a: Peer): Promise<Made> {
  return onNode(a.node, async () => {
    const opened = await openTemporarySession(a.owner, a.ws, { spaces: [{ spaceId: a.space, permission: "edit" }] }, await ticketWithoutEvidence(a.owner, "open_session"));
    const session = (await resolveTemporarySessionActor(opened.credential, a.ws))!;
    const noteId = randomUUID(), title = `written by a session ${randomUUID().slice(0, 6)}`;
    await makeCaller(session)("POST", "/api/nodes", { id: noteId, title, markdown: "typed on a stranger's computer", space_id: a.space });
    await makeCaller(session)("PATCH", `/api/nodes/${noteId}`, { title: `${title} (edited)` });
    return { sessionId: opened.sessionId, actorId: session.id, noteId, title: `${title} (edited)`, session };
  });
}

/** What node `p` holds that names the session (by its actor id) anywhere a bundle could have put it, and of participant_sessions. */
async function heldAbout(p: Peer, made: Made) {
  return onNode(p.node, async () => {
    const id = made.actorId;
    const count = async (text: string, params: unknown[] = [id]) => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
    return {
      actorRows: await count(`SELECT count(*) AS n FROM actors WHERE id::text = $1`),
      memberRows: await count(`SELECT count(*) AS n FROM space_members WHERE actor_id::text = $1`),
      participantRows: await count(`SELECT count(*) AS n FROM participant_sessions WHERE actor_id::text = $1 OR id::text = $2`, [id, made.sessionId]),
      // a stamp of a membership names the session in its row key ("space/actor"); an `actors` stamp would be keyed by it
      stampsNamingIt: await count(`SELECT count(*) AS n FROM sync_stamps WHERE table_name IN ('space_members', 'actors') AND row_key LIKE '%' || $1 || '%'`),
      headsNamingIt: await count(`SELECT count(*) AS n FROM sync_stamp_heads WHERE table_name IN ('space_members', 'actors') AND (row_key LIKE '%' || $1 || '%' OR value LIKE '%' || $1 || '%')`),
      // the note, and its stamps: the author of its writes is the session's id (the real id: it is the history's own)
      note: (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id::text = $1`, [made.noteId])).rows[0]?.title ?? null,
      authors: (await q<{ author: string | null }>(`SELECT DISTINCT author FROM sync_stamps WHERE table_name = 'content_nodes' AND row_key = $1 AND author IS NOT NULL ORDER BY author`, [made.noteId])).rows.map((r) => r.author),
    };
  });
}

describe.skipIf(!isTestDb)("nothing of a temporary session leaves the node it was opened on", () => {
  it("an ended session: B holds its note and the stamps of its writes, and nothing of the session itself", async () => {
    const { a, b } = await twoNodes();
    const made = await sessionWrites(a);
    // control: at A the session's rows exist while it lives, and the note carries its author
    const atA = await heldAbout(a, made);
    expect(atA).toMatchObject({ actorRows: 1, memberRows: 1, participantRows: 1, note: made.title, authors: [made.actorId] });
    await onNode(a.node, () => endTemporarySession(a.owner, a.ws, made.sessionId)); // clears its membership rows
    expect((await heldAbout(a, made)).memberRows).toBe(0);

    const report = await take(b, await bundleFor(a, b));
    expect(report.rejected).toEqual([]);
    expect(await heldAbout(b, made)).toEqual({
      actorRows: 0, memberRows: 0, participantRows: 0, stampsNamingIt: 0, headsNamingIt: 0,
      note: made.title, authors: [made.actorId],
    });
  }, 300_000);

  it("a session that ran out: its membership is cleared by the next opening (the way the product does), and still nothing of it reaches B", async () => {
    const { a, b } = await twoNodes();
    const made = await sessionWrites(a);
    await onNode(a.node, async () => {
      await seedQ(`UPDATE participant_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`, [made.sessionId]);
      // the tidy runs when another session is opened
      await openTemporarySession(a.owner, a.ws, { spaces: [{ spaceId: a.space, permission: "view" }] }, await ticketWithoutEvidence(a.owner, "open_session"));
    });
    expect((await heldAbout(a, made)).memberRows).toBe(0);
    await take(b, await bundleFor(a, b));
    expect(await heldAbout(b, made)).toMatchObject({ actorRows: 0, memberRows: 0, participantRows: 0, stampsNamingIt: 0, headsNamingIt: 0, note: made.title });
  }, 300_000);

  it("on the wire: neither a snapshot nor a bundle (nor a digest) carries the session's id anywhere but as the author of a stamp, and the digests of the two nodes agree", async () => {
    const { a, b } = await twoNodes();
    const made = await sessionWrites(a);
    await onNode(a.node, () => endTemporarySession(a.owner, a.ws, made.sessionId));
    const bundle = await bundleFor(a, b);
    await take(b, bundle);
    // every place the session's id may be written in what leaves: a bundle and a snapshot, as JSON, with the `author` of a stamp taken out (that one names who wrote)
    const withoutAuthors = (value: unknown) => JSON.stringify(value, (key, v) => (key === "author" ? undefined : v));
    expect(withoutAuthors(bundle)).not.toContain(made.actorId);
    const pages = await onNode(a.node, async () => (await capture(a.node, { ws: a.ws, owner: a.owner }, 12_000)).pages);
    expect(withoutAuthors(pages)).not.toContain(made.actorId);
    expect(JSON.stringify(bundle)).toContain(made.actorId); // control: the note's stamps do carry it, as their author
    // the digest counts the same stamps on both nodes: the tombstone of the session's membership is on A only, and A does not count it
    const [digestA, digestB] = [await onNode(a.node, () => replicatedDigestAs(a.node, a.ws, a.owner)), await onNode(b.node, () => replicatedDigestAs(b.node, b.ws, b.owner))];
    expect(compareDigests(digestA, digestB)).toEqual([]);
  }, 300_000);

  it("a session that still lives: the same (its rows are out of the scope of what a bundle carries)", async () => {
    const { a, b } = await twoNodes();
    const made = await sessionWrites(a);
    await take(b, await bundleFor(a, b));
    expect(await heldAbout(b, made)).toMatchObject({ actorRows: 0, memberRows: 0, participantRows: 0, stampsNamingIt: 0, headsNamingIt: 0, note: made.title, authors: [made.actorId] });
  }, 300_000);
});
