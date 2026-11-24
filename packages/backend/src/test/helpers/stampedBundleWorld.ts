// Nodes that write for a while and then exchange change bundles (spine/stampedBundle.ts, spine/stampedImport.ts applyChangeBundle), for the tests of batch 2b-1.
// A "peer" is one database (a RealNode of this process, or null: the database this process has, which is how the worker process of the two-process test uses them)
// with the owner of the shared workspace and the routes a person writes through. The generator is seeded and writes through the REAL routes (creates, titles, bodies,
// moves that may close a cycle once two nodes have made theirs, reorders, trash, undelete, permanent delete, the same id made again), so what is exchanged is what the triggers
// stamped. (The pure simulator's generators, helpers/stampedSim/, speak units, not routes; they cannot drive a database.)
import { keyBetween } from "@onden/markdown/contract";
import { q, withTransaction } from "../../db.js";
import { readChangeBundle } from "../../services/stampedBundle.js";
import { readHave, bundleOf, type Have } from "../../spine/stampedBundle.js";
import { admitSyncNode, applyChangeBundle } from "../../spine/stampedImport.js";
import { compareDigests, type ChangeBundle, type TableDigest } from "../../spine/snapshotSql.js";
import type { ActorCtx } from "../../types.js";
import { onNode, type RealNode } from "./distSim/realNode.js";
import { makeRng, type Rng } from "./distSim/rng.js";
import { buildSourceWorld, capture, digestAs, fillFrom, headsOfWorkspace, makeCaller, openNode, outOfScopeIds, stampsOfWorkspace } from "./stampedWorld.js";
import { setModulesOn } from "./setModulesOn.js";
import { localNodeId, stampTransaction } from "../../spine/stamps.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { CARRIED_LABELS } from "../../spine/stampedMerge/dbUnits.js";

export type Peer = { name: string; node: RealNode | null; ws: string; owner: ActorCtx; space: string; call: ReturnType<typeof makeCaller> };

export const peerOf = (name: string, node: RealNode | null, world: { ws: string; owner: ActorCtx; spaceA: string }): Peer => ({ name, node, ws: world.ws, owner: world.owner, space: world.spaceA, call: makeCaller(world.owner) });

type Note = { id: string; parent_id: string | null; deleted: boolean; order_key: string | null; markdown: string };

/** The live and trashed notes this peer holds that people made (not tags, not the system's). */
async function notesOf(p: Peer): Promise<Note[]> {
  return (await q<{ id: string; parent_id: string | null; deleted: boolean; order_key: string | null; markdown: string }>(
    `SELECT id::text, parent_id::text, (deleted_at IS NOT NULL) AS deleted, order_key, markdown FROM content_nodes
      WHERE workspace_id = $1 AND node_type = 'content' AND source_type = 'manual' ORDER BY created_at, title, id`, [p.ws])).rows;
}

/** `Date.now()` of this process runs `offsetMs` ahead while `fn` runs (the stamps of a node whose clock is wrong). */
export async function withClockAhead<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}

