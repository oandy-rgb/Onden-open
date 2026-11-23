// The tables a snapshot carried with genesis stamps only travel by change bundle (migration 236; own-node transport §2.11, batch 5). For EACH of them, on two real
// databases that joined from one snapshot: a write on one node is a unit that reaches the other (unit); two nodes that both wrote the same row end with the same rows
// and the same stamps in either order, the losing write kept as a head a person can see (merge); two rows with one natural key made on two nodes settle the same
// way on both (natural key, where the table has one); a received value no honest writer makes is refused whole and nothing is written (received check).
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { focusOfDay } from "../modules/tasks/focus.js";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, expectSame, peerOf, peerStateOf, resendAll, take, writeAsOwner, type Peer } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** Two nodes holding one workspace (B joined from A's snapshot), each taking the other's bundles; a note of A's space both hold, and the AI actor of the workspace. */
async function pair(): Promise<{ a: Peer; b: Peer; note: string; agent: string }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b); await admit(b, a);
  const note = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { title: `Shared ${randomUUID().slice(0, 6)}`, markdown: "a line", space_id: a.space })).id as string);
  const agent = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'agent' ORDER BY id LIMIT 1`, [a.ws])).rows[0]!.id);
  await exchange(a, b);
  return { a, b, note, agent };
}
const as = (p: Peer, sql: string, params: unknown[]) => onNode(p.node, () => writeAsOwner(p, sql, params));
const one = <T>(p: Peer, sql: string, params: unknown[]) => onNode(p.node, async () => (await q<T & object>(sql, params)).rows[0]);
/** Both orders of one exchange from the same state are not reachable with two databases only; each node takes the other's, then the first takes back. */
async function settle(a: Peer, b: Peer, label: string): Promise<void> {
  await exchange(a, b); await exchange(b, a); await exchange(a, b);
  await expectSame(a, b, label);
  // one more round stores nothing, and a full resend is taken without a change
  const again = await exchange(b, a);
  expect(again.stored, `${label}: one more round`).toBe(0);
  expect((await resendAll(a, b)).stored, `${label}: a full resend`).toBe(0);
}
/** The other heads a node holds of one table: the writes that lost, which a person sees as a conflict. */
const headsOf = (p: Peer, table: string) => onNode(p.node, async () =>
  Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2`, [p.ws, table])).rows[0]!.n));
