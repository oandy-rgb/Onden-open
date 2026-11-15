// A run is DATA: a list of steps with every random choice already drawn (as a 0..1 float), so a step list can be
// replayed and cut down (shrink.ts) without the generator being in the loop.
import type { Note, World } from "../../../distributedSync/materialize.js";
import { canRead, roleIn } from "../../../distributedSync/materialize.js";
import type { NodeId, OpBody, Role, SpaceId } from "../../../distributedSync/types.js";
import { DEVICES, DIRECTORY, HUB, type Cluster } from "./cluster.js";
import type { Rng } from "./rng.js";

export const TEAM = "space-team", PRIV = "space-priv", BOBS = "space-bobs";
export type LocalKind = "create" | "tag_create" | "body" | "title" | "tag" | "move" | "delete" | "restore" | "suggest" | "member";

export type Step =
  | { t: "op"; node: NodeId; actor: number; kind: LocalKind; p: [number, number, number]; unchecked?: boolean }
  | { t: "gossip"; a: NodeId; b: NodeId }
  | { t: "deliver"; n: number }
  | { t: "partition"; a: NodeId; b: NodeId; on: boolean }
  | { t: "crash"; node: NodeId; heavy: boolean }
  | { t: "tick"; ms: number }
  | { t: "faulty_ingest"; n: number };

/** The cast and spaces every run starts from: alice owns team (bob, carol edit; eve suggests) and priv (nobody else);
 *  bob owns bobs (carol views). Built through the engine like everything else, then fully synced. */
export async function setupWorld(c: Cluster): Promise<void> {
  const A = c.node("A"), B = c.node("B");
  const must = async (p: Promise<{ ok: boolean; reason?: string }>) => { const r = await p; if (!r.ok) throw new Error(`setup op refused: ${r.reason}`); };
  await must(A.submit("alice", TEAM, { kind: "space.create", space: TEAM, name: "team" }));
  await must(A.submit("alice", PRIV, { kind: "space.create", space: PRIV, name: "priv" }));
  await must(B.submit("bob", BOBS, { kind: "space.create", space: BOBS, name: "bobs" }));
  for (const [actor, role] of [["bob", "edit"], ["carol", "edit"], ["eve", "suggest"]] as const) {
    await must(A.submit("alice", TEAM, { kind: "member.set", space: TEAM, actor, role }));
  }
  await must(B.submit("bob", BOBS, { kind: "member.set", space: BOBS, actor: "carol", role: "view" }));
  await must(A.submit("alice", TEAM, { kind: "note.create", note: "team-home", noteKind: "content", title: "Home", body: "line one\nline two\nline three\n", parent: null }));
  await must(A.submit("alice", TEAM, { kind: "note.create", note: "team-tag", noteKind: "tag", title: "todo", body: "", parent: null }));
  await must(A.submit("alice", PRIV, { kind: "note.create", note: "priv-diary", noteKind: "content", title: "Diary", body: "secret\n", parent: null }));
  await c.quiesce();
}

export function generateSteps(rng: Rng, count: number): Step[] {
  const kinds: Array<[LocalKind, number]> = [["create", 18], ["body", 26], ["title", 7], ["tag", 8], ["tag_create", 3], ["move", 10], ["delete", 6], ["restore", 4], ["suggest", 6], ["member", 6]];
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  const steps: Step[] = [];
  const pickKind = (): LocalKind => { let r = rng.next() * total; for (const [k, w] of kinds) { if ((r -= w) < 0) return k; } return "body"; };
  for (let i = 0; i < count; i++) {
    const r = rng.next();
    if (r < 0.55) steps.push({ t: "op", node: rng.pick(DEVICES), actor: rng.int(1000), kind: pickKind(), p: [rng.next(), rng.next(), rng.next()], ...(rng.chance(0.04) ? { unchecked: true } : {}) });
    else if (r < 0.78) { const ids = [HUB, ...DEVICES]; const a = rng.pick(ids); steps.push({ t: "gossip", a, b: rng.pick(ids.filter((x) => x !== a)) }); }
    else if (r < 0.9) steps.push({ t: "deliver", n: 1 + rng.int(6) });
    else if (r < 0.94) { const ids = [HUB, ...DEVICES]; const a = rng.pick(ids); steps.push({ t: "partition", a, b: rng.pick(ids.filter((x) => x !== a)), on: rng.chance(0.6) }); }
    else if (r < 0.965) steps.push({ t: "crash", node: rng.pick([HUB, ...DEVICES]), heavy: rng.chance(0.15) });
    else if (r < 0.98) steps.push({ t: "faulty_ingest", n: 1 });
    else steps.push({ t: "tick", ms: 1 + rng.int(3000) });
  }
  return steps;
}

