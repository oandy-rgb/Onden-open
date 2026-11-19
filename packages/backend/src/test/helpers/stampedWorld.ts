// Two whole databases in one test process (RealNode: each is a PGlite loaded from the migrated template) and a workspace of
// everyday data on the first, for copying it with its stamps (services/stampedSnapshot.ts, services/stampedJoin.ts).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { getWorkspaceId, q } from "../../db.js";
import { SNAPSHOT_SPECS } from "../../spine/snapshotTables.js";
import stampedSnapshotRouter from "../../routes/stampedSnapshot.js";
import { setSiteConfig } from "./siteConfigFixture.js";
import { snapshotScope, snapshotScopeFor } from "../../services/readPolicy.js";
import { withActorReadSnapshot } from "../../services/actorReadSnapshot.js";
import { computeSnapshotDigest } from "../../spine/snapshotSql.js";
import nodeRouter from "../../routes/nodes.js";
import spaceRouter from "../../routes/spaces.js";
import edgeRouter from "../../routes/edges.js";
import pointerRouter from "../../routes/pointers.js";
import tagRouter from "../../routes/tags.js";
import canvasRouter from "../../routes/canvases.js";
import boardRouter from "../../routes/boards.js";
import { withRequestDevice } from "../../requestContext.js";
import { ensureOwnNodeId } from "../../browser/nodeIdentity.js";
import { readStampedPages } from "../../services/stampedSnapshot.js";
import type { StampedPage } from "../../spine/snapshotSql.js";
import { abandonJoin, applyJoinPage, finishJoin, startJoin } from "../../services/stampedJoin.js";
import { FRESH_PROOF_HEADER } from "../../services/freshProof.js";
import { ticketWithoutEvidence } from "./freshProofTicket.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "./persistActor.js";
import { makeSpace } from "./spaceFixtures.js";
import { seedQ } from "./seedQ.js";
import { RealNode, onNode } from "./distSim/realNode.js";

/** A node of its own: a database from the template with a node id no other has (the template carries one shared id). */
export async function openNode(name: string): Promise<RealNode> {
  const node = await RealNode.open(name);
  await onNode(node, () => ensureOwnNodeId());
  return node;
}

export type SourceWorld = {
  ws: string; owner: ActorCtx; friend: ActorCtx; spaceA: string; spaceB: string; secretSpace: string; secretNote: string;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
};

/** The routes a person writes through, called as `actor` (inside onNode of the database it should reach). */
export function makeCaller(actor: ActorCtx): (method: string, path: string, body?: unknown) => Promise<any> {
  const device = randomUUID();
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", actor); await withRequestDevice(device, next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/spaces", spaceRouter);
  server.route("/api/edges", edgeRouter);
  server.route("/api/pointers", pointerRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/canvases", canvasRouter);
  server.route("/api/boards", boardRouter);
  return async (method, path, body) => {
    const res = await server.request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return json;
  };
}

/** The snapshot routes (GET and POST /api/snapshot) as `actor` calls them. */
export function snapshotApp(actor: ActorCtx | null): Hono<{ Variables: { actor: ActorCtx | null } }> {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/snapshot", stampedSnapshotRouter);
  return app;
}

/** GET /api/snapshot as `actor`, carrying a ticket from a fresh confirmation. The evidence behind a ticket is tested in freshProof.integration.test.ts;
 *  a test that is about the file's content takes a ticket without it (helpers/freshProofTicket.ts). Run it inside onNode of the database that is read. */
export async function exportAs(actor: ActorCtx): Promise<Response> {
  const ticket = await ticketWithoutEvidence(actor);
  return snapshotApp(actor).request("/api/snapshot", { headers: { [FRESH_PROOF_HEADER]: ticket } });
}

/** Everyday data on `node`: nested notes, tags and their use, attributes, links, board positions and sections, two spaces with a
 *  member, a deleted note, a purged note, and rows of the tables that have no stamp trigger yet. Runs on the node. */