const stampedField = (p: Peer, table: string, row: string, field: string) => one<{ origin: string }>(p, `SELECT origin FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [p.ws, table, row, field]);

type Row = Extract<ChangeBundle["items"][number], { kind: "row" }>;
const rowsOf = (bundle: ChangeBundle, table: string): Row[] => bundle.items.filter((i): i is Row => i.kind === "row" && i.table === table);
const refusalOf = (b: Peer, bundle: ChangeBundle) => take(b, bundle).then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: String(e.message) }));

describe.skipIf(!isTestDb)("the tables a snapshot carried with genesis stamps only travel by bundle (migration 236)", () => {
  it("ai_edit_suggestions and their items: a suggestion made on one node and decided on the other reaches both; two decisions of one item end the same on both, the other one kept as a head", async () => {
    const { a, b, note, agent } = await pair();
    const sug = randomUUID(), item = randomUUID();
    await as(a, `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES ($1, $2, $3, $4, $5, 'a line', 'T', 'h1')`, [sug, a.ws, a.space, note, agent]);
    await as(a, `INSERT INTO ai_edit_suggestion_items (id, suggestion_id, seq, kind, base_text, new_text) VALUES ($1, $2, 0, 'replace', 'a line', 'a better line')`, [item, sug]);
    // unit: the row and the item are stamped by the node that wrote them, and arrive
    expect(await stampedField(a, "ai_edit_suggestions", sug, "*")).toBeDefined();
    await exchange(a, b);
    expect(await one(b, `SELECT status FROM ai_edit_suggestion_items WHERE id = $1`, [item])).toEqual({ status: "pending" });
    // the item's workspace is its suggestion's (the column a stamp files it under)
    expect(await one(b, `SELECT workspace_id::text AS w FROM ai_edit_suggestion_items WHERE id = $1`, [item])).toEqual({ w: b.ws });
    // merge: A accepts, B (not knowing) rejects; one decision wins on both, the other is a head
    await as(a, `UPDATE ai_edit_suggestion_items SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1`, [item, a.owner.id]);
    await as(b, `UPDATE ai_edit_suggestion_items SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [item, b.owner.id]);
    await settle(a, b, "two decisions");
    const [sa, sb] = [await one<{ status: string }>(a, `SELECT status FROM ai_edit_suggestion_items WHERE id = $1`, [item]), await one<{ status: string }>(b, `SELECT status FROM ai_edit_suggestion_items WHERE id = $1`, [item])];
    expect(sa).toEqual(sb);
    expect(["accepted", "rejected"]).toContain(sa!.status);
    expect((await headsOf(a, "ai_edit_suggestion_items"))).toBeGreaterThan(0);
  }, 600_000);

  it("ai_edit_suggestion_items: two items with one (suggestion, seq) made under two ids keep the one made first on both nodes, whichever came first", async () => {
    const { a, b, note, agent } = await pair();
    const sug = randomUUID();
    await as(a, `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES ($1, $2, $3, $4, $5, 'a line', 'T', 'h2')`, [sug, a.ws, a.space, note, agent]);
    await exchange(a, b);
    const [first, second] = [randomUUID(), randomUUID()];
    await as(a, `INSERT INTO ai_edit_suggestion_items (id, suggestion_id, seq, kind, base_text, new_text) VALUES ($1, $2, 0, 'replace', 'a line', 'from A')`, [first, sug]);
    await as(b, `INSERT INTO ai_edit_suggestion_items (id, suggestion_id, seq, kind, base_text, new_text) VALUES ($1, $2, 0, 'replace', 'a line', 'from B')`, [second, sug]);
    const toB = await exchange(a, b);
    expect(toB.duplicateRows.map((d) => [d.table, d.kept, d.lost])).toEqual([["ai_edit_suggestion_items", first, second]]);
    await settle(a, b, "one natural key, two ids");
    for (const p of [a, b]) expect(await one(p, `SELECT array_agg(id::text) AS ids FROM ai_edit_suggestion_items WHERE suggestion_id = $1`, [sug])).toEqual({ ids: [first] });
  }, 600_000);

  it("actor_prefs: a preference set on one node reaches the other; set on both, the later write wins on both and the other is a head", async () => {
    const { a, b } = await pair();
    await as(a, `INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'navLayout', '["inbox"]'::jsonb) ON CONFLICT (actor_id, key) DO UPDATE SET value = EXCLUDED.value`, [a.owner.id]);
    expect(await stampedField(a, "actor_prefs", `${a.owner.id}/navLayout`, "*")).toBeDefined();
    await exchange(a, b);
    expect(await one(b, `SELECT value FROM actor_prefs WHERE actor_id = $1 AND key = 'navLayout'`, [b.owner.id])).toEqual({ value: ["inbox"] });
    await as(a, `UPDATE actor_prefs SET value = '["tasks"]'::jsonb, updated_at = now() WHERE actor_id = $1 AND key = 'navLayout'`, [a.owner.id]);
    await as(b, `UPDATE actor_prefs SET value = '["calendar"]'::jsonb, updated_at = now() WHERE actor_id = $1 AND key = 'navLayout'`, [b.owner.id]);
    await settle(a, b, "two preferences");
    expect(await one(a, `SELECT value FROM actor_prefs WHERE actor_id = $1 AND key = 'navLayout'`, [a.owner.id])).toEqual({ value: ["calendar"] });
    expect((await headsOf(b, "actor_prefs"))).toBeGreaterThan(0);
  }, 600_000);

  it("review_states: a card graded first on both nodes is one row (its id comes from the card and the person); its progress is the same on both, the other review a head", async () => {
    const { a, b, note } = await pair();
    await as(a, `INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-12-01","reps":1}')`, [a.ws, note, a.owner.id]);
    await as(b, `INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-11-25","reps":1}')`, [b.ws, note, b.owner.id]);
    const ids = [await one<{ id: string }>(a, `SELECT id::text FROM review_states WHERE node_id = $1`, [note]), await one<{ id: string }>(b, `SELECT id::text FROM review_states WHERE node_id = $1`, [note])];
    expect(ids[0]).toEqual(ids[1]);
    await settle(a, b, "two first reviews");
    const progress = (p: Peer) => one(p, `SELECT state, previous_state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [note, p.owner.id]);
    expect(await progress(a)).toEqual(await progress(b));
    // review progress is the same after a second review on one of them
    await as(b, `UPDATE review_states SET previous_state = state, state = '{"due":"2026-12-09","reps":2}', updated_at = now() WHERE node_id = $1 AND actor_id = $2`, [note, b.owner.id]);
    await settle(a, b, "a second review");
    expect(await progress(a)).toEqual({ state: '{"due":"2026-12-09","reps":2}', previous_state: expect.any(String) });
    expect(await progress(a)).toEqual(await progress(b));
  }, 600_000);

  it("review_states: two rows of one card and person made under two ids (as before the derived id) keep the one made first on both nodes", async () => {
    const { a, b, note } = await pair();
    const [x, y] = [randomUUID(), randomUUID()];
    await as(a, `INSERT INTO review_states (id, workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, $4, 'learning')`, [x, a.ws, note, a.owner.id]);
    await as(b, `INSERT INTO review_states (id, workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, $4, 'review')`, [y, b.ws, note, b.owner.id]);
    const toA = await exchange(b, a);
    expect(toA.duplicateRows.map((d) => [d.table, d.kept, d.lost])).toEqual([["review_states", x, y]]);
    await settle(a, b, "one card, two ids");
    for (const p of [a, b]) expect(await one(p, `SELECT id::text FROM review_states WHERE node_id = $1`, [note])).toEqual({ id: x });
  }, 600_000);

  it("focus_sessions: a record ended on the other node reaches back; two records running at once (made on two nodes) both stay on both, and the later one is the running one", async () => {
    const { a, b, note } = await pair();
    const s1 = randomUUID();
    await as(a, `INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at) VALUES ($1, $2, $3, $4, now() - interval '20 minutes')`, [s1, a.ws, a.owner.id, note]);
    await exchange(a, b);
    await as(b, `UPDATE focus_sessions SET ended_at = now(), note = 'done on B', updated_at = now() WHERE id = $1`, [s1]);
    await settle(a, b, "a record ended on B");
    expect(await one(a, `SELECT note FROM focus_sessions WHERE id = $1`, [s1])).toEqual({ note: "done on B" });
    // the write path still refuses a second running record on one node
    const [r1, r2] = [randomUUID(), randomUUID()];
    await as(a, `INSERT INTO focus_sessions (id, workspace_id, actor_id, started_at) VALUES ($1, $2, $3, now() - interval '5 minutes')`, [r1, a.ws, a.owner.id]);
    const second = await as(a, `INSERT INTO focus_sessions (id, workspace_id, actor_id, started_at) VALUES ($1, $2, $3, now())`, [randomUUID(), a.ws, a.owner.id]).then(() => null, (e: { code?: string }) => e.code);
    expect(second).toBe("23505");
    await as(b, `INSERT INTO focus_sessions (id, workspace_id, actor_id, started_at) VALUES ($1, $2, $3, now())`, [r2, b.ws, b.owner.id]);
    await settle(a, b, "two running records");
    for (const p of [a, b]) {
      expect(await one(p, `SELECT array_agg(id::text ORDER BY started_at) AS ids FROM focus_sessions WHERE actor_id = $1 AND ended_at IS NULL`, [p.owner.id])).toEqual({ ids: [r1, r2] });
      // what the day's view calls running (modules/tasks/focus.ts): the later one
      expect(await onNode(p.node, async () => (await focusOfDay(p.owner, {})).running?.id)).toBe(r2);
    }
  }, 600_000);

  it("block_link_bindings: a link bound on one node names the same paragraph on the other; one link text bound to two paragraphs on two nodes ends the same on both, the other a head", async () => {
    const { a, b, note } = await pair();
    await as(a, `INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, 'first words', 'anc-a')`, [a.ws, note]);
    await exchange(a, b);
    expect(await one(b, `SELECT anchor_id FROM block_link_bindings WHERE note_id = $1 AND link_text = 'first words'`, [note])).toEqual({ anchor_id: "anc-a" });
    await as(a, `INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, 'other words', 'anc-x')`, [a.ws, note]);
    await as(b, `INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, 'other words', 'anc-y')`, [b.ws, note]);
    await settle(a, b, "one link text, two paragraphs");
    const bound = (p: Peer) => one(p, `SELECT anchor_id FROM block_link_bindings WHERE note_id = $1 AND link_text = 'other words'`, [note]);
    expect(await bound(a)).toEqual(await bound(b));
    expect((await headsOf(a, "block_link_bindings"))).toBeGreaterThan(0);
  }, 600_000);

  it("actors (migration 237): an AI operator made on the centre after the device joined reaches the device with its membership row; a rename follows it", async () => {
    const { a, b } = await pair();
    const ai = randomUUID();
    await as(a, `INSERT INTO actors (id, workspace_id, name, type, write_mode) VALUES ($1, $2, 'Reviewer AI', 'agent', 'suggest')`, [ai, a.ws]);
    await as(a, `INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'suggest')`, [a.space, ai]);
    const report = await exchange(a, b);
    expect(report.hanging).toEqual([]);
    expect(await one(b, `SELECT name, type, write_mode FROM actors WHERE id = $1`, [ai])).toEqual({ name: "Reviewer AI", type: "agent", write_mode: "suggest" });
    expect(await one(b, `SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [b.space, ai])).toEqual({ permission: "suggest" });
    await as(a, `UPDATE actors SET name = 'Careful AI', write_mode = 'apply' WHERE id = $1`, [ai]);
    await settle(a, b, "an AI operator renamed on the centre");
    expect(await one(b, `SELECT name, write_mode FROM actors WHERE id = $1`, [ai])).toEqual({ name: "Careful AI", write_mode: "apply" });
  }, 600_000);

  it("actors: on a device (a node that joined from another) making, renaming or removing a person or an AI operator is refused and nothing is written; a temporary session and the sign-in link are its own", async () => {
    const { a, b } = await pair();
    const ai = randomUUID();
    const refusal = (sql: string, params: unknown[]) => as(b, sql, params).then(() => null, (e: { code?: string }) => e.code ?? String(e));
    expect(await refusal(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Made on the device', 'agent')`, [ai, b.ws])).toBe("actors_on_main_server");
    expect(await one(b, `SELECT count(*)::int AS n FROM actors WHERE id = $1`, [ai])).toEqual({ n: 0 });
    expect(await refusal(`UPDATE actors SET name = 'Renamed on the device' WHERE id = $1`, [b.owner.id])).toBe("actors_on_main_server");
    expect(await one(b, `SELECT name FROM actors WHERE id = $1`, [b.owner.id])).toEqual({ name: "Owner" });
    // what is this node's own is not refused: the sign-in link of the person, and a temporary session opened here
    expect(await refusal(`UPDATE actors SET external_id = 'local-login' WHERE id = $1`, [b.owner.id])).toBeNull();
    expect(await refusal(`INSERT INTO actors (id, workspace_id, name, type) VALUES (gen_random_uuid(), $1, 'Guest', 'session')`, [b.ws])).toBeNull();
    // the centre itself never joined: it may
    expect(await as(a, `INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Made on the centre', 'agent')`, [ai, a.ws])).toBe(1);
    // and the session made on the device never leaves it
    const toA = await bundleFor(b, a);
    expect(rowsOf(toA, "actors").map((r) => r.values?.type)).not.toContain("session");
  }, 600_000);

  // the owner's decision of 2026-11-23 (PR #1992, round 1, point 6): an accepted suggestion stays accepted. Its text is in the note (the acceptance's body write, which
  // travels as any body does, once); a rejection made on another node without seeing the acceptance does not turn it back, whichever came first.
  for (const order of ["accepted, then rejected elsewhere", "rejected, then accepted elsewhere"] as const) {
    it(`ai_edit_suggestion_items: ${order}: accepted on both nodes, with the acceptance's author and time, and the accepted text once in the note`, async () => {
      const { a, b, note, agent } = await pair();
      const sug = randomUUID(), item = randomUUID();
      await as(a, `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES ($1, $2, $3, $4, $5, 'a line', 'T', 'h5')`, [sug, a.ws, a.space, note, agent]);
      await as(a, `INSERT INTO ai_edit_suggestion_items (id, suggestion_id, seq, kind, base_text, new_text) VALUES ($1, $2, 0, 'replace', 'a line', 'a better line')`, [item, sug]);
      await exchange(a, b);
      const [accepter, rejecter] = order.startsWith("accepted") ? [a, b] : [b, a];
      if (rejecter === a) await as(a, `UPDATE ai_edit_suggestion_items SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [item, a.owner.id]);
      // the acceptance: the item and, as the write path does, the note's text with the change in it
      await as(accepter, `UPDATE ai_edit_suggestion_items SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1`, [item, accepter.owner.id]);
      await onNode(accepter.node, () => accepter.call("PATCH", `/api/nodes/${note}`, { markdown: "a better line" }));
      if (rejecter === b) await as(b, `UPDATE ai_edit_suggestion_items SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [item, b.owner.id]);
      await settle(a, b, order);
      const accepted = await one<{ at: string }>(accepter, `SELECT decided_at::text AS at FROM ai_edit_suggestion_items WHERE id = $1`, [item]);
      for (const p of [a, b]) {
        expect(await one(p, `SELECT status, decided_by::text AS by, decided_at::text AS at FROM ai_edit_suggestion_items WHERE id = $1`, [item]), p.name).toEqual({ status: "accepted", by: accepter.owner.id, at: accepted!.at });
        expect(await one(p, `SELECT markdown FROM content_nodes WHERE id = $1`, [note]), p.name).toEqual({ markdown: "a better line" });
      }
    }, 600_000);
  }

  it("review_states: a card graded on both nodes keeps the later grade's schedule on both; the other grade is kept as a head, not in the schedule (one unit, the later write wins)", async () => {
    const { a, b, note } = await pair();
    await as(a, `INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-12-01","by":"A"}')`, [a.ws, note, a.owner.id]);
    await as(b, `INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-11-29","by":"B"}')`, [b.ws, note, b.owner.id]);
    await settle(a, b, "two grades");
    for (const p of [a, b]) expect(await one(p, `SELECT state FROM review_states WHERE node_id = $1`, [note])).toEqual({ state: '{"due":"2026-11-29","by":"B"}' });
    // A's grade: a head of the row's progress, with its value, on both nodes (the row's creation is a head too: two nodes made it)
    for (const p of [a, b]) expect(await one(p, `SELECT count(*)::int AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'review_states' AND field = 'progress' AND (value::jsonb ->> 'state') = '{"due":"2026-12-01","by":"A"}'`, [p.ws])).toEqual({ n: 1 });
  }, 600_000);

  it("a temporary session's own row (a preference) on a device: its actor never leaves that node, so the row is not made on the other node and nothing is refused", async () => {
    const { a, b } = await pair();
    const session = randomUUID();
    await as(b, `INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Guest', 'session')`, [session, b.ws]);
    await as(b, `INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb)`, [session]);
    const report = await exchange(b, a);
    expect(await one(a, `SELECT count(*)::int AS n FROM actor_prefs WHERE actor_id = $1`, [session])).toEqual({ n: 0 });
    expect(report.created).toBeGreaterThanOrEqual(0);
  }, 600_000);

  // review of PR #1992, round 1, point 2: a bundle brings a person or an AI operator only as the main server wrote it, and only an AI operator is made by one.
  // Each refusal is the RECEIVER's (the bundle is changed or made elsewhere on purpose), the whole bundle, with nothing written.
  const unchangedRefusal = async (to: Peer, bundle: ChangeBundle) => {
    const before = await peerStateOf(to);
    const refused = await refusalOf(to, bundle);
    expect(JSON.stringify(await peerStateOf(to))).toBe(JSON.stringify(before));
    return refused?.code;
  };
  it("actors, received: the main server refuses an AI operator a device wrote (bundle_actors_not_from_centre), and nothing is written", async () => {
    const { a, b } = await pair();
    // a device that wrote one anyway (its refusal taken away for the test): the stamp names the device
    await onNode(b.node, () => q(`ALTER TABLE actors DISABLE TRIGGER actors_written_on_the_centre`));
    await as(b, `INSERT INTO actors (id, workspace_id, name, type) VALUES (gen_random_uuid(), $1, 'Made on the device', 'agent')`, [b.ws]);
    await onNode(b.node, () => q(`ALTER TABLE actors ENABLE TRIGGER actors_written_on_the_centre`));
    expect(await unchangedRefusal(a, await bundleFor(b, a))).toBe("bundle_actors_not_from_centre");
  }, 600_000);
  it("actors, received: a device refuses a person made on the centre, an AI operator with a sign-in link, a temporary session, and a change of an actor's kind (bundle_actor_not_allowed); nothing is written", async () => {
    const first = await pair();
    await as(first.a, `INSERT INTO actors (id, workspace_id, name, type) VALUES (gen_random_uuid(), $1, 'A second person', 'human')`, [first.a.ws]);
    expect(await unchangedRefusal(first.b, await bundleFor(first.a, first.b))).toBe("bundle_actor_not_allowed");
    const { a, b } = await pair();
    const ai = randomUUID();
    await as(a, `INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Linked AI', 'agent')`, [ai, a.ws]);
    for (const [why, spoil] of [
      ["a sign-in link", (r: Row) => { r.values.external_id = "someone@elsewhere"; }],
      ["a temporary session", (r: Row) => { r.values.type = "session"; }],
      ["a person", (r: Row) => { r.values.type = "human"; }],
    ] as const) {
      const bundle = await bundleFor(a, b);
      const row = rowsOf(bundle, "actors").find((r) => r.stamps[0]!.rowKey === ai)!;
      spoil(row);
      expect(await unchangedRefusal(b, bundle), why).toBe("bundle_actor_not_allowed");
    }
    // the operator as written arrives; a later rename carries the row whole, and one that says it is a person now is refused
    await exchange(a, b);
    await as(a, `UPDATE actors SET name = 'Renamed AI' WHERE id = $1`, [ai]);
    const rename = await bundleFor(a, b);
    rowsOf(rename, "actors").find((r) => r.stamps[0]!.rowKey === ai)!.values.type = "human";
    expect(await unchangedRefusal(b, rename)).toBe("bundle_actor_not_allowed");
  }, 600_000);

  // received check: one value of a real bundle changed between the sender and the receiver; refused whole, nothing written
  /** A unit's text as the database writes it (jsonb's own text: keys by length, ", " and ": "), so the only thing wrong with a spoiled value is the value. */
  const jsonbText = (p: Peer, v: unknown) => one<{ t: string }>(p, `SELECT $1::jsonb::text AS t`, [JSON.stringify(v)]).then((r) => r!.t);
  /** Change one column of a unit's composite text (and the carried value of a new row with it). */
  const spoilComposite = async (p: Peer, r: Row, field: string, column: string, value: unknown) => {
    const t = JSON.parse(String(r.texts[field])) as Record<string, unknown>;
    t[column] = value;
    r.texts[field] = await jsonbText(p, t);
    r.values[column] = value;
  };
  const SPOILED: Array<{ table: string; write: (a: Peer, ctx: { note: string; agent: string }) => Promise<unknown>; spoil: (a: Peer, r: Row) => Promise<void>; says: string }> = [
    { table: "actor_prefs", says: "a preference longer than any a writer stores",
      write: (a) => as(a, `INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb) ON CONFLICT (actor_id, key) DO UPDATE SET value = '"light"'::jsonb`, [a.owner.id]),
      spoil: (a, r) => spoilComposite(a, r, "value", "value", "x".repeat(1_000_001)) },
    { table: "review_states", says: "a review state that is not text",
      write: (a, c) => as(a, `INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{}')`, [a.ws, c.note, a.owner.id]),
      spoil: (a, r) => spoilComposite(a, r, "progress", "state", 7) },
    { table: "focus_sessions", says: "(focus_sessions: ",
      write: (a) => as(a, `INSERT INTO focus_sessions (id, workspace_id, actor_id, started_at, ended_at) VALUES (gen_random_uuid(), $1, $2, now() - interval '1 hour', now())`, [a.ws, a.owner.id]),
      spoil: (a, r) => spoilComposite(a, r, "session", "note", "n".repeat(501)) },
    { table: "ai_edit_suggestion_items", says: "(ai_edit_suggestion_items: ",
      write: async (a, c) => { const s = randomUUID(); await as(a, `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES ($1, $2, $3, $4, $5, 'a line', 'T', 'h3')`, [s, a.ws, a.space, c.note, c.agent]);
        return as(a, `INSERT INTO ai_edit_suggestion_items (suggestion_id, seq, kind, base_text, new_text) VALUES ($1, 0, 'replace', 'a line', 'b')`, [s]); },
      spoil: (a, r) => spoilComposite(a, r, "decision", "written_status", "maybe") },
    ...([["a slug that is the name a note holds only while slugs are given", "~not-a-slug"], ["a slug longer than any a writer stores", "x".repeat(100_001)], ["a note without a slug", null]] as const)
      .map(([says, slug]) => ({ table: "content_nodes", says,
        write: (a: Peer) => onNode(a.node, () => a.call("POST", "/api/nodes", { title: `Named ${randomUUID().slice(0, 6)}`, markdown: "x", space_id: a.space })),
        spoil: async (_a: Peer, r: Row) => { r.texts.slug = slug; r.values.written_slug = slug; } })),
    { table: "ai_edit_suggestions", says: "a suggestion's copy of its note longer than any note",
      write: (a, c) => as(a, `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'a line', 'T', 'h4')`, [a.ws, a.space, c.note, c.agent]),
      spoil: async (_a, r) => { r.values.base_markdown = "m".repeat(16_000_001); } },
    { table: "block_link_bindings", says: "(block_link_bindings: ",
      write: (a, c) => as(a, `INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1, $2, 'spoiled', 'anc-s')`, [a.ws, c.note]),
      spoil: async (_a, r) => { r.texts.anchor = "not an anchor id!"; r.values.anchor_id = "not an anchor id!"; } },
  ];
  for (const c of SPOILED) {
    it(`${c.table}: a received value no writer makes (${c.says.slice(0, 60)}) is refused whole (bundle_malformed) and nothing of the bundle is written`, async () => {
      const { a, b, note, agent } = await pair();
      await c.write(a, { note, agent });
      const bundle = await bundleFor(a, b);
      const rows = rowsOf(bundle, c.table);
      expect(rows.length, c.table).toBeGreaterThan(0);
      await c.spoil(a, rows[rows.length - 1]!);
      const before = await peerStateOf(b);
      const refused = await refusalOf(b, bundle);
      expect(refused?.code, c.table).toBe("bundle_malformed");
      expect(refused?.message, c.table).toContain(c.says);
      // the column's own CHECK, as this database holds it (checkReceived columnProblems), names what is wrong
      if (c.says.startsWith("(")) expect(refused?.message, c.table).toMatch(/check|CHECK|constraint|hold/);
      expect(JSON.stringify(await peerStateOf(b))).toBe(JSON.stringify(before));
    }, 600_000);
  }
});
