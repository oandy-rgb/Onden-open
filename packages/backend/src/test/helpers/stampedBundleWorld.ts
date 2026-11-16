// Nodes that write for a while and then exchange change bundles (spine/stampedBundle.ts, spine/stampedImport.ts applyChangeBundle), for the tests of batch 2b-1.
// A "peer" is one database (a RealNode of this process, or null: the database this process has, which is how the worker process of the two-process test uses them)
// with the owner of the shared workspace and the routes a person writes through. The generator is seeded and writes through the REAL routes (creates, titles, bodies,
// moves that may close a cycle once two nodes have made theirs, reorders, trash, undelete, permanent delete, the same id made again), so what is exchanged is what the triggers
// stamped. (The pure simulator's generators, helpers/stampedSim/, speak units, not routes; they cannot drive a database.)
import { keyBetween } from "@onden/markdown/contract";
import { q } from "../../db.js";
import { readChangeBundle } from "../../services/stampedBundle.js";
import { readHave, bundleOf } from "../../spine/stampedBundle.js";
import { admitSyncNode, applyChangeBundle } from "../../spine/stampedImport.js";
import { compareDigests, type ChangeBundle, type TableDigest } from "../../spine/snapshotSql.js";
import type { ActorCtx } from "../../types.js";
import { onNode, type RealNode } from "./distSim/realNode.js";
import { makeRng, type Rng } from "./distSim/rng.js";
import { digestAs, headsOfWorkspace, makeCaller, outOfScopeIds, stampsOfWorkspace } from "./stampedWorld.js";
import { localNodeId } from "../../spine/stamps.js";

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
export type Op = "create" | "title" | "body" | "move" | "reorder" | "trash" | "undelete" | "purge" | "recreate";
const DEFAULT_WEIGHTS: Record<Op, number> = { create: 18, title: 16, body: 16, move: 14, reorder: 10, trash: 8, undelete: 3, purge: 6, recreate: 5 };
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
  const bag = (Object.keys(weights) as Op[]).flatMap((op) => Array<Op>(weights[op]).fill(op));
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
        } else if (op === "recreate" && (purgedIds.get(peer) ?? []).length) {
          const id = rng.pick(purgedIds.get(peer)!);
          await peer.call("POST", "/api/nodes", { id, title: `${peer.name} again ${nextN(peer)}`, markdown: `again ${i}`, space_id: peer.space });
          purgedIds.set(peer, purgedIds.get(peer)!.filter((x) => x !== id));
          done.recreate++;
        }
      } catch { /* the route refused it (a cycle, a note that is not in the trash, a parent that is gone): part of the run */ }
    }
  });
  return done;
}

/** A bundle from `from` for `to`: what `to` holds is asked of `to`, the bundle is read on `from`, and goes through JSON as it would on the wire. */
export async function bundleFor(from: Peer, to: Peer, options: { pageBytes?: number } = {}): Promise<ChangeBundle> {
  const have = await onNode(to.node, () => readHave(to.ws));
  const pages = await onNode(from.node, () => readChangeBundle(from.owner, from.ws, have, options));
  return bundleOf(JSON.parse(JSON.stringify(pages)));
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
  const stamps = (await stampsOfWorkspace(p.node, p, await outOfScopeIds(p.node, p))).filter((s) => s.table_name === "content_nodes").map((s) => ({ ...s }));
  const heads = (await headsOfWorkspace(p.node, p)).filter((h) => h.table_name === "content_nodes");
  const conflicts = heads.map((h) => `${String(h.row_key)}/${String(h.field)}/${String(h.origin)}:${String(h.seq)}/${String(h.value)}`).sort();
  return { digest, stamps, heads, conflicts };
}

export async function expectSame(a: Peer, b: Peer, label = ""): Promise<{ a: Awaited<ReturnType<typeof peerStateOf>>; b: Awaited<ReturnType<typeof peerStateOf>> }> {
  const [sa, sb] = [await peerStateOf(a), await peerStateOf(b)];
  const diff = compareDigests(sa.digest, sb.digest);
  if (diff.length) throw new Error(`${label} ${a.name} and ${b.name} differ: ${JSON.stringify(diff)}`);
  if (JSON.stringify(sa.stamps) !== JSON.stringify(sb.stamps)) throw new Error(`${label} ${a.name} and ${b.name} hold different stamps`);
  if (JSON.stringify(sa.heads) !== JSON.stringify(sb.heads)) throw new Error(`${label} ${a.name} and ${b.name} hold different other heads`);
  return { a: sa, b: sb };
}

export { makeRng };
