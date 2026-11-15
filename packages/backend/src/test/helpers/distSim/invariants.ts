// What must hold once the network is quiet. Each check returns human-readable failures (empty = holds).
import { canRead, materialize, spaceDigest } from "../../../distributedSync/materialize.js";
import type { World } from "../../../distributedSync/materialize.js";
import type { Op, OpId } from "../../../distributedSync/types.js";
import { DIRECTORY, type Cluster } from "./cluster.js";

export type Report = { failures: string[]; truth: World; digests: Record<string, Record<string, string>>; opCount: number; validCount: number; byKind: Record<string, number>; invalid: Record<string, number>; conflicts: number };

const unionOps = async (c: Cluster): Promise<Op[]> => {
  const byId = new Map<OpId, Op>();
  for (const id of Object.keys(DIRECTORY)) for (const op of await c.node(id).ops()) byId.set(op.id, op);
  return [...byId.values()];
};

export async function checkDistributedInvariants(c: Cluster, localOk: Set<OpId>): Promise<Report> {
  const failures: string[] = [];
  const all = await unionOps(c);
  const truth = materialize(all);
  const nodes = Object.keys(DIRECTORY);
  const spaces = [...truth.spaces.keys()];
  const worlds = new Map(await Promise.all(nodes.map(async (id) => [id, await c.node(id).world()] as const)));
  const digests: Record<string, Record<string, string>> = {};

  for (const space of spaces) {
    const readers = nodes.filter((id) => DIRECTORY[id]!.some((a) => canRead(truth, space, a)));
    const want = spaceDigest(truth, space);
    for (const id of readers) {
      const got = spaceDigest(worlds.get(id)!, space);
      (digests[id] ??= {})[space] = got;
      // (a) every node that may read the space ends with exactly the state the whole op set gives
      if (got !== want) failures.push(`(a) ${id} differs from the truth in space ${space}`);
    }
    // (b) nothing that was accepted is lost: every valid op on a note is in that note's history at every reader
    const validHere = all.filter((o) => o.space === space && truth.verdicts.get(o.id)?.ok);
    for (const id of readers) {
      const have = new Set((await c.node(id).ops()).map((o) => o.id));
      for (const op of validHere) if (!have.has(op.id)) failures.push(`(b) ${id} is missing valid op ${op.id} (${op.body.kind}) of space ${space}`);
      const w = worlds.get(id)!;
      for (const op of validHere) {
        const note = "note" in op.body ? w.notes.get(op.body.note) : undefined;
        if (note && !note.history.includes(op.id)) failures.push(`(b) ${id}: op ${op.id} is not in the history of note ${note.id}`);
      }
    }
  }
  // (b) a locally accepted op that stayed valid is on every node that may read its space (checked above) and on its origin
  for (const id of localOk) {
    const op = all.find((o) => o.id === id);
    if (!op) { failures.push(`(b) accepted op ${id} exists nowhere`); continue; }
    const origin = await c.node(op.origin).ops();
    if (!origin.some((o) => o.id === id)) failures.push(`(b) accepted op ${id} vanished from its origin ${op.origin}`);
  }

  // (c) history complete: every node's own ops are 1..n with no gap, and everything held has a verdict
  for (const id of nodes) {
    const ops = await c.node(id).ops();
    const own = ops.filter((o) => o.origin === id).map((o) => o.seq).sort((x, y) => x - y);
    own.forEach((seq, i) => { if (seq !== i + 1) failures.push(`(c) ${id}'s own op sequence has a gap near ${seq}`); });
    for (const op of ops) if (!worlds.get(id)!.verdicts.has(op.id)) failures.push(`(c) ${id} holds ${op.id} with no verdict`);
    // The op log refuses rewriting
    try { await c.node(id).db.query("DELETE FROM ds_ops WHERE op_id = $1", [ops[0]?.id ?? "x"]); if (ops.length) failures.push(`(c) ${id}: ds_ops allowed a delete`); } catch { /* expected */ }
  }

  // (d) permission: a node holds ops of a space only if one of its actors was granted read there at some point
  for (const id of nodes) {
    for (const op of await c.node(id).ops()) {
      if (op.origin === id) continue; // what a node wrote itself (even a forged op of a modified client) is its own business; (d) is about what it RECEIVED
      const everReader = DIRECTORY[id]!.some((a) => {
        if (truth.spaces.get(op.space)?.owner === a) return true;
        return all.some((g) => g.space === op.space && g.body.kind === "member.set" && g.body.actor === a && g.body.role !== "none" && truth.verdicts.get(g.id)?.ok);
      });
      if (!everReader && !(op.body.kind === "member.set" && DIRECTORY[id]!.includes(op.body.actor))) failures.push(`(d) ${id} holds ${op.id} of space ${op.space}, which none of its actors was ever allowed to read`);
    }
  }
  // (d) an op judged invalid anywhere is applied nowhere: it is not in any other node's valid set
  // Only for nodes that may still read the op's space: a revoked device is frozen at the moment it was revoked (it never hears
  // about later changes to other people's access), so its verdicts for what came after are stale by design (doc §5, seed 44).
  for (const id of nodes) {
    const w = worlds.get(id)!;
    const op2space = new Map(all.map((o) => [o.id, o.space] as const));
    for (const [opId, v] of w.verdicts) {
      if (!DIRECTORY[id]!.some((a) => canRead(truth, op2space.get(opId) ?? "", a))) continue;
      if (!v.ok && truth.verdicts.get(opId)?.ok) failures.push(`(d) ${id} judges ${opId} invalid (${v.reason}) but the whole op set judges it valid`);
      if (v.ok && !truth.verdicts.get(opId)?.ok) failures.push(`(d) ${id} applies ${opId} which the whole op set refuses`);
    }
  }
  const byKind: Record<string, number> = {}, invalid: Record<string, number> = {};
  for (const op of all) {
    const v = truth.verdicts.get(op.id)!;
    if (v.ok) byKind[op.body.kind] = (byKind[op.body.kind] ?? 0) + 1; else invalid[v.reason] = (invalid[v.reason] ?? 0) + 1;
  }
  const conflicts = [...truth.notes.values()].reduce((n, x) => n + x.conflicts.length, 0);
  return { failures, truth, digests, opCount: all.length, validCount: [...truth.verdicts.values()].filter((v) => v.ok).length, byKind, invalid, conflicts };
}

/** (e) two runs of the same plan on different topologies end in the same state at every node, space by space. */
export function compareTopologies(star: Record<string, Record<string, string>>, mesh: Record<string, Record<string, string>>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(star), ...Object.keys(mesh)]);
  for (const id of keys) {
    const spaces = new Set([...Object.keys(star[id] ?? {}), ...Object.keys(mesh[id] ?? {})]);
    for (const s of spaces) if (star[id]?.[s] !== mesh[id]?.[s]) out.push(`(e) ${id} differs between star and mesh in space ${s}`);
  }
  return out;
}