export function buildSourceWorld(node: RealNode | null): Promise<SourceWorld> {
  return onNode(node, async () => {
    const ws = await getWorkspaceId();
    const owner = await persistActor(ws, { id: "", name: "Owner", role: "admin", type: "human" });
    const call = makeCaller(owner);
    const spaceA = await makeSpace(ws, `World A ${randomUUID().slice(0, 6)}`, [{ id: owner.id, permission: "edit" }]);
    const spaceB = await makeSpace(ws, `World B ${randomUUID().slice(0, 6)}`, [{ id: owner.id, permission: "edit" }]);
    const note = async (title: string, extra: Record<string, unknown> = {}) =>
      (await call("POST", "/api/nodes", { id: randomUUID(), title, markdown: `# ${title}\n\nfirst line`, space_id: spaceA, ...extra })).id as string;

    const root = await note("Root");
    const child = await note("Child", { parent_id: root });
    const grandchild = await note("Grandchild", { parent_id: child, space_id: spaceB });
    await call("PATCH", `/api/nodes/${child}`, { title: "Child (renamed)" });
    await call("PATCH", `/api/nodes/${child}`, { markdown: `[[Root]] and a second line\n\n- [ ] one` });
    const tag = (await call("POST", "/api/tags", { name: `tag-${randomUUID().slice(0, 6)}` })).id as string;
    await call("PATCH", `/api/nodes/${tag}`, { tag_schema: { priority: { type: "number" }, owner: { type: "text" } } });
    await call("PUT", `/api/nodes/${root}/tags/${tag}`);
    await call("PUT", `/api/nodes/${child}/attributes/priority`, { value: 3, value_type: "number" });
    await call("PUT", `/api/nodes/${child}/attributes/owner`, { value: "me" });
    await call("PUT", `/api/nodes/${child}/attributes/owner`, { value: "someone else" });
    await call("POST", "/api/edges", { source_node_id: root, target_node_id: grandchild, edge_type: "related" }).catch(() => undefined);
    await call("PUT", `/api/nodes/${root}/position`, { surface: "graph", x: 10.5, y: 20, width: 200, height: 80, color: "red" });
    await call("PUT", `/api/nodes/${child}/position`, { surface: "graph", x: 300, y: -40 });
    await call("POST", "/api/pointers", { target_id: grandchild, parent_id: root, display_prefix: "see" });
    // What was made and then taken away leaves a tombstone, not a row.
    await call("PUT", `/api/nodes/${grandchild}/tags/${tag}`);
    await call("DELETE", `/api/nodes/${grandchild}/tags/${tag}`);
    await call("PUT", `/api/nodes/${child}/attributes/temp`, { value: "x" });
    await call("DELETE", `/api/nodes/${child}/attributes/temp`);
    const gone = await note("Soon gone");
    await call("DELETE", `/api/nodes/${gone}`);
    const purged = await note("Purged");
    await call("DELETE", `/api/nodes/${purged}`);
    await call("POST", `/api/nodes/${purged}/purge`, { expected_ids: [purged] });

    // The Site Config note lives in the system space no member reads as a note; the owner's copy carries it, edited, so that a
    // copy which rebuilt it instead would differ.
    await setSiteConfig(ws, { brand: "Round trip", accent: "#336699" });
    await setSiteConfig(ws, { brand: "Round trip (edited)", nav: "[1,2]" });

    // Tables that have no stamp trigger yet: their rows travel as "equal to genesis".
    await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state, previous_state) VALUES ($1, $2, $3, 'learning', 'new')`, [ws, root, owner.id]);
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb)`, [owner.id]);
    await seedQ(`INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at, ended_at, note) VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', now(), 'deep work')`, [ws, owner.id, child]);

    // A second person, and a space only they are in: the owner's snapshot must not hold what the owner cannot read.
    const friend = await persistActor(ws, { id: "", name: "Friend", role: "editor", type: "human" });
    await seedQ(`UPDATE actors SET invite_email = 'friend@example.test', invite_token_hash = 'not-a-real-hash' WHERE id = $1`, [friend.id]);
    const secretSpace = await makeSpace(ws, `Secret ${randomUUID().slice(0, 6)}`, [{ id: friend.id, permission: "edit" }]);
    const secretNote = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'content', 'Friend only', $3, 'private words', $4)`, [secretNote, ws, `secret-${secretNote}`, secretSpace]);
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view') ON CONFLICT DO NOTHING`, [spaceB, friend.id]);
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"light"'::jsonb)`, [friend.id]);

    // Tables that are stamped but not written through a route here.
    const fnRef = randomUUID();
    await seedQ(`INSERT INTO function_refs (id, workspace_id, function_id, holder_space_id, config) VALUES ($1, $2, 'tasks', $3, '{"a": 1, "b": "x"}'::jsonb)`, [fnRef, ws, spaceA]);
    await seedQ(`UPDATE function_refs SET config = '{"a": 2, "b": "x", "c": true}'::jsonb WHERE id = $1`, [fnRef]);
    await seedQ(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"on": true}'::jsonb)`, [owner.id, tag]);
    const sub = randomUUID();
    await seedQ(`INSERT INTO rss_subscriptions (id, workspace_id, space_id, title, url, created_by_actor_id, etag, last_error) VALUES ($1, $2, $3, 'Feed', 'https://example.test/feed.xml', $4, 'etag-of-this-node', 'unreachable')`, [sub, ws, spaceA, owner.id]);
    await seedQ(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, 'spoiler', now() + interval '30 days')`, [ws, owner.id]);
    const staged = randomUUID();
    await seedQ(`INSERT INTO rss_staging (id, workspace_id, subscription_id, guid, title, url, body) VALUES ($1, $2, $3, 'guid-1', 'Article', 'https://example.test/a', 'body text')`, [staged, ws, sub]);
    await seedQ(`INSERT INTO rss_seen (staging_id, actor_id, seen, seen_at) VALUES ($1, $2, true, now())`, [staged, owner.id]);
    await seedQ(`INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host) VALUES (gen_random_uuid(), $1, $2, 'Calendar', '#336699', '\x0102'::bytea, 'cal.example.test')`, [ws, owner.id]);
    const block = randomUUID();
    await seedQ(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, text_cache) VALUES ($1, $2, $3, 'blk1', 'paragraph', 'a paragraph')`, [block, ws, child]);
    await seedQ(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [block, tag, ws]);
    await seedQ(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, kind, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, 'anc1', $2, 'range', 2, 6, (SELECT encode(sha256(convert_to(COALESCE(markdown, ''), 'UTF8')), 'hex') FROM content_nodes WHERE id = $2), 'wo')`, [ws, child]);
    await seedQ(`INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, 'link text', 'anc1')`, [ws, child]);
    const agent = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'agent' LIMIT 1`, [ws])).rows[0]!.id;
    const sug = randomUUID();
    await seedQ(`INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash, created_event_id) VALUES ($1, $2, $3, $4, $5, 'old', 'T', 'ph', 12345)`, [sug, ws, spaceA, child, agent]);
    await seedQ(`INSERT INTO ai_edit_suggestion_items (suggestion_id, seq, kind, base_text, new_text, status) VALUES ($1, 0, 'replace', 'old', 'new', 'pending'), ($1, 1, 'insert', 'x', 'y', 'accepted')`, [sug]);
    await seedQ(`INSERT INTO review_states (workspace_id, block_id, actor_id, state) VALUES ($1, $2, $3, 'review')`, [ws, block, owner.id]);
    return { ws, owner, friend, spaceA, spaceB, secretSpace, secretNote, call };
  });
}

