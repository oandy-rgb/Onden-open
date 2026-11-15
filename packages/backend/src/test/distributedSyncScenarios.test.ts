// Distributed sync (beta): named situations, one assertion story each. The random bench is distributedSyncSimulator.test.ts.
// Cast (helpers/distSim/cluster.ts): S server (everyone), A alice, B bob, C carol, E eve (a stranger on a collaboration link).
// setupWorld: alice owns team (bob, carol edit; eve suggests) and priv (alice alone); bob owns bobs (carol views).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "./helpers/distSim/cluster.js";
import { RELIABLE } from "./helpers/distSim/network.js";
import { makeRng } from "./helpers/distSim/rng.js";
import { BOBS, PRIV, TEAM, setupWorld } from "./helpers/distSim/workload.js";
import { MAX_CLOCK_DRIFT } from "../distributedSync/node.js";
import type { Op } from "../distributedSync/types.js";

let c: Cluster;
beforeAll(() => { c = new Cluster("mesh"); });
afterAll(async () => { await c.close(); });
// No clock skew here: with skew, which side of a revocation an offline edit lands on depends on the device's clock (doc §4.4).
beforeEach(async () => { await c.start(makeRng(7), RELIABLE, { skew: false }); await setupWorld(c); }, 120_000);

const ok = async (p: Promise<{ ok: boolean; reason?: string }>) => { const r = await p; expect(r.reason ?? "ok").toBe("ok"); return r as { ok: true; op: Op }; };
const body = async (node: string, note: string) => (await c.node(node).world()).notes.get(note)?.body;
const holdsSpace = async (node: string, space: string) => (await c.node(node).ops()).some((o) => o.space === space);

describe("who receives what", () => {
  it("a private space never leaves its owner's devices and the server", async () => {
    expect(await holdsSpace("A", PRIV)).toBe(true);
    expect(await holdsSpace("S", PRIV)).toBe(true); // the server speaks for alice
    for (const n of ["B", "C", "E"]) expect(await holdsSpace(n, PRIV), n).toBe(false);
    expect((await c.node("B").world()).notes.has("priv-diary")).toBe(false);
  });

  it("a reader who only views gets the notes, and cannot change them", async () => {
    expect((await c.node("C").world()).notes.has("n-none")).toBe(false);
    expect(await holdsSpace("C", BOBS)).toBe(true);
    const refused = await c.node("C").submit("carol", BOBS, { kind: "note.create", note: "c-note", noteKind: "content", title: "x", body: "", parent: null });
    expect(refused).toEqual({ ok: false, reason: "cannot_edit" });
  });

  it("a stranger can read team notes and only suggest: the suggestion is recorded, the text is not touched", async () => {
    const before = await body("A", "team-home");
    expect(await body("E", "team-home")).toBe(before);
    expect(await c.node("E").submit("eve", TEAM, { kind: "note.body", note: "team-home", before: before!, after: "eve was here\n" })).toEqual({ ok: false, reason: "cannot_edit" });
    await ok(c.node("E").submit("eve", TEAM, { kind: "note.suggest", note: "team-home", text: "please fix line two" }));
    await c.quiesce();
    for (const n of ["A", "B", "S"]) {
      const note = (await c.node(n).world()).notes.get("team-home")!;
      expect(note.body, n).toBe(before);
      expect(note.suggestions.map((s) => [s.author, s.text]), n).toEqual([["eve", "please fix line two"]]);
    }
  });
});

