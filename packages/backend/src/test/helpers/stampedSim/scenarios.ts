// Step lists. A uniform one, and one per cross-row rule built to make exactly that conflict happen as often as it can:
// small pools of names, ids and parents, nodes that work a long time without hearing from each other, then meet.
import type { Rng } from "../distSim/rng.js";
import type { OpKind, Step } from "./domain.js";

type Mix = ReadonlyArray<readonly [OpKind, number]>;
export type Scenario = { name: string; nodes: number; mix: Mix; /** how many ops a node makes before the network gets a turn */ burst: number; /** share of turns that deliver anything at all */ meet: number; seedNotes?: number; /** every node starts with its own value for a few rows from before stamps existed */ genesis?: boolean; authors?: string[] };

const pickKind = (rng: Rng, mix: Mix): OpKind => { const total = mix.reduce((a, [, w]) => a + w, 0); let r = rng.next() * total; for (const [k, w] of mix) { if ((r -= w) < 0) return k; } return mix[0]![0]; };

export function generateStampedSteps(rng: Rng, sc: Scenario, count: number): Step[] {
  const steps: Step[] = [];
  if (sc.genesis) for (let node = 0; node < sc.nodes; node++) for (const g of [0, 0.5]) steps.push({ t: "op", node, kind: "note.genesis", p: [g, rng.next(), 0] });
  // Every node has the same few notes before it goes off alone: the base the conflicts are about.
  for (let i = 0; i < (sc.seedNotes ?? 0); i++) steps.push({ t: "op", node: 0, kind: "note.derived", p: [i / Math.max(1, sc.seedNotes ?? 1), 0, 0] });
  if (sc.seedNotes) steps.push({ t: "deliver", n: 9999 });
  while (steps.length < count) {
    const node = rng.int(sc.nodes);
    for (let i = 0, k = 1 + rng.int(sc.burst); i < k; i++) steps.push({ t: "op", node, kind: pickKind(rng, sc.mix), p: [rng.next(), rng.next(), rng.next()] });
    const turn = rng.next();
    if (turn < sc.meet * 0.5) steps.push({ t: "deliver", n: 1 + rng.int(8) });
    else if (turn < sc.meet) { const a = rng.int(sc.nodes); steps.push({ t: "gossip", a, b: (a + 1 + rng.int(sc.nodes - 1)) % sc.nodes }); }
    else if (turn < sc.meet + 0.1) steps.push({ t: "tick", ms: 1 + rng.int(4000) });
  }
  return steps;
}

export const UNIFORM: Scenario = {
  name: "uniform", nodes: 4, burst: 4, meet: 0.5, seedNotes: 3,
  mix: [["note.new", 5], ["note.derived", 2], ["note.system", 1], ["note.title", 6], ["note.body", 8], ["note.move", 5], ["note.trash", 3], ["note.restore", 2], ["note.purge", 1], ["note.slug", 2], ["note.publish", 1],
    ["tag.new", 3], ["tag.rename", 3], ["tag.trash", 1], ["view.new", 2], ["view.rename", 2], ["focus.start", 2], ["focus.end", 2], ["ref.new", 2], ["ref.config", 4]],
};
/** One scenario per rule of the proposal's §4 that is a function over merged rows (rules/). */
export const ADVERSARIAL: Scenario[] = [
  { name: "4.2 same-name tags", nodes: 4, burst: 5, meet: 0.12, mix: [["tag.new", 6], ["tag.rename", 5], ["tag.trash", 1]] },
  { name: "4.3 same slug", nodes: 4, burst: 4, meet: 0.12, seedNotes: 4, mix: [["note.slug", 8], ["note.publish", 4], ["note.new", 2]] },
  { name: "4.4 two running focus sessions", nodes: 4, burst: 3, meet: 0.1, mix: [["focus.start", 6], ["focus.end", 1]] },
  { name: "4.8 same-name views", nodes: 3, burst: 5, meet: 0.12, mix: [["view.new", 5], ["view.rename", 6]] },
  { name: "4.9a delete vs edit", nodes: 4, burst: 4, meet: 0.1, seedNotes: 4, authors: ["u0", "u1", "u0", "u2"], mix: [["note.title", 6], ["note.body", 6], ["note.trash", 3], ["note.restore", 1]] },
  { name: "4.9b created under a deleted parent", nodes: 4, burst: 4, meet: 0.1, seedNotes: 3, authors: ["u0", "u1", "u0", "u2"], mix: [["note.new", 6], ["note.move", 3], ["note.trash", 3]] },
  { name: "4.9c purge vs late edit", nodes: 4, burst: 4, meet: 0.1, seedNotes: 3, authors: ["u0", "u1", "u0", "u2"], mix: [["note.title", 5], ["note.body", 5], ["note.purge", 2]] },
  { name: "4.10 move cycles", nodes: 4, burst: 5, meet: 0.1, seedNotes: 5, mix: [["note.move", 10], ["note.new", 1]] },
  { name: "4.12 body on both sides", nodes: 3, burst: 4, meet: 0.1, seedNotes: 2, mix: [["note.body", 10], ["note.title", 1]] },
  { name: "4.5 derived ids made twice", nodes: 4, burst: 3, meet: 0.1, mix: [["note.derived", 6], ["note.title", 3]] },
  { name: "row made again over a row that is there (purged, or only partly held)", nodes: 4, burst: 4, meet: 0.1, mix: [["note.derived", 5], ["note.title", 4], ["note.purge", 2], ["note.body", 2]] },
  { name: "genesis values that differ", nodes: 4, burst: 3, meet: 0.1, genesis: true, mix: [["note.title", 2], ["note.new", 6], ["note.system", 1]] },
  { name: "system writes beside a conflict", nodes: 4, burst: 4, meet: 0.1, seedNotes: 2, mix: [["note.title", 5], ["note.system", 5]] },
  { name: "function_refs made twice", nodes: 4, burst: 5, meet: 0.12, mix: [["ref.new", 5], ["ref.config", 8]] },
  { name: "4.11 same field both sides", nodes: 4, burst: 4, meet: 0.1, seedNotes: 2, mix: [["note.title", 10], ["note.slug", 3]] },
];