/** What a copy needs besides the pages: where it came from and the source's digest. */
export type Capture = { pages: StampedPage[]; summary: Awaited<ReturnType<typeof readStampedPages>> };

/** Read the snapshot on `node` as an owner would send it: every page goes through JSON, as it would on the wire. */
export function capture(node: RealNode | null, world: Pick<SourceWorld, "ws" | "owner">, pageBytes?: number): Promise<Capture> {
  return onNode(node, async () => {
    const pages: StampedPage[] = [];
    const summary = await readStampedPages(world.owner, world.ws, { since: null, layer: "rows", pageBytes }, async (page) => { pages.push(JSON.parse(JSON.stringify(page))); });
    return { pages, summary };
  });
}

/** Fill the empty database `node` from a capture, the way the service does (start, every page, finish). */
export function fillFrom(node: RealNode | null, world: Pick<SourceWorld, "ws" | "owner">, cap: Capture, options: { localLogin?: string | null } = {}): Promise<void> {
  return onNode(node, async () => {
    await startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former });
    try {
      for (const page of cap.pages) await applyJoinPage(page);
      await finishJoin({ workspaceId: world.ws, pages: cap.pages.length, digest: cap.summary.digest, localLogin: options.localLogin ?? null });
    } catch (e) {
      await abandonJoin(world.ws);
      throw e;
    }
  });
}

/** Every carried table's rows as JSON text, one table at a time, the owner's scope, straight from the tables (not through the
 *  export): what the digest is checked against. Columns a snapshot leaves out are dropped; a person's sign-in link is not carried. */
export function rowsOf(node: RealNode | null, world: Pick<SourceWorld, "ws" | "owner">): Promise<Record<string, string[]>> {
  return onNode(node, async () => {
    const out: Record<string, string[]> = {};
    await q(`SELECT set_config('TimeZone', 'UTC', false)`);
    for (const spec of SNAPSHOT_SPECS) {
      const params: unknown[] = [world.ws];
      const where = spec.where(snapshotScope(world.owner, params, true));
      const drop = [...(spec.exclude ?? []), ...(spec.table === "actors" ? ["external_id"] : [])];
      const r = await q<{ v: unknown }>(`SELECT to_jsonb(t) - $${params.push(drop)}::text[] AS v FROM "${spec.table}" t WHERE ${where}`, params);
      out[spec.table] = r.rows.map((row) => JSON.stringify(row.v)).sort();
    }
    return out;
  });
}