describe("a modified client is refused everywhere, and refused edits go nowhere", () => {
  it("eve forces an edit into the log: every other node judges it invalid, and it travels no further than the first receiver", async () => {
    const before = await body("E", "team-home");
    const forged = await ok(c.node("E").submit("eve", TEAM, { kind: "note.body", note: "team-home", before: before!, after: "defaced\n" }, { unchecked: true }));
    await c.quiesce();
    for (const n of ["A", "B", "C", "S"]) {
      expect((await c.node(n).world()).notes.get("team-home")!.body, n).toBe(before);
      expect((await c.node(n).ops()).some((o) => o.id === forged.op.id), `${n} should not hold the forged op`).toBe(false);
    }
    // E still shows its own edit as refused too: its state does not apply it
    expect((await c.node("E").world()).verdicts.get(forged.op.id)).toEqual({ ok: false, reason: "cannot_edit" });
  });

  it("an op claiming an author the sending node does not speak for is refused and recorded", async () => {
    const real = await ok(c.node("E").submit("eve", TEAM, { kind: "note.suggest", note: "team-home", text: "hi" }));
    const forged: Op = { ...real.op, id: "E:99", seq: 99, author: "alice", body: { kind: "note.title", note: "team-home", title: "hijacked" } };
    const res = await c.node("A").ingest("E", [forged]);
    expect(res.rejected).toEqual([{ op: "E:99", reason: "author_not_of_origin" }]);
    expect((await c.node("A").world()).notes.get("team-home")!.title).toBe("Home");
    expect((await c.node("A").db.query("SELECT reason FROM ds_rejections WHERE op_id = 'E:99'")).length).toBe(1);
  });

  it("the same op id with different content is refused (equivocation)", async () => {
    const real = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "Bob title" }));
    await c.quiesce();
    const twisted: Op = { ...real.op, body: { kind: "note.title", note: "team-home", title: "Other" } };
    expect((await c.node("A").ingest("B", [twisted])).rejected).toEqual([{ op: real.op.id, reason: "equivocation" }]);
    expect((await c.node("A").world()).notes.get("team-home")!.title).toBe("Bob title");
  });

  it("a clock far in the future is refused rather than dragging everyone's order forward", async () => {
    const real = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "t" }));
    const future: Op = { ...real.op, id: "B:50", seq: 50, hlc: { wall: real.op.hlc.wall + MAX_CLOCK_DRIFT * 3, counter: 0 } };
    expect((await c.node("A").ingest("B", [future])).rejected).toEqual([{ op: "B:50", reason: "clock_too_far_ahead" }]);
  });

  it("ops of a space this node may not read are refused on arrival even if a peer pushes them", async () => {
    const diary = (await c.node("A").ops()).filter((o) => o.space === PRIV);
    const res = await c.node("B").ingest("A", diary);
    expect(res.added).toBe(0);
    expect(new Set(res.rejected.map((r) => r.reason))).toEqual(new Set(["space_not_readable_here"]));
    expect(await holdsSpace("B", PRIV)).toBe(false);
  });
});

describe("taking access away", () => {
  it("a revoked device learns it was revoked, then receives nothing new from the space", async () => {
    await ok(c.node("A").submit("alice", TEAM, { kind: "member.set", space: TEAM, actor: "bob", role: "none" }));
    await c.quiesce();
    expect((await c.node("B").world()).spaces.get(TEAM)!.members.has("bob")).toBe(false); // learned
    await ok(c.node("A").submit("alice", TEAM, { kind: "note.title", note: "team-home", title: "after revoke" }));
    await c.quiesce();
    expect((await c.node("B").world()).notes.get("team-home")!.title).toBe("Home"); // never sent
    expect((await c.node("C").world()).notes.get("team-home")!.title).toBe("after revoke");
    expect(await c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "nope" })).toEqual({ ok: false, reason: "cannot_edit" });
  });

  it("an edit made offline by someone revoked in the meantime is refused everywhere once both sides meet; edits before the revoke stand", async () => {
    await c.partition("B", "A", true); await c.partition("B", "S", true); await c.partition("B", "C", true); await c.partition("B", "E", true);
    c.advanceTime(50);
    const early = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "bob before" }));
    c.advanceTime(50);
    await ok(c.node("A").submit("alice", TEAM, { kind: "member.set", space: TEAM, actor: "bob", role: "none" }));
    c.advanceTime(50);
    const late = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "bob after" }));
    await c.quiesce(); // heals the partition
    const w = await c.node("C").world();
    expect(w.verdicts.get(late.op.id)).toEqual({ ok: false, reason: "cannot_edit" });
    expect(w.verdicts.get(early.op.id)).toEqual({ ok: true });
    expect(w.notes.get("team-home")!.title).toBe("bob before");
    expect((await c.node("B").world()).verdicts.get(late.op.id)).toEqual({ ok: false, reason: "cannot_edit" }); // and bob's own device agrees
  });

  it("only a space's owner can change who is in it", async () => {
    expect(await c.node("B").submit("bob", TEAM, { kind: "member.set", space: TEAM, actor: "eve", role: "edit" })).toEqual({ ok: false, reason: "not_owner" });
    await ok(c.node("B").submit("bob", TEAM, { kind: "member.set", space: TEAM, actor: "eve", role: "edit" }, { unchecked: true }));
    await c.quiesce();
    expect((await c.node("A").world()).spaces.get(TEAM)!.members.get("eve")).toBe("suggest");
  });
});

