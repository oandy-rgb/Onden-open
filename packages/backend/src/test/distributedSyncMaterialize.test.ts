// Distributed sync (beta): the pure core. No database, no network: state is a function of the SET of ops.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareOps, receive, tick } from "../distributedSync/hlc.js";
import { materialize, spaceDigest, type World } from "../distributedSync/materialize.js";
import type { Op, OpBody } from "../distributedSync/types.js";
import { makeRng } from "./helpers/distSim/rng.js";

describe("hybrid logical clock", () => {
  it("a local event is after the previous one even when the wall clock stood still or went back", () => {
    const a = tick({ wall: 100, counter: 0 }, 100), b = tick(a, 90);
    expect(a).toEqual({ wall: 100, counter: 1 });
    expect(b).toEqual({ wall: 100, counter: 2 });
    expect(tick(b, 150)).toEqual({ wall: 150, counter: 0 });
  });
  it("after receiving a reading from the future, local events sort after it", () => {
    const remote = { wall: 500, counter: 3 };
    const next = tick(receive({ wall: 100, counter: 0 }, remote, 110), 111);
    expect(compareOps({ hlc: next, origin: "a", seq: 1 }, { hlc: remote, origin: "b", seq: 1 })).toBeGreaterThan(0);
  });
  it("ties on the reading break by origin then sequence, the same on every node", () => {
    const x = { hlc: { wall: 1, counter: 0 }, origin: "a", seq: 2 }, y = { hlc: { wall: 1, counter: 0 }, origin: "b", seq: 1 };
    expect(compareOps(x, y)).toBeLessThan(0);
    expect(compareOps(y, x)).toBeGreaterThan(0);
  });
});

/** A random but legal-looking history by three actors (one of them a stranger) over two spaces, to permute. */
function randomOps(seed: number, count: number): Op[] {
  const rng = makeRng(seed);
  const actors = ["alice", "bob", "eve"];
  const spaces = ["s1", "s2"];
  const ops: Op[] = [];
  const seqOf: Record<string, number> = {};
  let wall = 1000;
  const push = (author: string, space: string, body: OpBody) => {
    const origin = `n-${author}`;
    seqOf[origin] = (seqOf[origin] ?? 0) + 1;
    wall += rng.int(3); // equal walls happen: ties are broken by origin and seq
    ops.push({ id: `${origin}:${seqOf[origin]}`, origin, seq: seqOf[origin]!, hlc: { wall, counter: rng.int(2) }, author, space, body });
  };
  push("alice", "s1", { kind: "space.create", space: "s1", name: "one" });
  push("bob", "s2", { kind: "space.create", space: "s2", name: "two" });
  push("alice", "s1", { kind: "member.set", space: "s1", actor: "bob", role: "edit" });
  push("alice", "s1", { kind: "member.set", space: "s1", actor: "eve", role: "suggest" });
  const live = (): Array<[string, string]> => ops.filter((o) => o.body.kind === "note.create").map((o) => [(o.body as { note: string }).note, o.space]);
  for (let i = 0; i < count; i++) {
    const author = rng.pick(actors), space = rng.pick(spaces);
    const notes = live().filter(([, sp]) => sp === space);
    const [note] = notes.length ? rng.pick(notes) : [undefined];
    const r = rng.int(11);
    if (r < 3 || !note) push(author, space, { kind: "note.create", note: `x${i}`, noteKind: rng.chance(0.2) ? "tag" : "content", title: `t${i}`, body: "a\nb\nc\n", parent: notes.length && rng.chance(0.3) ? rng.pick(notes)[0] : null });
    else if (r === 3) push(author, space, { kind: "note.body", note, before: "a\nb\nc\n", after: rng.pick(["a\nB\nc\n", "a\nb\nc\nd\n", "z\nb\nc\n", "a\nb\n"]) });
    else if (r === 4) push(author, space, { kind: "note.title", note, title: `T${i}` });
    else if (r === 5) push(author, space, { kind: "note.move", note, parent: rng.chance(0.2) ? null : rng.pick(notes)[0] });
    else if (r === 6) push(author, space, { kind: "note.delete", note });
    else if (r === 7) push(author, space, { kind: "note.restore", note });
    else if (r === 8) push(author, space, { kind: "note.suggest", note, text: `s${i}` });
    else if (r === 9) push(author, space, { kind: "note.tag", note, tag: rng.pick(notes)[0], on: rng.chance(0.7) });
    else push(author, space, { kind: "member.set", space, actor: rng.pick(actors), role: rng.pick(["none", "view", "suggest", "edit"] as const) });
  }
  return ops;
}

const shuffle = <T>(xs: T[], seed: number): T[] => { const rng = makeRng(seed), a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const digestOf = (w: World): string => ["s1", "s2"].map((s) => spaceDigest(w, s)).join("|") + JSON.stringify([...w.verdicts].sort());

describe("materialize: the same set of ops is the same state, whatever the order and however often delivered", () => {
  it("order independence and idempotence over random histories (400 cases)", () => {
    let valid = 0, invalid = 0;
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 5, max: 70 }), (seed, n) => {
      const ops = randomOps(seed, n);
      const want = digestOf(materialize(ops));
      for (const w of [shuffle(ops, seed + 1), shuffle(ops, seed + 2).reverse(), [...shuffle(ops, seed + 3), ...ops.slice(0, 5)].filter((o, i, a) => a.findIndex((p) => p.id === o.id) === i)]) {
        expect(digestOf(materialize(w))).toBe(want);
      }
      const verdicts = [...materialize(ops).verdicts.values()];
      valid += verdicts.filter((v) => v.ok).length; invalid += verdicts.filter((v) => !v.ok).length;
    }), { numRuns: 400 });
    expect(valid).toBeGreaterThan(1000);
    expect(invalid).toBeGreaterThan(100); // the permissions are really being exercised, not vacuously satisfied
  });

  it("an invalid op changes nothing: removing it from the set leaves the state as it was", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
      const ops = randomOps(seed, 40);
      const w = materialize(ops);
      const withoutInvalid = ops.filter((o) => w.verdicts.get(o.id)?.ok);
      const states = (x: World) => ["s1", "s2"].map((sp) => spaceDigest(x, sp)).join("|");
      expect(states(materialize(withoutInvalid))).toBe(states(w));
    }), { numRuns: 150 });
  });
});