export type StampRow = { table_name: string; row_key: string; field: string; origin: string; seq: string; hlc_wall: string; hlc_counter: number; author: string | null; device: string | null; deleted: boolean; saw: Record<string, number>; meta: unknown };

/** The ids of notes and spaces of the workspace that `world.owner` cannot read (their stamps are not in the owner's snapshot). */
export function outOfScopeIds(node: RealNode | null, world: Pick<SourceWorld, "ws" | "owner">): Promise<string[]> {
  return onNode(node, async () => {
    const noteParams: unknown[] = [world.ws];
    const notes = await q<{ id: string }>(`SELECT t.id::text FROM content_nodes t WHERE t.workspace_id = $1 AND NOT (${snapshotScope(world.owner, noteParams, true).nodeRow("t")})`, noteParams);
    const spaceParams: unknown[] = [world.ws];
    const spaces = await q<{ id: string }>(`SELECT t.id::text FROM spaces t WHERE t.workspace_id = $1 AND NOT (${snapshotScope(world.owner, spaceParams, true).space("t.id")})`, spaceParams);
    return [...notes.rows, ...spaces.rows].map((r) => r.id);
  });
}

/** All stamps of the workspace except those of rows `without` names, ordered: for the row-by-row check. */
export function stampsOfWorkspace(node: RealNode | null, world: Pick<SourceWorld, "ws">, without: string[] = []): Promise<StampRow[]> {
  return onNode(node, async () => {
    const r = await q<StampRow>(
      `SELECT table_name, row_key, field, origin, seq::text, hlc_wall::text, hlc_counter, author, device::text, deleted, saw, meta FROM sync_stamps WHERE workspace_id = $1
        ORDER BY table_name COLLATE "C", row_key COLLATE "C", field COLLATE "C"`, [world.ws]);
    return r.rows.filter((s) => !s.row_key.split("/").some((part) => without.includes(part)));
  });
}

/** The other heads of units (sync_stamp_heads) of the workspace, in a fixed order. */
export function headsOfWorkspace(node: RealNode | null, world: Pick<SourceWorld, "ws">): Promise<Record<string, unknown>[]> {
  return onNode(node, async () => (await q<Record<string, unknown>>(
    `SELECT table_name, row_key, field, origin, seq::text, content_hash, hlc_wall::text, hlc_counter, author, device::text, deleted, saw, meta, value FROM sync_stamp_heads WHERE workspace_id = $1
      ORDER BY table_name COLLATE "C", row_key COLLATE "C", field COLLATE "C", origin COLLATE "C", seq, content_hash`, [world.ws])).rows);
}

/** The digest of the workspace as `person` reads it on `node`: what the receiver holds, in the terms the source's digest was made in. */
export function digestAs(node: RealNode | null, ws: string, person: ActorCtx) {
  return onNode(node, () => withActorReadSnapshot(person, ws, async (actor) => computeSnapshotDigest(ws, await snapshotScopeFor(actor))));
}

/** Rows of the world's database that the owner's snapshot leaves out ON PURPOSE (and why), as SQL over alias `t` of each table: what the
 *  source has and the receiver does not, and may not. Everything else a table holds must arrive: stampedSnapshotTwoProcess compares WHOLE
 *  tables with a hash of its own (helpers/stampedRowHashes.ts), not the rows the snapshot selected, so a row the selection forgot (the Site
 *  Config note once) is counted as missing instead of being invisible. */
export function notCarriedOnPurpose(world: Pick<SourceWorld, "secretNote" | "secretSpace" | "friend">): Record<string, string> {
  const friend = `'${world.friend.id}'`;
  return {
    // a space nobody is in (the install's restricted space) is not something the owner reads; the friend's own space and the space only they are in are not the owner's
    spaces: `t.id::text = '${world.secretSpace}' OR (t.kind = 'personal' AND t.owner_actor_id::text = ${friend}) OR NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = t.id)`,
    space_members: `t.space_id::text = '${world.secretSpace}' OR t.space_id IN (SELECT s.id FROM spaces s WHERE s.kind = 'personal' AND s.owner_actor_id::text = ${friend})`,
    content_nodes: `t.id::text = '${world.secretNote}'`,
    // what the note's text produces (markdown, frontmatter, derived values) is worked out again by the receiver
    node_attributes: `t.source NOT IN ('ui', 'explicit', 'dispatcher') OR t.node_id::text = '${world.secretNote}'`,
    node_edges: `t.origin <> 'manual'`,
    actor_prefs: `t.actor_id::text = ${friend}`,
    // a suggestion that was decided has nothing left to merge
    ai_edit_suggestion_items: `t.status <> 'pending'`,
  };
}