describe("merging", () => {
  it("two people edit different lines of the same note while apart: both edits are kept, in every node", async () => {
    await c.partition("B", "C", true);
    for (const n of ["A", "S", "E"]) { await c.partition("B", n, true); await c.partition("C", n, true); }
    const base = (await body("B", "team-home"))!;
    c.advanceTime(10);
    await ok(c.node("B").submit("bob", TEAM, { kind: "note.body", note: "team-home", before: base, after: base.replace("line one", "line one (bob)") }));
    c.advanceTime(10);
    await ok(c.node("C").submit("carol", TEAM, { kind: "note.body", note: "team-home", before: base, after: base.replace("line three", "line three (carol)") }));
    await c.quiesce();
    for (const n of ["A", "B", "C", "E", "S"]) expect(await body(n, "team-home"), n).toBe("line one (bob)\nline two\nline three (carol)\n");
  });

  it("two people change the same line: one text stays, the other is kept as a recorded conflict, same on every node", async () => {
    for (const n of ["A", "S", "E", "C"]) await c.partition("B", n, true);
    for (const n of ["A", "S", "E"]) await c.partition("C", n, true);
    const base = (await body("B", "team-home"))!;
    c.advanceTime(10);
    await ok(c.node("B").submit("bob", TEAM, { kind: "note.body", note: "team-home", before: base, after: base.replace("line two", "bob's two") }));
    c.advanceTime(10);
    await ok(c.node("C").submit("carol", TEAM, { kind: "note.body", note: "team-home", before: base, after: base.replace("line two", "carol's two") }));
    await c.quiesce();
    const texts = new Set<string>();
    for (const n of ["A", "B", "C", "E", "S"]) {
      const note = (await c.node(n).world()).notes.get("team-home")!;
      texts.add(note.body);
      expect(note.conflicts.length, n).toBe(1);
      expect(note.conflicts[0]!.kept + note.conflicts[0]!.lost, n).toContain("two");
    }
    expect(texts.size).toBe(1);
  });

  it("two moves that would make a loop: the first in the order lands, the second is refused as a cycle (its author's device keeps it as refused), same tree on every node", async () => {
    await ok(c.node("A").submit("alice", TEAM, { kind: "note.create", note: "p", noteKind: "content", title: "P", body: "", parent: null }));
    await ok(c.node("A").submit("alice", TEAM, { kind: "note.create", note: "q", noteKind: "content", title: "Q", body: "", parent: null }));
    await c.quiesce();
    for (const n of ["A", "S", "E", "C"]) await c.partition("B", n, true);
    for (const n of ["A", "S", "E"]) await c.partition("C", n, true);
    c.advanceTime(10);
    const m1 = await ok(c.node("B").submit("bob", TEAM, { kind: "note.move", note: "p", parent: "q" }));
    c.advanceTime(10);
    const m2 = await ok(c.node("C").submit("carol", TEAM, { kind: "note.move", note: "q", parent: "p" }));
    await c.quiesce();
    for (const n of ["A", "B", "C", "E", "S"]) {
      const w = await c.node(n).world();
      expect(w.verdicts.get(m1.op.id), n).toEqual({ ok: true });
      // A node that holds the refused move says why; the others never received it (an invalid op is not forwarded).
      const v = w.verdicts.get(m2.op.id);
      if (v) expect(v, n).toEqual({ ok: false, reason: "cycle" }); else expect(["A", "B", "E", "S"]).toContain(n);
      expect([w.notes.get("p")!.parent, w.notes.get("q")!.parent], n).toEqual(["q", null]);
    }
  });

  it("delete and a concurrent edit: the text is kept, and restore brings the edited note back", async () => {
    for (const n of ["A", "S", "E", "C"]) await c.partition("B", n, true);
    const base = (await body("B", "team-home"))!;
    c.advanceTime(10);
    await ok(c.node("B").submit("bob", TEAM, { kind: "note.body", note: "team-home", before: base, after: base + "bob's late line\n" }));
    c.advanceTime(10);
    await ok(c.node("A").submit("alice", TEAM, { kind: "note.delete", note: "team-home" }));
    await c.quiesce();
    for (const n of ["A", "B", "C", "S"]) { const note = (await c.node(n).world()).notes.get("team-home")!; expect(note.deleted, n).toBe(true); expect(note.body, n).toContain("bob's late line"); }
    await ok(c.node("C").submit("carol", TEAM, { kind: "note.restore", note: "team-home" }));
    await c.quiesce();
    for (const n of ["A", "B", "C", "S"]) { const note = (await c.node(n).world()).notes.get("team-home")!; expect(note.deleted, n).toBe(false); expect(note.history.length, n).toBeGreaterThan(3); }
  });
});