const uuidFrom = (rng: Rng): string => { const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rng.next() * 16).toString(16)).join(""); return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`; };

export type WriteOptions = { weights?: Partial<Record<Op, number>>; ids?: () => string };
export type Op = "create" | "title" | "body" | "move" | "reorder" | "trash" | "undelete" | "purge" | "recreate"
  | "attr" | "unattr" | "tagMake" | "tag" | "untag" | "point" | "unpoint" | "schemaKey" | "row";
/** The writes of the other tables (batch 2b-2a) are off by default, so a seed of an earlier test draws the same writes as before; `ALL_TABLES` turns them on. */
const DEFAULT_WEIGHTS: Record<Op, number> = { create: 18, title: 16, body: 16, move: 14, reorder: 10, trash: 8, undelete: 3, purge: 6, recreate: 5,
  attr: 0, unattr: 0, tagMake: 0, tag: 0, untag: 0, point: 0, unpoint: 0, schemaKey: 0, row: 0 };
/** Weights that also write attributes (set, unset), tags (made, applied, removed, a key of a tag's schema set or removed: a JSON key unit) and pointers (made, removed). */
export const ALL_TABLES: Partial<Record<Op, number>> = { attr: 12, unattr: 5, tagMake: 3, tag: 10, untag: 5, point: 8, unpoint: 4, schemaKey: 8, row: 16 };
const ATTR_KEYS = ["status", "rating", "colour"];
const purgedIds = new WeakMap<Peer, string[]>();
/** Titles are unique per peer for the whole run (a slug is derived from a title and must stay unique among a space's notes; test stampedBundleSlugs covers a collision). */
const counters = new WeakMap<Peer, number>();
const nextN = (p: Peer): number => { const n = (counters.get(p) ?? 0) + 1; counters.set(p, n); return n; };
/** The notes that existed when the world was built: set by `markWorld`. */
const WORLD_NOTES = new Set<string>();
/** The notes that have rows in tables a bundle does not carry yet (attributes, edges, pointers, positions, tags, blocks): the generator leaves them alone for the writes that would cascade or derive. */
export async function markWorld(p: Peer): Promise<void> {
  const ids = await onNode(p.node, async () => (await q<{ id: string }>(
    `SELECT DISTINCT id::text FROM (
       SELECT node_id AS id FROM node_attributes UNION ALL SELECT source_node_id FROM node_edges UNION ALL SELECT target_node_id FROM node_edges
       UNION ALL SELECT parent_id FROM note_pointers UNION ALL SELECT target_id FROM note_pointers UNION ALL SELECT node_id FROM node_positions
       UNION ALL SELECT node_id FROM node_tags UNION ALL SELECT note_id FROM block_nodes UNION ALL SELECT note_id FROM block_anchors) x WHERE id IS NOT NULL`)).rows.map((r) => r.id));
  for (const id of ids) WORLD_NOTES.add(id);
}

/** `count` random writes by `peer`, as the owner, through the routes. A route that refuses (a cycle, a purge of a note that is not in the trash) is part of the run: it is skipped. Returns what was done. */
export async function writeFor(peer: Peer, rng: Rng, count: number, options: WriteOptions = {}): Promise<Record<Op, number>> {
  const done = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0])) as Record<Op, number>;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const bag = (Object.keys(weights) as Op[]).flatMap((op) => Array<Op>(weights[op] ?? 0).fill(op));
  const newId = options.ids ?? (() => uuidFrom(rng));
  await onNode(peer.node, async () => {
    for (let i = 0; i < count; i++) {
      const op = rng.pick(bag);
      const notes = await notesOf(peer);
      const live = notes.filter((n) => !n.deleted), trashed = notes.filter((n) => n.deleted && !WORLD_NOTES.has(n.id));
      // trash and purge only what the generator made: a note of the world has attributes, edges, pointers and positions, which cascade away with it, and a bundle carries no tombstones of those tables yet
      const mine = live.filter((n) => !WORLD_NOTES.has(n.id));
      try {
        if (op === "create" || (live.length === 0 && op !== "recreate")) {
          const parent = live.length && rng.chance(0.6) ? rng.pick(live) : null;
          await peer.call("POST", "/api/nodes", { id: newId(), title: `${peer.name} ${nextN(peer)}`, markdown: `# ${peer.name} ${i}\n\nfirst`, space_id: peer.space, ...(parent ? { parent_id: parent.id } : {}) });
          done.create++;
        } else if (op === "title" && mine.length) {
          await peer.call("PATCH", `/api/nodes/${rng.pick(mine).id}`, { title: `${peer.name} title ${nextN(peer)}` });
          done.title++;
        } else if (op === "body" && mine.length) {
          const n = rng.pick(mine);
          await peer.call("PATCH", `/api/nodes/${n.id}`, { markdown: `${n.markdown}\n${peer.name} line ${i}` });
          done.body++;
        } else if (op === "move" && mine.length && live.length > 1) {
          const n = rng.pick(mine), target = rng.chance(0.2) ? null : rng.pick(live.filter((x) => x.id !== n.id));
          await peer.call("PATCH", `/api/nodes/${n.id}`, { parent_id: target?.id ?? null });
          done.move++;
        } else if (op === "reorder" && live.length > 1) {
          const n = rng.pick(live), other = rng.pick(live.filter((x) => x.id !== n.id));
          await peer.call("PATCH", `/api/nodes/${n.id}`, { order_key: keyBetween(other.order_key, null) });
          done.reorder++;
        } else if (op === "trash" && mine.length) {
          await peer.call("DELETE", `/api/nodes/${rng.pick(mine).id}`);
          done.trash++;
        } else if (op === "undelete" && trashed.length) {
          await peer.call("POST", `/api/nodes/${rng.pick(trashed).id}/undelete`);
          done.undelete++;
        } else if (op === "purge" && trashed.length) {
          const id = rng.pick(trashed).id;
          const preview = await peer.call("GET", `/api/nodes/${id}/purge-preview`);
          const ids = (preview.ids ?? preview.notes?.map((x: { id: string }) => x.id) ?? [id]) as string[];
          await peer.call("POST", `/api/nodes/${id}/purge`, { expected_ids: ids });
          purgedIds.set(peer, [...(purgedIds.get(peer) ?? []), ...ids]);
          done.purge++;
        } else if (op === "attr" && mine.length) {
          await peer.call("PUT", `/api/nodes/${rng.pick(mine).id}/attributes/${rng.pick(ATTR_KEYS)}`, { value: `${peer.name} ${nextN(peer)}` });
          done.attr++;
        } else if (op === "unattr" && mine.length) {
          const withAttr = await q<{ node_id: string; key: string }>(`SELECT node_id::text, key FROM node_attributes WHERE workspace_id = $1 AND source = 'ui' AND key = ANY($2::text[]) ORDER BY node_id, key`, [peer.ws, ATTR_KEYS]);
          if (withAttr.rows.length) { const x = rng.pick(withAttr.rows); await peer.call("DELETE", `/api/nodes/${x.node_id}/attributes/${x.key}`); done.unattr++; }
        } else if (op === "tagMake") {
          await peer.call("POST", "/api/tags", { name: `${peer.name}-tag-${nextN(peer)}` });
          done.tagMake++;
        } else if ((op === "tag" || op === "untag" || op === "schemaKey") && mine.length) {
          const tags = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title ~ '-tag-' AND deleted_at IS NULL ORDER BY id`, [peer.ws])).rows;
          if (tags.length) {
            const tag = rng.pick(tags).id;
            if (op === "tag") { await peer.call("PUT", `/api/nodes/${rng.pick(mine).id}/tags/${tag}`); done.tag++; }
            else if (op === "untag") {
              const on = (await q<{ node_id: string }>(`SELECT node_id::text FROM node_tags WHERE tag_id = $1 ORDER BY node_id`, [tag])).rows;
              if (on.length) { await peer.call("DELETE", `/api/nodes/${rng.pick(on).node_id}/tags/${tag}`); done.untag++; }
            } else {
              const schema = (await q<{ s: Record<string, unknown> | null }>(`SELECT tag_schema AS s FROM content_nodes WHERE id = $1`, [tag])).rows[0]?.s ?? {};
              const key = rng.pick(["due", "owner", "size"]);
              const next = { ...schema };
              // always a change (a write that changes nothing takes no stamp): remove the key, or give it the other type, or add it
              const was = (next[key] as { type?: string } | undefined)?.type;
              if (was && rng.chance(0.4)) delete next[key]; else next[key] = { type: was === "text" ? "number" : was === "number" ? "text" : rng.pick(["text", "number"]) };
              // a local write of the column (the json trigger stamps it key by key); the schema route takes only its own top-level keys, which is not what is driven here.
              // A person's write, as the route's mutate stamps it: a write outside every root has no author and may not settle a conflict (migration 221)
              await withTransaction(() => withEventTransaction(peer.ws, async () => { await stampTransaction(peer.ws, peer.owner.id); await q(`UPDATE content_nodes SET tag_schema = $2::jsonb WHERE id = $1`, [tag, JSON.stringify(next)]); }));
              done.schemaKey++;
            }
          }
        } else if (op === "point" && live.length > 1) {
          const target = rng.pick(live), parent = rng.pick(live.filter((x) => x.id !== target.id));
          await peer.call("POST", "/api/pointers", { target_id: target.id, parent_id: parent.id });
          done.point++;
        } else if (op === "unpoint") {
          const ptrs = (await q<{ id: string }>(`SELECT id::text FROM note_pointers WHERE workspace_id = $1 ORDER BY id`, [peer.ws])).rows;
          if (ptrs.length) { await peer.call("DELETE", `/api/pointers/${rng.pick(ptrs).id}`); done.unpoint++; }
        } else if (op === "row") {
          if (await writeOtherRow(peer, rng, mine.map((n) => n.id))) done.row++;
        } else if (op === "recreate" && (purgedIds.get(peer) ?? []).length) {
          const id = rng.pick(purgedIds.get(peer)!);
          await peer.call("POST", "/api/nodes", { id, title: `${peer.name} again ${nextN(peer)}`, markdown: `again ${i}`, space_id: peer.space });
          purgedIds.set(peer, purgedIds.get(peer)!.filter((x) => x !== id));
          done.recreate++;
        }
      } catch (error) {
        // the route refused it (a cycle, a note that is not in the trash, a parent that is gone): part of the run. Anything else is a broken generator, not a refusal
        // (a catch-all here hid for a round that the direct writes to the feeds and mutes all threw: PR #1778 round 2, docs/agents/mistakes.md)
        if (!/ → 4\d\d: /.test((error as Error).message)) throw error;
      }
    }
  });
  return done;
}

/**
 * One random write, straight to a row, of a table no route of this world reaches (the routes are a module's, or need a second person): a card's position, a space's name or one
 * of its switches, a member's permission, a feed, a mute, a calendar, a person's module settings, a key of a function reference's config, a module switch. A local write in one
 * stamped transaction, which the table's stamp trigger stamps like any other (the service rules of these tables are not what is tested here). Returns whether it wrote.
 */
/** One write of each of `ops` through the generator, as `peer`; returns what was done (a run that must reach every table asserts each is 1). */
export async function writeEachOp(peer: Peer, rng: Rng, ops: readonly Op[]): Promise<Partial<Record<Op, number>>> {
  const done: Partial<Record<Op, number>> = {};
  const none = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0])) as Record<Op, number>;
  for (const op of ops) done[op] = (await writeFor(peer, rng, 1, { weights: { ...none, [op]: 1 } }))[op];
  return done;
}

/** One direct row write of each kind (writeOtherRow), as `peer`: a run that must reach every table does this once besides its random writes. Returns the kinds that wrote nothing
 *  (a kind with nothing to change: no function reference, no second person). */
export async function writeEachRowKind(peer: Peer, rng: Rng): Promise<string[]> {
  return onNode(peer.node, async () => {
    const own = async () => (await notesOf(peer)).filter((n) => !n.deleted && !WORLD_NOTES.has(n.id)).map((n) => n.id);
    // a card needs a live note of this node's own: when the random writes trashed them all, make one (through the route, like any other note)
    if (!(await own()).length) await peer.call("POST", "/api/nodes", { id: uuidFrom(rng), title: `${peer.name} ${nextN(peer)}`, markdown: "for a card", space_id: peer.space });
    const mine = await own();
    const idle: string[] = [];
    for (const kind of ROW_KINDS) if (!(await writeOtherRow(peer, rng, mine, kind))) idle.push(kind);
    return idle;
  });
}

const ROW_KINDS = ["position", "spaceName", "capability", "member", "feed", "mute", "calendar", "moduleSettings", "config", "moduleSwitch"] as const;
const ROW_TURNS = new Map<string, number>();
/** Forget whose turn each row kind is (ROW_TURNS is kept per peer NAME, across tests): a test that calls this first draws the same writes for a seed whatever ran before it
 *  in its file (the shuffled order otherwise changes them: review of the snapshot-source batch, round 1, A3). */
export function resetRowTurns(): void { ROW_TURNS.clear(); }
/** A local write as the owner, in one stamped transaction (what mutate gives a root write; a stamped table refuses a write without one), on the database this
 *  process is on (wrap it in `onNode`). Returns the rows the statement touched. */
export const writeAsOwner = (peer: Peer, sql: string, params: unknown[]): Promise<number> => withTransaction(() => withEventTransaction(peer.ws, async () => {
  await stampTransaction(peer.ws, peer.owner.id);
  return (await q(sql, params)).rowCount ?? 0;
}));
async function writeOtherRow(peer: Peer, rng: Rng, mine: string[], only?: (typeof ROW_KINDS)[number]): Promise<boolean> {
  const n = nextN(peer), owner = peer.owner.id;
  const one = (sql: string, params: unknown[]) => writeAsOwner(peer, sql, params);
  // the kinds take turns (each peer goes through all ten every ten row writes), so a run with a handful of row writes per peer reaches every table; what is written is random
  const turn = ROW_TURNS.get(peer.name) ?? 0;
  if (!only) ROW_TURNS.set(peer.name, turn + 1);
  switch (only ?? ROW_KINDS[turn % ROW_KINDS.length]!) {
    case "position": {
      if (!mine.length) return false;
      const node = rng.pick(mine);
      const placed = (await q(`SELECT 1 FROM node_positions WHERE node_id = $1 AND surface = 'scale-board'`, [node])).rows.length > 0;
      if (placed && rng.chance(0.2)) return (await one(`DELETE FROM node_positions WHERE node_id = $1 AND surface = 'scale-board'`, [node])) > 0; // a card that is placed is sometimes taken off
      return (await one(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', $2, $3, $4)
                         ON CONFLICT (node_id, surface) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y`, [node, rng.int(500), rng.int(500), peer.ws])) > 0;
    }
    case "spaceName": return (await one(`UPDATE spaces SET name = $2 WHERE id = $1`, [peer.space, `${peer.name} space ${n}`])) > 0;
    case "capability": return (await one(`UPDATE spaces SET capabilities = capabilities || jsonb_build_object($2::text, $3::boolean) WHERE id = $1`, [peer.space, rng.pick(["publish", "comments", "tasks"]), rng.chance(0.5)])) > 0;
    case "member": {
      const other = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'human' AND id <> $2 ORDER BY id LIMIT 1`, [peer.ws, owner])).rows[0];
      if (!other) return false;
      return (await one(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, $3) ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = EXCLUDED.permission`,
        [peer.space, other.id, rng.pick(["view", "suggest", "edit"])])) > 0;
    }
    case "feed": {
      const feeds = (await q<{ id: string }>(`SELECT id::text FROM rss_subscriptions WHERE workspace_id = $1 ORDER BY id`, [peer.ws])).rows;
      if (feeds.length && rng.chance(0.6)) return (await one(`UPDATE rss_subscriptions SET title = $2 WHERE id = $1`, [rng.pick(feeds).id, `${peer.name} feed ${n}`])) > 0;
      return (await one(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, $3, $4)`, [peer.ws, peer.space, `${peer.name} feed ${n}`, `https://feeds.example/${peer.name}/${n}`])) > 0;
    }
    case "mute": {
      const mutes = (await q<{ id: string }>(`SELECT id::text FROM rss_mutes WHERE workspace_id = $1 ORDER BY id`, [peer.ws])).rows;
      if (mutes.length && rng.chance(0.3)) return (await one(`DELETE FROM rss_mutes WHERE id = $1`, [rng.pick(mutes).id])) > 0;
      return (await one(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')`, [peer.ws, owner, `${peer.name}-word-${n}`])) > 0;
    }
    case "calendar": {
      const cals = (await q<{ id: string }>(`SELECT id::text FROM external_calendars WHERE workspace_id = $1 ORDER BY id`, [peer.ws])).rows;
      if (cals.length && rng.chance(0.6)) return (await one(`UPDATE external_calendars SET name = $2, enabled = $3 WHERE id = $1`, [rng.pick(cals).id, `${peer.name} cal ${n}`, rng.chance(0.5)])) > 0;
      return (await one(`INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host) VALUES (gen_random_uuid(), $1, $2, $3, '#336699', '\\x'::bytea, 'calendars.example')`,
        [peer.ws, owner, `${peer.name} cal ${n}`])) > 0;
    }
    case "moduleSettings": {
      const tag = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL ORDER BY id LIMIT 1`, [peer.ws])).rows[0];
      if (!tag) return false;
      return (await one(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, $3::jsonb) ON CONFLICT (actor_id, tag_id) DO UPDATE SET settings = EXCLUDED.settings`,
        [owner, tag.id, JSON.stringify({ size: rng.int(5), by: peer.name })])) > 0;
    }
    case "config": {
      const refs = (await q<{ id: string }>(`SELECT id::text FROM function_refs WHERE workspace_id = $1 ORDER BY id`, [peer.ws])).rows;
      if (!refs.length) return false;
      return (await one(`UPDATE function_refs SET config = config || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [rng.pick(refs).id, rng.pick(["limit", "sort", "group"]), `${peer.name}${n}`])) > 0;
    }
    case "moduleSwitch": {
      const id = rng.pick(["rss", "website", "calendar", "canvas"]);
      return (await one(`UPDATE workspaces SET modules_off = CASE WHEN modules_off ? $2 THEN modules_off - $2 ELSE modules_off || to_jsonb($2::text) END WHERE id = $1`, [peer.ws, id])) > 0;
    }
  }
}

/** Three nodes A, B, C holding one workspace: A is the source world (`markWorld`), B and C joined from A's snapshot, each admits the other two as senders, every module
 *  on. The nodes are pushed onto `open` for the caller to close. `secretNote`: a note of a space the owner is not a member of (what a bundle withholds). */
export async function threePeers(open: RealNode[]): Promise<Peer[] & { secretNote?: string }> {
  const [na, nb, nc] = [await openNode("a"), await openNode("b"), await openNode("c")];
  open.push(na, nb, nc);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  const cap = await capture(na, world, 12_000);
  await fillFrom(nb, world, cap);
  await fillFrom(nc, world, cap);
  const b = peerOf("B", nb, world), c = peerOf("C", nc, world);
  for (const [x, y] of [[a, b], [a, c], [b, a], [b, c], [c, a], [c, b]] as const) await admit(x, y);
  for (const p of [a, b, c]) await onNode(p.node, () => setModulesOn(p.ws, null));
  return Object.assign([a, b, c], { secretNote: world.secretNote });
}

/** A bundle from `from` for `to`: what `to` holds is asked of `to`, the bundle is read on `from`, and goes through JSON as it would on the wire. */
export async function bundleFor(from: Peer, to: Peer, options: { pageBytes?: number } = {}): Promise<ChangeBundle> {
  const have = await onNode(to.node, () => readHave(to.ws));
  const pages = await onNode(from.node, () => readChangeBundle(from.owner, from.ws, have, options));
  return bundleOf(JSON.parse(JSON.stringify(pages)));
}

/** Everything `from` holds, sent again as if `to` held nothing (`have` empty), through JSON: what a node that exchanged to the end must take without a change or a refusal. */
export async function resendAll(from: Peer, to: Peer) {
  return take(to, bundleOf(JSON.parse(JSON.stringify(await onNode(from.node, () => readChangeBundle(from.owner, from.ws, {}))))));
}

/** Take a bundle at `to`. */
export const take = (to: Peer, bundle: ChangeBundle) => onNode(to.node, () => applyChangeBundle(to.ws, bundle));

/** `to` takes everything `from` has that it lacks. */
export async function exchange(from: Peer, to: Peer, options: { pageBytes?: number } = {}) {
  return take(to, await bundleFor(from, to, options));
}

export const nodeIdOf = (p: Peer): Promise<string> => onNode(p.node, () => localNodeId());
export const admit = (centre: Peer, other: Peer): Promise<void> => nodeIdOf(other).then((id) => onNode(centre.node, () => admitSyncNode(centre.ws, id)));

/** What a peer holds of the workspace, in the terms two databases can be compared in: the digest (rows and stamps with saw and meta and the other heads), and the stamps and heads as they are. */
export async function peerStateOf(p: Peer): Promise<{ digest: TableDigest[]; stamps: unknown; heads: unknown; conflicts: string[] }> {
  const digest = await digestAs(p.node, p.ws, p.owner);
  const carried = new Set<string>(CARRIED_LABELS);
  const stamps = (await stampsOfWorkspace(p.node, p, await outOfScopeIds(p.node, p))).filter((s) => carried.has(String(s.table_name))).map((s) => ({ ...s }));
  const heads = (await headsOfWorkspace(p.node, p)).filter((h) => carried.has(String(h.table_name)));
  const conflicts = heads.map((h) => `${String(h.row_key)}/${String(h.field)}/${String(h.origin)}:${String(h.seq)}/${String(h.value)}`).sort();
  return { digest, stamps, heads, conflicts };
}

export async function expectSame(a: Peer, b: Peer, label = ""): Promise<{ a: Awaited<ReturnType<typeof peerStateOf>>; b: Awaited<ReturnType<typeof peerStateOf>> }> {
  const [sa, sb] = [await peerStateOf(a), await peerStateOf(b)];
  const diff = compareDigests(sa.digest, sb.digest);
  if (diff.length) {
    // name what differs: the rows (columns) and the stamps of the tables that differ, a few of each
    const detail: Record<string, unknown> = {};
    for (const t of [...new Set(diff.map((d) => d.table))]) {
      const rowsOf = (p: Peer) => onNode(p.node, async () => (await q<{ r: unknown }>(`SELECT to_jsonb(t) - 'updated_at_unused' AS r FROM "${t}" t ${t === "content_nodes" || t === "node_attributes" || t === "note_pointers" ? "WHERE t.workspace_id = $1" : "WHERE $1::uuid IS NOT NULL"}`, [p.ws])).rows.map((x) => JSON.stringify(x.r)));
      const stampsOf = (p: Peer) => onNode(p.node, async () => (await q<{ r: unknown }>(`SELECT to_jsonb(s) AS r FROM sync_stamps s WHERE workspace_id = $1 AND split_part(table_name, '.', 1) = $2`, [p.ws, t])).rows.map((x) => JSON.stringify(x.r)));
      const [ra, rb, sa2, sb2] = [await rowsOf(a), await rowsOf(b), await stampsOf(a), await stampsOf(b)];
      const only = (x: string[], y: string[]) => { const ys = new Set(y); return x.filter((v) => !ys.has(v)).slice(0, 2); };
      detail[t] = { rowsOnlyA: only(ra, rb), rowsOnlyB: only(rb, ra), stampsOnlyA: only(sa2, sb2), stampsOnlyB: only(sb2, sa2) };
    }
    throw new Error(`${label} ${a.name} and ${b.name} differ: ${JSON.stringify(diff)} ${JSON.stringify(detail)}`);
  }
  const firstDiff = (x: unknown[], y: unknown[]) => { const xs = new Set(x.map((v) => JSON.stringify(v))), ys = new Set(y.map((v) => JSON.stringify(v))); return { only: [...xs].filter((v) => !ys.has(v)).slice(0, 3), other: [...ys].filter((v) => !xs.has(v)).slice(0, 3) }; };
  if (JSON.stringify(sa.stamps) !== JSON.stringify(sb.stamps)) throw new Error(`${label} ${a.name} and ${b.name} hold different stamps: ${JSON.stringify(firstDiff(sa.stamps as unknown[], sb.stamps as unknown[]))}`);
  if (JSON.stringify(sa.heads) !== JSON.stringify(sb.heads)) throw new Error(`${label} ${a.name} and ${b.name} hold different other heads: ${JSON.stringify(firstDiff(sa.heads as unknown[], sb.heads as unknown[]))}`);
  return { a: sa, b: sb };
}

/** `have` with `origin` at `n` in every carried label: a test's "the receiver holds n of this origin", in the per-label form (spine/stampedBundle.ts Have). */
export const withOriginAt = (have: Have, origin: string, n: number): Record<string, Record<string, number>> =>
  Object.fromEntries(CARRIED_LABELS.map((l) => [l, { ...(have[l] ?? {}), [origin]: n }]));

/** The number a Have gives `origin`, the same in every carried label (what a node holds after taking whole bundles; a test that reads one number per origin).
 *  Undefined when no label names it; throws when the labels differ (the test then has to say which label it means). */
export function heldAt(have: Have, origin: string): number | undefined {
  const per = CARRIED_LABELS.map((l) => (have[l] && Object.hasOwn(have[l]!, origin) ? have[l]![origin]! : undefined));
  if (per.every((n) => n === undefined)) return undefined;
  if (new Set(per).size !== 1) throw new Error(`the labels hold ${origin} to different numbers: ${JSON.stringify(per)}`);
  return per[0]!;
}

/** The least number a Have gives `origin` over every carried label (a label that does not name it: 0): how far it holds that origin's writes to every table. */
export const leastAt = (have: Have, origin: string): number => Math.min(...CARRIED_LABELS.map((l) => (have[l] && Object.hasOwn(have[l]!, origin) ? have[l]![origin]! : 0)));

export { makeRng };