const at = <T>(xs: readonly T[], f: number): T | undefined => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
const lineEdit = (before: string, p: number, q: number, tag: string): string => {
  const lines = before.split("\n");
  const i = Math.min(lines.length - 1, Math.floor(p * lines.length));
  if (q < 0.4) { lines.splice(i, 0, `added ${tag}`); }
  else if (q < 0.75) { lines[i] = `${lines[i]} +${tag}`; }
  else if (lines.length > 2) lines.splice(i, 1);
  else lines.push(`tail ${tag}`);
  return lines.join("\n");
};

/** The effect of one step on the cluster. Returns what happened, for the run report. */
export async function runStep(c: Cluster, step: Step, ordinal: number): Promise<string> {
  switch (step.t) {
    case "gossip": await c.gossip(step.a, step.b); return "gossip";
    case "deliver": await c.deliver(step.n); return "deliver";
    case "partition": await c.partition(step.a, step.b, step.on); return "partition";
    case "crash": await c.crash(step.node, step.heavy); return "crash";
    case "tick": c.advanceTime(step.ms); return "tick";
    case "faulty_ingest": await c.deliverOne({ failIngestAfterInsert: true }); return "faulty_ingest";
    case "op": {
      c.advanceTime(3);
      const node = c.node(step.node);
      const actors = DIRECTORY[step.node]!;
      const actor = actors[step.actor % actors.length]!;
      const world = await node.world();
      const planned = plan(world, actor, step, ordinal);
      if (!planned) return "skipped";
      const r = await node.submit(actor, planned.space, planned.body, { unchecked: step.unchecked });
      return r.ok ? (step.unchecked && !(await node.world()).verdicts.get(r.op.id)?.ok ? "unchecked_invalid" : "applied") : "refused_locally";
    }
  }
}

/** Turn the drawn floats into a concrete op against what this node can currently see. */
function plan(world: World, actor: string, s: Extract<Step, { t: "op" }>, n: number): { space: SpaceId; body: OpBody } | null {
  const [p, q, r] = s.p;
  const allSpaces = [TEAM, PRIV, BOBS];
  const readable = allSpaces.filter((sp) => canRead(world, sp, actor));
  // Mostly act where the actor can read; sometimes name any space (a stranger trying: refused locally, or sent unchecked).
  // A modified or stale client (`unchecked`) acts exactly where it may not: a space it cannot edit.
  const cannotEdit = allSpaces.filter((sp) => roleIn(world, sp, actor) !== "edit");
  const owned = allSpaces.filter((sp) => world.spaces.get(sp)?.owner === actor);
  const space = (s.unchecked && cannotEdit.length ? at(cannotEdit, p)
    : s.kind === "member" && owned.length ? at(owned, p)
    : q < 0.05 || readable.length === 0 ? at(allSpaces, p) : at(readable, p))!;
  const notes = [...world.notes.values()].filter((x) => x.space === space).sort((a, b) => (a.id < b.id ? -1 : 1));
  const contents = notes.filter((x) => x.kind === "content");
  const tags = notes.filter((x) => x.kind === "tag");
  const tag = `${s.node}${n}`;
  const note: Note | undefined = at(contents, p);
  switch (s.kind) {
    case "create": return { space, body: { kind: "note.create", note: `n-${s.node}-${n}`, noteKind: "content", title: `Note ${tag}`, body: `first ${tag}\nsecond\n`, parent: r < 0.4 ? at(contents, q)?.id ?? null : null } };
    case "tag_create": return { space, body: { kind: "note.create", note: `t-${s.node}-${n}`, noteKind: "tag", title: `tag ${tag}`, body: "", parent: null } };
    case "body": return note ? { space, body: { kind: "note.body", note: note.id, before: note.body, after: lineEdit(note.body, q, r, tag) } } : null;
    case "title": return note ? { space, body: { kind: "note.title", note: note.id, title: `${note.title.split(" ~")[0]} ~${tag}` } } : null;
    case "tag": { const t = at(tags, q); return note && t ? { space, body: { kind: "note.tag", note: note.id, tag: t.id, on: r < 0.7 } } : null; }
    case "move": { const parent = r < 0.25 ? null : at(contents, q)?.id ?? null; return note ? { space, body: { kind: "note.move", note: note.id, parent } } : null; }
    case "delete": return note ? { space, body: { kind: "note.delete", note: note.id } } : null;
    case "restore": { const gone = at(contents.filter((x) => x.deleted), p); return gone ? { space, body: { kind: "note.restore", note: gone.id } } : null; }
    case "suggest": return note ? { space, body: { kind: "note.suggest", note: note.id, text: `suggest ${tag}` } } : null;
    case "member": {
      // Owners churn their space's membership. A non-owner trying is refused locally (or sent unchecked and refused everywhere).
      const target = at(["bob", "carol", "eve", "alice"], q)!;
      const role: Role = at(["edit", "view", "suggest", "none", "edit"] as Role[], r)!;
      return { space, body: { kind: "member.set", space, actor: target, role } };
    }
  }
}