describe("a node that loses power", () => {
  it("keeps its sequence numbers and clock through a restart from disk, so nothing is reused or reordered", async () => {
    const first = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "one" }));
    await c.crash("B", true);
    const second = await ok(c.node("B").submit("bob", TEAM, { kind: "note.title", note: "team-home", title: "two" }));
    expect(second.op.seq).toBe(first.op.seq + 1);
    expect(second.op.hlc.wall * 1e6 + second.op.hlc.counter).toBeGreaterThan(first.op.hlc.wall * 1e6 + first.op.hlc.counter);
    await c.quiesce();
    expect((await c.node("S").world()).notes.get("team-home")!.title).toBe("two");
  });

  it("a batch that fails half way leaves nothing behind (one transaction)", async () => {
    const ops = (await c.node("A").ops()).filter((o) => o.space === TEAM);
    const fresh = await c.node("S").ingest("A", ops); // S already has them: all duplicates
    expect(fresh.added).toBe(0);
    await ok(c.node("A").submit("alice", TEAM, { kind: "note.title", note: "team-home", title: "late" }));
    const newOps = (await c.node("A").ops()).filter((o) => o.space === TEAM);
    const before = (await c.node("B").ops()).length;
    const last = newOps.slice(-1);
    await expect(c.node("B").ingest("A", last, { failAfterInsert: true })).rejects.toThrow("injected");
    expect((await c.node("B").ops()).length).toBe(before);
    expect((await c.node("B").db.query("SELECT count(*)::int AS n FROM ds_ops"))[0]).toEqual({ n: before });
    const again = await c.node("B").ingest("A", last); // the retry is not swallowed by a leftover success mark
    expect(again.added).toBe(1);
  });
});

describe("the op log cannot be rewritten", () => {
  it("refuses UPDATE and DELETE", async () => {
    await expect(c.node("A").db.query("UPDATE ds_ops SET author_actor = 'mallory'")).rejects.toThrow(/append-only/);
    await expect(c.node("A").db.query("DELETE FROM ds_ops")).rejects.toThrow(/append-only/);
  });
});
