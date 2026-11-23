// Migration 220 on a database that already holds history (docs/architecture/proposals/history-replication-2026-11-22.md §8, §4.4; review of
// PR #1935 round 2, points 2, 3, 4, 6, 7, 8 and the two things it did not check: time and locks at 15,000 events, a second run).
// The history is written straight into the tables, as older code left it (events, blobs, rows without versions), and the migration's own
// pass is run on it: note_versions_backfill(workspace), the function the migration calls once per workspace. Both engines.
//
//   * the read-only PREVIEW in the migration's header gives exactly the numbers the pass writes (point 8);
//   * a save whose text is gone is not minted and is counted (point 2);
//   * saves of one transaction (one created_at) keep their (created_at, id) order as ordinals (point 3);
//   * "restored from" of a version restore and of an event undo, and every save event mapped (point 4);
//   * tags and system notes get nothing, an empty note no baseline (point 6);
//   * the root mints baselines, a joined workspace none, a workspace being joined nothing at all (point 7);
//   * two copies of one database, each migrated by itself, hold the same identities; a second run adds nothing and takes no number;
//   * 15,000 saves: the time the pass takes and the locks it holds, printed.
// realPostgresAlso: the commit-time checks read content putBlob committed on its own connection, and the save path spans two connections on a server
import { afterEach, describe, expect, it } from "vitest";
import { allowUnstampedWrite, dbDriver, q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { openNode } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { legacyVersionKey } from "../spine/versionIdentity.js";
import { PREVIEW_SQL } from "./helpers/versionsPreview.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const n = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
const uuid = (label: string) => `md5('${label}')::uuid`;

/** A workspace with an owner and a space; returns their ids. */
async function workspace(label: string): Promise<{ ws: string; owner: string; space: string }> {
  const ws = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1::text, $1::text) RETURNING id::text`, [`history ${label}`])).rows[0]!.id;
  const owner = (await seedQ<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Owner', 'human') RETURNING id::text`, [ws])).rows[0]!.id;
  const space = (await seedQ<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'S', 'shared') RETURNING id::text`, [ws])).rows[0]!.id;
  return { ws, owner, space };
}

/** History as older code left it: notes and their save events with the text in blobs, no versions. `bulk` notes × `saves` saves each,
 *  plus one small case per property. Returns the ids the checks look at. */
async function seedHistory(w: { ws: string; owner: string; space: string }, label: string, bulk: number, saves: number) {
  const ws = w.ws;
  const note = (key: string, title: string, markdown: string, nodeType = "content", source = "manual") => seedQ(
    `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES (${uuid(`${label}:${key}`)}, $1, $5, $4, $2, $6, $3, $7)`,
    [ws, title, markdown, nodeType, source, `${label}-${key}`, nodeType === "class_tag" ? null : w.space]);
  const blob = (text: string) => seedQ(`INSERT INTO blobs (hash, content, size_bytes) VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $1, octet_length($1)) ON CONFLICT DO NOTHING`, [text]);
  /** One save event of `key` with `text`; `at` seconds after a fixed start; returns its id. */
  const save = async (key: string, type: string, title: string, text: string, at: number, extra: { payload?: object; txMeta?: object } = {}) => (await seedQ<{ id: string }>(
    `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, created_at, body_hash)
     VALUES ($1, 'user', $2, $3, 'node', (${uuid(`${label}:${key}`)})::text,
             jsonb_build_object('title', $4::text, 'body_hash', encode(sha256(convert_to($5, 'UTF8')), 'hex')) || $7::jsonb, $8::jsonb,
             timestamptz '2026-01-01T00:00:00Z' + $6 * interval '1 second', encode(sha256(convert_to($5, 'UTF8')), 'hex')) RETURNING id::text`,
    [ws, w.owner, type, title, text, at, JSON.stringify(extra.payload ?? {}), JSON.stringify(extra.txMeta ?? {})])).rows[0]!.id;
  const ink = async (key: string, attr: string, type: string, value: string | null, at: number, prev: boolean) => {
    if (value !== null) await blob(value);
    await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, created_at)
       VALUES ($1, 'user', $2, $3, 'node', (${uuid(`${label}:${key}`)})::text,
               jsonb_build_object('key', $4::text) || CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('value_ref', encode(sha256(convert_to($5::text, 'UTF8')), 'hex'), 'value_len', length($5::text)) END,
               CASE WHEN $7 THEN '{"prev_field_values": {"value_ref": "x"}}'::jsonb ELSE '{}'::jsonb END,
               timestamptz '2026-01-01T00:00:00Z' + $6 * interval '1 second')`, [ws, w.owner, type, attr, value, at, prev]);
  };

  // the bulk: `bulk` notes, `saves` saves each, the last one the note's text
  await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
    SELECT md5($2::text || ':bulk:' || i)::uuid, $1, 'manual', 'content', 'Bulk ' || i, $2::text || '-bulk-' || i, 'bulk ' || i || ' save ' || $4::int, $3
      FROM generate_series(1, $5::int) i`, [ws, label, w.space, saves, bulk]);
  await seedQ(`INSERT INTO blobs (hash, content, size_bytes)
    SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex'), t, octet_length(t) FROM (SELECT 'bulk ' || i || ' save ' || s AS t FROM generate_series(1, $1::int) i, generate_series(1, $2::int) s) x
    ON CONFLICT DO NOTHING`, [bulk, saves]);
  await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at, body_hash)
    SELECT $1, 'user', $2, CASE WHEN s = 1 THEN 'NODE_CREATED' ELSE 'NODE_UPDATED' END, 'node', md5($3::text || ':bulk:' || i)::uuid::text,
           jsonb_build_object('title', 'Bulk ' || i, 'body_hash', encode(sha256(convert_to('bulk ' || i || ' save ' || s, 'UTF8')), 'hex')),
           timestamptz '2025-01-01T00:00:00Z' + (i * 1000 + s) * interval '1 second', encode(sha256(convert_to('bulk ' || i || ' save ' || s, 'UTF8')), 'hex')
      FROM generate_series(1, $4::int) i, generate_series(1, $5::int) s ORDER BY i, s`, [ws, w.owner, label, bulk, saves]);

  // point 3: two saves of one transaction share created_at; the second has the larger id
  await note("same-tx", "T", "t b");
  for (const text of ["t a", "t b"]) await blob(text);
  const sameA = await save("same-tx", "NODE_UPDATED", "T", "t a", 10), sameB = await save("same-tx", "NODE_UPDATED", "T", "t b", 10);
  // point 10 / the version list's rule: a save that repeats the one before it is that version again
  await note("repeat", "R", "r"); await blob("r");
  await save("repeat", "NODE_CREATED", "R", "r", 20); await save("repeat", "NODE_UPDATED", "R", "r", 21);
  // point 2: a save whose text is gone
  await note("gone", "G", "kept text"); await blob("kept text");
  await save("gone", "NODE_CREATED", "G", "text that is gone", 30); await save("gone", "NODE_UPDATED", "G", "kept text", 31);
  // point 4: a version restore (payload.version_id) and an event undo (tx_meta.restored_from = the undone event)
  await note("restored", "V", "v1"); for (const text of ["v1", "v2"]) await blob(text);
  const v1 = await save("restored", "NODE_CREATED", "V", "v1", 40); await save("restored", "NODE_UPDATED", "V", "v2", 41);
  await save("restored", "NODE_RESTORED", "V", "v1", 42, { payload: { version_id: v1 } });
  // a version restore that put back what the note already held (a repeat of the save before it): it mints nothing, so it names nothing
  await note("restored-repeat", "RR", "rr2"); for (const text of ["rr1", "rr2"]) await blob(text);
  const rr1 = await save("restored-repeat", "NODE_CREATED", "RR", "rr1", 43); await save("restored-repeat", "NODE_UPDATED", "RR", "rr2", 44);
  await save("restored-repeat", "NODE_RESTORED", "RR", "rr2", 45, { payload: { version_id: rr1 } });
  // two restores in one transaction (one instant) that put back the same text: the second repeats the first and so has the first's key;
  // only the first (the kept save) names what it restored, never the repeat, whatever order the rows lie in
  await note("restored-twice", "RT", "x1"); for (const text of ["x1", "x2"]) await blob(text);
  const x1 = await save("restored-twice", "NODE_CREATED", "RT", "x1", 46); const x2 = await save("restored-twice", "NODE_UPDATED", "RT", "x2", 47);
  await save("restored-twice", "NODE_RESTORED", "RT", "x1", 48, { payload: { version_id: x1 } });
  await save("restored-twice", "NODE_RESTORED", "RT", "x1", 48, { payload: { version_id: x2 } });
  await note("undone", "U", "u1"); for (const text of ["u1", "u2"]) await blob(text);
  await save("undone", "NODE_CREATED", "U", "u1", 50); const u2 = await save("undone", "NODE_UPDATED", "U", "u2", 51);
  await save("undone", "NODE_UPDATED", "U", "u1", 52, { txMeta: { restored_from: u2 } });
  // a baseline: text no save names; and an empty note, which gets none (point 6)
  await note("no-events", "B", "written before history was kept"); await note("empty", "E", "");
  // drawings: set, set, remove; a pre-172 save of a note whose layer 172 moved to board_ink; a drawing no save names
  await note("ink", "I", ""); await ink("ink", "ink_data", "ATTRIBUTE_SET", "i1", 60, false); await ink("ink", "ink_data", "ATTRIBUTE_SET", "i2", 61, true);
  await ink("ink", "ink_data", "ATTRIBUTE_DELETED", null, 62, true);
  await note("moved", "M", ""); await ink("moved", "ink_data", "ATTRIBUTE_SET", "m1", 70, false);
  await seedQ(`INSERT INTO board_ink_moves (node_id, workspace_id, action, reason, suggested, signals, board_ink_attribute_id, value_hash, moved_at)
    VALUES (${uuid(`${label}:moved`)}, $1, 'moved', 'canvas_note_conversion', 'board', '{}', gen_random_uuid(), 'x', timestamptz '2026-06-01T00:00:00Z')`, [ws]);
  // an older drawing save with its value inline (before value_ref), and a drawing save whose value is gone
  await note("inline", "IV", "");
  await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
     VALUES ($1, 'user', $2, 'ATTRIBUTE_SET', 'node', (${uuid(`${label}:inline`)})::text, '{"key": "ink_data", "value": "an inline drawing"}'::jsonb, timestamptz '2026-01-01T00:01:30Z')`, [ws, w.owner]);
  await note("inkgone", "IG", "");
  await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
     VALUES ($1, 'user', $2, 'ATTRIBUTE_SET', 'node', (${uuid(`${label}:inkgone`)})::text, '{"key": "ink_data", "value_ref": "${"e".repeat(64)}"}'::jsonb, timestamptz '2026-01-01T00:01:40Z')`, [ws, w.owner]);
  await note("drawn", "D", "");
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, ${uuid(`${label}:drawn`)}, 'note_ink', 'drawn without an event', 'ui')`, [ws]);
  // out of scope: a tag and a system note with saves (point 6)
  await note("tag", "a tag", "a tag's text", "class_tag"); await blob("a tag's text"); await save("tag", "NODE_UPDATED", "a tag", "a tag's text", 80);
  await note("system", "Site Config", "", "content", "system"); await blob(""); await save("system", "NODE_CREATED", "Site Config", "", 81);
  // deleted notes keep their versions (the trash is not a purge)
  for (const key of ["root", "child", "alone"]) await note(key, key, "");
  const del = async (key: string, cause: string | null) => (await seedQ<{ id: string }>(
    `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, triggered_by_event_id)
     VALUES ($1, 'user', $2, 'NODE_DELETED', 'node', (${uuid(`${label}:${key}`)})::text, '{}', $3::bigint) RETURNING id::text`, [ws, w.owner, cause])).rows[0]!.id;
  const rootDelete = await del("root", null);
  for (const [key, id] of [["root", rootDelete], ["child", await del("child", rootDelete)], ["alone", await del("alone", null)]] as const) {
    await seedQ(`UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = $1::bigint WHERE id = ${uuid(`${label}:${key}`)}`, [id]);
  }
  return { sameA, sameB, id: async (key: string) => (await q<{ id: string }>(`SELECT ${uuid(`${label}:${key}`)}::text AS id`)).rows[0]!.id };
}

/** The pass of the migration over every workspace, in one transaction as migrate() runs it; with its time and the locks it held. */
async function migratePass(): Promise<{ ms: number; locks: string[]; added: Record<string, number> }> {
  return allowUnstampedWrite("test: the migration's data step, as migrate() runs it", () => withTransaction(async () => {
    await q(`SELECT set_config('onden.no_versions', 'on', true)`);
    await q(`SELECT set_config('statement_timeout', '0', true)`); // as migrate() runs a migration (SET LOCAL statement_timeout = 0)
    const t = performance.now();
    const rows = (await q<{ versions: string; baselines: string; set_aside: string }>(
      `SELECT b.* FROM workspaces w CROSS JOIN LATERAL note_versions_backfill(w.id) b`)).rows;
    const ms = Math.round(performance.now() - t);
    const locks = (await q<{ l: string }>(
      `SELECT DISTINCT CASE WHEN l.locktype = 'relation' THEN 'table ' || c.relname || ' ' || l.mode ELSE l.locktype || ' ' || l.mode END AS l
         FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND (l.locktype <> 'relation' OR (c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'pg_%')) ORDER BY 1`)).rows.map((r) => r.l);
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + Number(r[k]), 0);
    return { ms, locks, added: { versions: sum("versions"), baselines: sum("baselines"), set_aside: sum("set_aside") } };
  }));
}

/** Every version's identity fields (§2.5), and the records of this node kept apart. */
const identities = () => q(`SELECT note_id, unit, version_key, kind, title, content_hash, CASE WHEN version_key LIKE 'b:%' THEN NULL ELSE at END AS at,
                                   clock_wall, clock_counter, ordinal, author_kind, author_id, restored_from
                              FROM note_versions ORDER BY note_id, unit, version_key`).then((r) => r.rows);
const preview = async () => (await q<Record<string, string>>(PREVIEW_SQL)).rows[0]!;
const fromTheTables = async () => ({
  body_versions: String(await n(`SELECT count(*)::text AS n FROM note_versions WHERE unit = 'body' AND version_key LIKE 'g:%'`)),
  ink_versions: String(await n(`SELECT count(*)::text AS n FROM note_versions WHERE unit <> 'body' AND version_key LIKE 'g:%' AND kind <> 'set_aside'`)),
  body_baselines: String(await n(`SELECT count(*)::text AS n FROM note_versions WHERE unit = 'body' AND version_key LIKE 'b:%'`)),
  ink_baselines: String(await n(`SELECT count(*)::text AS n FROM note_versions WHERE unit <> 'body' AND version_key LIKE 'b:%'`)),
  ink_inline_values: String(await n(`SELECT count(DISTINCT ve.version_key)::text AS n FROM note_version_events ve JOIN domain_events e ON e.id = ve.event_id
     WHERE e.event_type = 'ATTRIBUTE_SET' AND NOT e.payload ? 'value_ref' AND e.payload ? 'value'`)),
  drawing_saves_without_value: String(await n(`SELECT count(*)::text AS n FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id AND note_version_in_scope(c.node_type, c.source_type)
     WHERE e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink') AND e.payload ? 'value_ref'
       AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'value_ref') AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = c.id AND m.hash = e.payload->>'value_ref')
       AND NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = e.workspace_id AND j.state = 'joining')`)),
  saves_without_text: String(await n(`SELECT count(*)::text AS n FROM domain_events e WHERE e.event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND e.payload ? 'body_hash'
     AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.body_hash) AND EXISTS (SELECT 1 FROM content_nodes c WHERE c.id::text = e.target_id AND c.node_type = 'content' AND c.source_type <> 'system')
     AND NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = e.workspace_id AND j.state = 'joining')`)),
});

describe.skipIf(!isTestDb)("migration 220 on existing history", () => {
  it("the preview's numbers are what the pass writes; root, joined and joining workspaces; order, restores, the event map; two copies agree; a second run adds nothing", async () => {
    const a = await openNode("history-a"); open.push(a);
    const seeded = await onNode(a, async () => {
      const root = await workspace("root"), joined = await workspace("joined"), joining = await workspace("joining");
      const r = await seedHistory(root, "root", 20, 5);
      await seedHistory(joined, "joined", 3, 3);
      await seedHistory(joining, "joining", 3, 3);
      await seedQ(`INSERT INTO sync_join (workspace_id, source_node, cut_seq, state) VALUES ($1, 'elsewhere', 1, 'done'), ($2, 'elsewhere', 1, 'joining')`, [joined.ws, joining.ws]);
      // what the shell and the template left are not this test's: start from no versions at all
      await seedQ(`DELETE FROM note_versions`);
      // migration 220 ran before 231 gave tags a version list: the pass is checked against the rule it had (a tag's own pass is noteVersionsTags.integration.test.ts)
      await seedQ(`CREATE OR REPLACE FUNCTION note_version_in_scope(p_node_type text, p_source_type text) RETURNS boolean AS $$
        SELECT p_node_type IN ('content', 'canvas') AND p_source_type IS DISTINCT FROM 'system'; $$ LANGUAGE sql IMMUTABLE`);
      return { root, joined, joining, r };
    });
    const b = await RealNode.open("history-b", a); open.push(b); // a second copy of the same database, migrated by itself
    // and its event rows in another physical order (as a dump restored elsewhere, or a rewritten table, may hold them): the pass reads orders
    // only from (created_at, id), so the answer may not depend on it (review of PR #1938 round 1, point 2)
    await onNode(b, async () => {
      await seedQ(`ALTER TABLE domain_events DISABLE TRIGGER ALL`);
      await seedQ(`CREATE TABLE events_reordered AS SELECT * FROM domain_events ORDER BY id DESC`);
      await seedQ(`DELETE FROM domain_events`);
      await seedQ(`INSERT INTO domain_events SELECT * FROM events_reordered ORDER BY random()`);
      await seedQ(`DROP TABLE events_reordered`);
      await seedQ(`ALTER TABLE domain_events ENABLE TRIGGER ALL`);
    });

    const [before, pass] = await onNode(a, async () => [await preview(), await migratePass()] as const);
    const after = await onNode(a, fromTheTables);
    console.log(`[migration 220] preview ${JSON.stringify(before)}; written ${JSON.stringify(after)}; pass ${JSON.stringify(pass)}`);
    expect(after).toEqual(before);
    // not vacuous: every kind of row is there
    for (const [k, v] of Object.entries(before)) expect(Number(v), k).toBeGreaterThan(0);

    await onNode(a, async () => {
      const { root, joined, joining, r } = seeded;
      const versionsOf = async (key: string, unit = "body") => (await q<{ version_key: string; kind: string; ordinal: number; restored_from: string | null; content_hash: string | null }>(
        `SELECT version_key, kind, ordinal, restored_from, content_hash FROM note_versions WHERE note_id = $1 AND unit = $2 ORDER BY ordinal`, [await r.id(key), unit])).rows;
      // point 7: baselines on the root only; the joining workspace has nothing
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1 AND version_key LIKE 'b:%'`, [root.ws])).toBe(2);
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1 AND version_key LIKE 'b:%'`, [joined.ws])).toBe(0);
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1 AND version_key LIKE 'g:%'`, [joined.ws])).toBeGreaterThan(0);
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [joining.ws])).toBe(0);
      // point 3: one instant, two saves: the ordinals follow the event ids
      const same = await versionsOf("same-tx");
      const keyOf = async (id: string) => (await q<{ k: string }>(`SELECT version_key AS k FROM note_version_events WHERE event_id = $1`, [id])).rows[0]!.k;
      expect(same.map((v) => v.version_key)).toEqual([await keyOf(r.sameA), await keyOf(r.sameB)]);
      // the version list's rule: a repeat is the version before it, and both its events map to it
      expect(await versionsOf("repeat")).toHaveLength(1);
      expect(await n(`SELECT count(*)::text AS n FROM note_version_events WHERE note_id = $1`, [await r.id("repeat")])).toBe(2);
      // point 2: the save whose text is gone is not a version
      expect((await versionsOf("gone")).map((v) => v.kind)).toEqual(["updated"]);
      // point 4
      const restored = await versionsOf("restored");
      expect(restored.map((v) => v.kind)).toEqual(["created", "updated", "restored"]);
      expect(restored[2]!.restored_from).toBe(restored[0]!.version_key);
      // the local write path mints no version for a restore that changes nothing, so the version it repeats keeps no "restored from"
      const repeat = await versionsOf("restored-repeat");
      expect(repeat.map((v) => [v.kind, v.restored_from])).toEqual([["created", null], ["updated", null]]);
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE restored_from = version_key`)).toBe(0);
      const twice = await versionsOf("restored-twice");
      expect(twice.map((v) => v.kind)).toEqual(["created", "updated", "restored"]);
      expect(twice[2]!.restored_from).toBe(twice[0]!.version_key);
      const undone = await versionsOf("undone");
      expect(undone[2]!.restored_from).toBe(undone[0]!.version_key);
      // drawings, and the unit 172 gives a moved note's old save
      expect((await versionsOf("ink", "ink_data")).map((v) => v.kind)).toEqual(["created", "updated", "removed"]);
      expect(await versionsOf("moved", "ink_data")).toHaveLength(0);
      expect(await versionsOf("moved", "board_ink")).toHaveLength(1);
      expect((await versionsOf("drawn", "note_ink")).map((v) => v.kind)).toEqual(["baseline"]);
      // the inline value became a version whose content is stored; the save whose value is gone did not
      const inline = await versionsOf("inline", "ink_data");
      expect(inline.map((v) => v.kind)).toEqual(["created"]);
      expect((await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [inline[0]!.content_hash])).rows[0]!.content).toBe("an inline drawing");
      expect(await versionsOf("inkgone", "ink_data")).toEqual([]);
      // point 6
      for (const key of ["tag", "system", "empty"]) expect(await versionsOf(key), key).toEqual([]);
      // every save of a note that has a version list maps to a version, except the one whose text is gone
      expect(await n(`SELECT count(*)::text AS n FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id AND note_version_in_scope(c.node_type, c.source_type)
                       WHERE e.workspace_id = $1 AND e.payload ? 'body_hash' AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.event_id = e.id)`, [root.ws])).toBe(1);
      // the key SQL computes is the one JS computes (point 9 on real rows)
      const one = (await q<{ note_id: string; kind: string; title: string; content_hash: string; at: string; version_key: string }>(
        `SELECT note_id::text, kind, title, content_hash, at, version_key FROM note_versions WHERE note_id = $1 ORDER BY ordinal LIMIT 1`, [await r.id("restored")])).rows[0]!;
      expect(legacyVersionKey(one.note_id, "body", one.kind, one.content_hash, one.title, one.at)).toBe(one.version_key);
    });

    // the second copy, migrated by itself, holds exactly the same identities
    await onNode(b, migratePass);
    const [ida, idb] = [await onNode(a, identities), await onNode(b, identities)];
    expect(ida.length).toBeGreaterThan(100);
    expect(idb).toEqual(ida);

    // a second run: nothing added, no sequence number taken, no position added
    await onNode(a, async () => {
      const seqs = () => q(`SELECT workspace_id, next_seq FROM sync_clock ORDER BY workspace_id`).then((x) => x.rows);
      const [s0, p0, e0, all0] = [await seqs(), await n(`SELECT count(*)::text AS n FROM note_version_positions`), await n(`SELECT count(*)::text AS n FROM note_version_events`), await identities()];
      const again = await migratePass();
      expect(again.added).toEqual({ versions: 0, baselines: 0, set_aside: 0 });
      expect(await seqs()).toEqual(s0);
      expect(await n(`SELECT count(*)::text AS n FROM note_version_positions`)).toBe(p0);
      expect(await n(`SELECT count(*)::text AS n FROM note_version_events`)).toBe(e0);
      expect(await identities()).toEqual(all0);
      // one number per workspace that got rows, every row of the pass at it
      expect(await n(`SELECT count(DISTINCT (workspace_id, seq))::text AS n FROM note_version_positions`)).toBe(2);
    });
  }, 600_000);

  it("drawings of several MB with no version (baselines hashed once in SQL): the pass's time, printed", async () => {
    const a = await openNode("history-big-ink"); open.push(a);
    await onNode(a, async () => {
      const w = await workspace("big-ink");
      const DRAWINGS = 30, MB = 3;
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
        SELECT md5('big-ink:' || i)::uuid, $1, 'manual', 'content', 'Drawing ' || i, 'big-ink-' || i, '', $2 FROM generate_series(1, $3::int) i`, [w.ws, w.space, DRAWINGS]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
        SELECT $1, md5('big-ink:' || i)::uuid, 'note_ink', '{"v":1,"strokes":[' || i || ',' || repeat('[1.25,2.5,3.75],', $3::int * 1024 * 1024 / 16) || '0]}', 'ui'
          FROM generate_series(1, $2::int) i`, [w.ws, DRAWINGS, MB]);
      await seedQ(`DELETE FROM note_versions`);
      const pass = await migratePass();
      console.log(`[migration 220] ${dbDriver}: ${DRAWINGS} drawings of ${MB} MB with no version → ${JSON.stringify(pass.added)} in ${pass.ms} ms`);
      expect(pass.added.baselines).toBe(DRAWINGS);
    });
  }, 600_000);

  it("15,000 saves: the pass's time and the locks it holds (printed); every save becomes one version", async () => {
    const a = await openNode("history-scale"); open.push(a);
    await onNode(a, async () => {
      const w = await workspace("scale");
      await seedHistory(w, "scale", 500, 30);
      await seedQ(`DELETE FROM note_versions`);
      const pass = await migratePass();
      console.log(`[migration 220] ${dbDriver}: 15,000 saves of 500 notes → ${JSON.stringify(pass.added)} in ${pass.ms} ms; locks held: ${pass.locks.join("; ")}`);
      expect(await n(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1 AND version_key LIKE 'g:%' AND note_id IN (SELECT id FROM content_nodes WHERE title LIKE 'Bulk %')`, [w.ws])).toBe(15_000);
      // what it locks: the tables it reads and writes, the workspace's event-append lock (advisory) and its clock row; no table is locked
      // against reads (no ACCESS EXCLUSIVE, no SHARE lock on a table people read)
      expect(pass.locks.filter((l) => /^table /.test(l) && / (ShareLock|ShareRowExclusiveLock|ExclusiveLock|AccessExclusiveLock)$/.test(l)
        && !/ (note_version|nv_)/.test(l))).toEqual([]);
    });
  }, 600_000);
});
