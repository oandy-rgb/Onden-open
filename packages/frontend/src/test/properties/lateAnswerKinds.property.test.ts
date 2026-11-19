// A late sync answer must not undo what this device already had acknowledged — for EVERY kind of row an answer
// carries, not only the note text (saveTiming.property.test.ts covers the note's text and title).
//
// The report (owner, 2026-11-16): an answer the device asked for BEFORE its save was acknowledged arrived AFTER the
// acknowledgement and replaced the saved text with the older one. The first guard (PR #1753) compared the server's
// `updated_at` on node rows only; it is gone. The rule now is by position (lib/answerPositions.ts): every kind below —
// per-key attributes, edges (`upsert` / `delete` / `replace_for`), pointers, canvas memberships, note anchors, link
// bindings (all `replace_for`), the tag catalog (a complete list), tasks, the site config, node deletes and node upserts
// of a note that was deleted since — is kept as acknowledged when an answer older than the write arrives.
//
// The world: a model server (rows by kind, one event counter), and a device = the app's REAL two doors, in the order
// syncEngine uses them: the worker's `applySync` (a real sql.js worker, read back with `loadBootstrap`) and then
// the store's `applySyncDelta` on what the worker answered. This device is the only writer, so after ANY answer has
// been delivered, the device (store and local copy) must equal the server: a stale answer must change nothing.
// The device's own change is acknowledged by taking the server's answer that covers it (`own`): the one place to
// register the acknowledgement's event position when the fix (a rule by `head_event_id` against the acknowledgement's
// `event_id`, per target) records it.
//
// Commands: change(kind) — this device changes something, the server applies it, the device takes the acknowledgement;
// asks — an answer is computed now and not delivered; arrives(i) — a captured answer is delivered now.
// Invariant L: after every delivery, store and local copy equal the server in every kind they hold.
//
// Named cases: one fixed minimal case per kind (`late answer: <kind> <what is undone>`), plain tests. The device takes
// every answer through the app's one door (lib/data/writePositions.ts takeAnswer: the page's watermark, then the real
// worker's applySync, then the page again before the store), and an acknowledgement raises the page's watermark at once
// and the worker's by a message — which, with the worker BUSY, lands after the answer it is applying (`arrivesBusy`).
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/lateAnswerKinds.property.test.ts

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { applySyncDelta } from "../../lib/data/storeOps";
import { noWorkspaceData, type Bootstrap } from "../../lib/api";
import type { AppliedSyncDelta } from "../../lib/localDb";
import { forgetWatermark, takeAnswer, type AnswerOutcome } from "../../lib/data/writePositions";
import { EVENT_POSITION_HEADER } from "@onden/markdown/contract";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { openWorker, rpc } from "../helpers/localDbWorkerHarness";
import { metamorphic, SKIP } from "../../../../markdown/src/test/helpers/metamorphic.js";

vi.mock("../../lib/indexedDbStorage", () => ({ idbLoad: async () => null, idbSave: async () => {}, idbIsStale: async () => false }));
// The page's door talks to the copy through lib/localDb; here that is the in-process worker (localDbWorkerHarness).
vi.mock("../../lib/localDb", async () => {
  const { rpc: send } = await import("../helpers/localDbWorkerHarness");
  return { raiseWatermark: (position: string) => send("raiseWatermark", position), rewindCursor: (to: string) => send("rewindCursor", to) };
});
// lib/data/writePositions installs its response recorder in lib/api; the device hands it each acknowledgement.
const responses = vi.hoisted(() => ({ listener: null as null | ((path: string, init: RequestInit | undefined, response: Response) => void) }));
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  setWriteResponseListener: (listener: typeof responses.listener) => { responses.listener = listener; },
}));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

// ── the model server ─────────────────────────────────────────────────────────

type Note = { title: string; markdown: string; labels: string[]; at: number };
type Task = { status: "todo" | "done" };
type State = {
  head: number;
  /** The server's identity (sync_node): a restore that takes a new id changes it. */
  serverId: string;
  notes: Map<string, Note>;
  /** Notes deleted (their id is shipped in nodes.delete by an answer computed afterwards). */
  gone: Set<string>;
  attrs: Map<string, string>; // "node|key" → value
  /** Attributes and tasks removed: an answer computed afterwards names them in its `delete`. */
  goneAttrs: Set<string>;
  goneTasks: Set<string>;
  edges: Map<string, { source: string; target: string }>;
  pointers: Map<string, { parent: string | null; target: string }>;
  memberships: Set<string>; // "canvas|node"
  anchors: Set<string>; // "note|anchor"
  bindings: Set<string>; // "note|link|anchor"
  tags: Set<string>;
  tasks: Map<string, Task>;
  siteVersion: number;
};
const NOTES = ["n1", "n2", "n3"];
const iso = (at: number) => new Date(Date.UTC(2026, 0, 1) + at * 1000).toISOString();

function initial(): State {
  return {
    head: 1, serverId: "server-1",
    notes: new Map(NOTES.map((id, i) => [id, { title: id, markdown: "m0", labels: [], at: i + 1 }])),
    gone: new Set(), attrs: new Map([["n1|status", "open"]]), goneAttrs: new Set(), goneTasks: new Set(),
    edges: new Map([["e0", { source: "n1", target: "n2" }]]),
    pointers: new Map([["p0", { parent: "n1", target: "n2" }]]),
    memberships: new Set(["cv1|n1"]), anchors: new Set(["n1|a0"]), bindings: new Set(["n1|[[x]]|a0"]),
    tags: new Set(["tag0"]), tasks: new Map([["tk0", { status: "todo" }]]), siteVersion: 0,
  };
}

const noteRow = (id: string, n: Note) => ({
  id, source_type: "manual", node_type: "content", title: n.title, slug: id, markdown: n.markdown, parent_id: null, hidden: false,
  order_key: "a0", label_tag_ids: n.labels, class_tag_ids: [], updated_at: iso(n.at),
});

/** What the server answers at this moment: every kind complete, as the answer of a device that holds nothing of them. */
function answerOf(s: State) {
  const live = NOTES.filter((id) => !s.gone.has(id));
  return {
    last_event_id: s.head, head_event_id: String(s.head), server_id: s.serverId,
    nodes: { upsert: live.map((id) => noteRow(id, s.notes.get(id)!)), delete: [...s.gone] },
    attributes: { upsert: [...s.attrs].map(([k, value]) => { const [node_id, key] = k.split("|"); return { node_id, key, value, value_type: "text", is_inheritable: false, source: "ui" }; }), delete: [...s.goneAttrs].filter((k) => !s.attrs.has(k)).map((k) => { const [node_id, key] = k.split("|"); return { node_id: node_id!, key: key! }; }) },
    edges: { upsert: [...s.edges].map(([id, e]) => ({ id, source_node_id: e.source, target_node_id: e.target, edge_type: "knowledge_link", status: "active" })), delete: [], replace_for: NOTES },
    pointers: { upsert: [...s.pointers].map(([id, p]) => ({ id, parent_id: p.parent, target_id: p.target, order_key: "a0", display_prefix: null })), delete: [], replace_for: NOTES },
    canvas_memberships: { upsert: [...s.memberships].map((m) => { const [canvas_id, node_id] = m.split("|"); return { canvas_id, canvas_title: canvas_id, node_id }; }), replace_for: NOTES },
    note_anchors: { upsert: [...s.anchors].map((a) => { const [note_id, anchor_id] = a.split("|"); return { anchor_id, note_id, from: 0, to: 1, status: "ok", candidate_from: null, candidate_to: null, quote: "" }; }), replace_for: NOTES },
    note_link_bindings: { upsert: [...s.bindings].map((b) => { const [note_id, link_text, anchor_id] = b.split("|"); return { note_id, link_text, anchor_id }; }), replace_for: NOTES },
    tags: [...s.tags].map((id) => ({ id, name: id, color: null })),
    tasks: { upsert: [...s.tasks].map(([id, t]) => ({ id, node_id: "n1", title: id, status: t.status })), delete: [...s.goneTasks].filter((id) => !s.tasks.has(id)) },
    site_config: { v: s.siteVersion }, chrome: null, workspace: null,
  };
}
type Answer = ReturnType<typeof answerOf>;

// ── the device ───────────────────────────────────────────────────────────────

class Device {
  store!: Bootstrap;
  async start(s: State): Promise<void> {
    forgetWatermark();
    await openWorker();
    const workspace = { id: "w", name: "W", slug: "w", home_node_id: null };
    await rpc("persistBootstrap", { ...noWorkspaceData, workspace, actor_role: "editor", nodes: [], tasks: [], suggestions: [], events: [], edges: [] });
    this.store = { ...noWorkspaceData, workspace } as Bootstrap;
    await this.take(answerOf(s));
  }
  /** One answer through the app's door, as syncEngine.applyAndShow hands it on. */
  take(answer: Answer): Promise<AnswerOutcome> {
    return takeAnswer({
      head: answer.head_event_id, serverId: answer.server_id, rewindTo: answer.last_event_id,
      toCopy: async () => {
        const fromCopy = await rpc<AppliedSyncDelta>("applySync", structuredClone(answer));
        return { value: fromCopy, stale: fromCopy.stale === true, changed: fromCopy.serverChanged === true };
      },
      toStore: (fromCopy) => { this.store = applySyncDelta(this.store, fromCopy); },
    });
  }
  /** A write's response arrived with `position`: its headers reach lib/data/writePositions before anything else. The
   *  page's watermark rises now; the copy's by a message, which `settled` waits for. */
  acknowledged(position: number): Promise<void> {
    responses.listener!("/api/nodes/n1", { method: "PATCH" }, new Response(null, { headers: { [EVENT_POSITION_HEADER]: String(position) } }));
    return rpc("getWatermark").then(() => undefined); // queued behind the raise: the copy has it once this answers
  }
  async local(): Promise<Bootstrap> { return rpc<Bootstrap>("loadBootstrap"); }
}

/** The part of a device a kind is read from. `store` has no anchors / bindings (only the local copy holds them). */
type View = "store" | "local";
type Pick = (b: Bootstrap) => unknown;
const sorted = (xs: Iterable<string>) => [...xs].sort();
const PICK: Record<string, Pick> = {
  // Sorted by id: the store keeps rows in the order they last arrived, which is not what is compared.
  text: (b) => Object.fromEntries(b.nodes.filter((n) => NOTES.includes(n.id)).map((n) => [n.id, n.markdown]).sort()),
  labels: (b) => Object.fromEntries(b.nodes.filter((n) => NOTES.includes(n.id)).map((n) => [n.id, (n.label_tag_ids ?? []).join(",")]).sort()),
  notes: (b) => sorted(b.nodes.filter((n) => NOTES.includes(n.id)).map((n) => n.id)),
  attrs: (b) => sorted(b.nodes.flatMap((n) => Object.entries(n.attrs ?? {}).map(([k, v]) => `${n.id}|${k}|${v}`))),
  edges: (b) => sorted(b.edges.map((e) => e.id)),
  pointers: (b) => sorted((b.pointers ?? []).map((p) => p.id)),
  memberships: (b) => sorted((b.canvas_memberships ?? []).map((m) => `${m.canvas_id}|${m.node_id}`)),
  anchors: (b) => sorted((b.note_anchors ?? []).map((a) => `${a.note_id}|${a.anchor_id}`)),
  bindings: (b) => sorted((b.note_link_bindings ?? []).map((l) => `${l.note_id}|${l.link_text}|${l.anchor_id}`)),
  tags: (b) => sorted((b.tags ?? []).map((t) => t.id)),
  tasks: (b) => sorted(b.tasks.map((t) => `${t.id}|${t.status}`)),
  site: (b) => (b.site_config as { v?: number } | undefined)?.v,
};
const serverPick = (s: State): Record<string, unknown> => ({
  text: Object.fromEntries([...s.notes].filter(([id]) => !s.gone.has(id)).map(([id, n]) => [id, n.markdown]).sort()),
  labels: Object.fromEntries([...s.notes].filter(([id]) => !s.gone.has(id)).map(([id, n]) => [id, n.labels.join(",")]).sort()),
  notes: sorted(NOTES.filter((id) => !s.gone.has(id))),
  attrs: sorted([...s.attrs].map(([k, v]) => `${k}|${v}`)),
  edges: sorted(s.edges.keys()), pointers: sorted(s.pointers.keys()), memberships: sorted(s.memberships),
  anchors: sorted(s.anchors), bindings: sorted(s.bindings), tags: sorted(s.tags),
  tasks: sorted([...s.tasks].map(([id, t]) => `${id}|${t.status}`)), site: s.siteVersion,
});
const VIEWS: Record<string, View[]> = { anchors: ["local"], bindings: ["local"] };
const viewsOf = (pick: string): View[] => VIEWS[pick] ?? ["store", "local"];

// ── what this device can change ──────────────────────────────────────────────

type Kind = {
  /** What is undone, for the test name. */
  name: string;
  /** The part compared (a key of PICK). */
  pick: string;
  /** Needs the server in this state before the change (a note already deleted, …). */
  before?: (s: State) => void;
  change: (s: State, n: number) => void;
};
const KINDS: Kind[] = [
  { name: "note text (a saved note goes back to its older text)", pick: "text", change: (s, n) => { const x = s.notes.get("n1")!; x.markdown = `m${n}`; x.at = 100 + n; } },
  { name: "label tag applied (the tag is gone from the note again)", pick: "labels", change: (s, n) => { const x = s.notes.get("n1")!; x.labels = ["tag0"]; x.at = 100 + n; } },
  { name: "label tag removed (the tag is back on the note)", pick: "labels", before: (s) => { const x = s.notes.get("n1")!; x.labels = ["tag0"]; }, change: (s, n) => { const x = s.notes.get("n1")!; x.labels = []; x.at = 100 + n; } },
  { name: "property value (a changed value, a moved board card, goes back)", pick: "attrs", change: (s, n) => { s.attrs.set("n1|status", `v${n}`); } },
  { name: "property removed (the removed property is back)", pick: "attrs", change: (s) => { s.attrs.delete("n1|status"); s.goneAttrs.add("n1|status"); } },
  { name: "edge added (a link just made is removed)", pick: "edges", change: (s, n) => { s.edges.set(`e${n}`, { source: "n2", target: "n1" }); } },
  { name: "edge removed (a link just removed is back)", pick: "edges", change: (s) => { s.edges.delete("e0"); } },
  { name: "pointer added (a pin just made is removed)", pick: "pointers", change: (s, n) => { s.pointers.set(`p${n}`, { parent: "n2", target: "n1" }); } },
  { name: "pointer removed (a pin just removed is back)", pick: "pointers", change: (s) => { s.pointers.delete("p0"); } },
  { name: "board membership added (a note just put on a board is off it)", pick: "memberships", change: (s) => { s.memberships.add("cv1|n2"); } },
  { name: "board membership removed (a note just taken off a board is on it)", pick: "memberships", change: (s) => { s.memberships.delete("cv1|n1"); } },
  { name: "anchor added (a paragraph anchor just made is dropped)", pick: "anchors", change: (s, n) => { s.anchors.add(`n1|a${n}`); } },
  { name: "anchor removed (an anchor just dropped is back)", pick: "anchors", change: (s) => { s.anchors.delete("n1|a0"); } },
  { name: "link binding added (a part link just bound is unbound)", pick: "bindings", change: (s, n) => { s.bindings.add(`n1|[[y${n}]]|a0`); } },
  { name: "link binding removed (a binding just dropped is back)", pick: "bindings", change: (s) => { s.bindings.delete("n1|[[x]]|a0"); } },
  { name: "tag created (the new tag is missing from the catalog)", pick: "tags", change: (s, n) => { s.tags.add(`tag${n}`); } },
  { name: "tag deleted (the deleted tag is back in the catalog)", pick: "tags", change: (s) => { s.tags.delete("tag0"); } },
  { name: "task ticked (the ticked task is open again)", pick: "tasks", change: (s) => { s.tasks.set("tk0", { status: "done" }); } },
  // The review's case 2: ticking a task is a write to the task, and the server also rewrites the line in its note.
  // Nothing on the device names the note as touched; the answer read before the tick is refused whole all the same.
  { name: "task ticked, its line in the note rewritten by the server (the note's line is unticked again)", pick: "text", change: (s, n) => { s.tasks.set("tk0", { status: "done" }); const x = s.notes.get("n1")!; x.markdown = `- [x] tk0 (${n})`; x.at = 100 + n; } },
  { name: "task added (a task just added is gone) — no: an answer before it cannot name it", pick: "tasks", change: (s, n) => { s.tasks.set(`tk${n}`, { status: "todo" }); } },
  { name: "task removed (the removed task is back)", pick: "tasks", change: (s) => { s.tasks.delete("tk0"); s.goneTasks.add("tk0"); } },
  { name: "site design saved (the saved design goes back)", pick: "site", change: (s) => { s.siteVersion++; } },
  { name: "note deleted (the deleted note comes back)", pick: "notes", change: (s) => { s.gone.add("n3"); } },
  { name: "note restored (the restored note is deleted again)", pick: "notes", before: (s) => { s.gone.add("n3"); }, change: (s) => { s.gone.delete("n3"); const x = s.notes.get("n3")!; x.at += 50; } },
];
// An answer computed before a task was added cannot name it, so it cannot remove it: not a late-answer case. Kept out.
const CASES = KINDS.filter((k) => !k.name.startsWith("task added"));

// ── the run ──────────────────────────────────────────────────────────────────

class Run {
  server = initial();
  device = new Device();
  asked: Array<{ answer: Answer; delivered: boolean }> = [];
  problems: string[] = [];
  private seq = 0;
  async start(before?: (s: State) => void): Promise<void> {
    if (before) before(this.server);
    await this.device.start(this.server);
  }
  /** This device changes something; the server applies it and acknowledges it at its position; the writer's own
   *  result is in the store (modelled as the server's current answer). */
  async change(kind: Kind): Promise<void> {
    this.server.head++;
    kind.change(this.server, ++this.seq);
    await this.device.acknowledged(this.server.head);
    await this.device.take(answerOf(this.server));
  }
  asks(): void { this.asked.push({ answer: answerOf(this.server), delivered: false }); }
  get unanswered(): number { return this.asked.filter((a) => !a.delivered).length; }
  private open(index: number) {
    const open = this.asked.filter((a) => !a.delivered);
    const hit = open[index % open.length];
    if (hit) hit.delivered = true;
    return hit;
  }
  /** A captured answer is delivered now; refused, the device asks again at once (syncEngine). */
  async arrives(index: number, picks: readonly string[] = Object.keys(PICK)): Promise<void> {
    const hit = this.open(index);
    if (!hit) return;
    const outcome = await this.device.take(hit.answer);
    await this.check(picks);
    if (outcome !== "taken") { await this.device.take(answerOf(this.server)); await this.check(picks); }
  }
  /** A captured answer is delivered while the copy is busy: the copy starts applying it, and THEN this device's change
   *  is acknowledged (the page hears at once, the copy only after the answer). The store must not take the answer. */
  async arrivesBusy(index: number, kind: Kind, picks: readonly string[] = Object.keys(PICK)): Promise<void> {
    const hit = this.open(index);
    if (!hit) return;
    const delivering = this.device.take(hit.answer); // its applySync is posted first
    this.server.head++;
    kind.change(this.server, ++this.seq);
    const acknowledged = this.device.acknowledged(this.server.head);
    const outcome = await delivering;
    await acknowledged;
    // What the writer put in the store for its own change is the server's row; the late answer must not replace it.
    await this.device.take(answerOf(this.server));
    if (outcome === "taken") this.problems.push(`#B the store took an answer read before an acknowledged change (${kind.name})`);
    await this.check(picks);
  }
  async check(picks: readonly string[]): Promise<void> {
    const want = serverPick(this.server);
    const local = await this.device.local();
    for (const pick of picks) for (const view of viewsOf(pick)) {
      const got = PICK[pick]!(view === "store" ? this.device.store : local);
      if (JSON.stringify(got) !== JSON.stringify(want[pick])) this.problems.push(`#L ${pick} in the ${view === "store" ? "store" : "local copy"} is ${JSON.stringify(got)} after a late answer, the server holds ${JSON.stringify(want[pick])}`);
    }
  }
}

async function late(kind: Kind): Promise<string[]> {
  const run = new Run();
  await run.start(kind.before);
  run.asks();                         // the device asks the server: the answer is computed now
  await run.change(kind);             // this device changes something and the server acknowledges it
  await run.arrives(0, [kind.pick]);  // the answer computed BEFORE the change arrives
  return run.problems;
}

describe("a late answer must not undo this device's acknowledged change", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterAll(() => { vi.unstubAllGlobals(); });

  for (const kind of CASES) {
    it(`late answer: ${kind.name}`, async () => {
      expect(await late(kind)).toEqual([]);
    }, 20_000);
    // The review's case 1: the copy is busy applying the old answer when the acknowledgement arrives, so the copy takes
    // the answer and only the page's own watermark stands between it and the store.
    it(`late answer while the copy is busy: ${kind.name}`, async () => {
      const run = new Run();
      await run.start(kind.before);
      run.asks();
      await run.arrivesBusy(0, kind, [kind.pick]);
      expect(run.problems).toEqual([]);
    }, 20_000);
  }

  // The local copy's own row of the note (what the next cold start paints), not only the store's: after an acknowledged
  // save a late answer leaves the worker's row — text, title and the server's time — as the save made it.
  it("late answer: the local copy's row of a saved note keeps the saved text, title and time", async () => {
    const run = new Run();
    await run.start();
    run.asks();
    await run.change(CASES[0]!);
    const saved = (await run.device.local()).nodes.find((n) => n.id === "n1")!;
    await run.arrives(0, []);
    const after = (await run.device.local()).nodes.find((n) => n.id === "n1")!;
    expect([after.markdown, after.title, after.updated_at]).toEqual([saved.markdown, saved.title, saved.updated_at]);
  }, 20_000);

  // Something that is NOT a late answer must still be taken: a current answer after the change changes nothing wrongly,
  // and an answer captured before the change but delivered BEFORE it (in order) is taken as usual.
  it("an answer delivered before the change is taken (the guard is not a blanket refusal)", async () => {
    const run = new Run();
    await run.start();
    run.asks();
    await run.arrives(0);
    expect(run.problems).toEqual([]);
    await run.change(CASES[3]!);
    run.asks();
    await run.arrives(0);
    expect(run.problems).toEqual([]);
  }, 20_000);

  // The random property: any order of changes of any kind, answers asked and delivered at any time.
  const kindIndex = fc.nat(CASES.length - 1);
  type Command = { t: "change"; k: number } | { t: "asks" } | { t: "arrives"; i: number } | { t: "busy"; i: number; k: number };
  const command: fc.Arbitrary<Command> = fc.oneof(
    { weight: 4, arbitrary: kindIndex.map((k) => ({ t: "change" as const, k })) },
    { weight: 3, arbitrary: fc.constant({ t: "asks" as const }) },
    { weight: 4, arbitrary: fc.nat(3).map((i) => ({ t: "arrives" as const, i })) },
    { weight: 2, arbitrary: fc.tuple(fc.nat(3), kindIndex).map(([i, k]) => ({ t: "busy" as const, i, k })) },
  );
  const property = async (commands: Command[]): Promise<string[]> => {
    const run = new Run();
    await run.start();
    for (const c of commands) {
      if (c.t === "change") await run.change(CASES[c.k]!);
      else if (c.t === "asks") run.asks();
      else if (c.t === "busy") { if (run.unanswered) await run.arrivesBusy(c.i, CASES[c.k]!); }
      else if (run.unanswered) await run.arrives(c.i);
    }
    return run.problems;
  };
  // Over every kind it finds the first broken one (the shrunk counterexample is the minimal case of one kind, pinned
  // above).
  it("random changes, asks and arrivals over every kind: the device always equals the server", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 14 }), async (commands) => {
      expect(await property(commands)).toEqual([]);
    }), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  }, 120_000);
});

// ── the metamorphic relation for sync ────────────────────────────────────────
//
// MR-Y1: the final state does not depend on how the answers and acknowledgements reach the device. The same history —
// this device's changes of any kinds, each acknowledged at its position, and answers asked between them — is delivered
// once in the order it happened, and once in another order with some messages twice and the rest delayed. The last
// message of the history is a current answer (the next sync after everything). Both devices end equal to each other
// and to the server, in the store and in the local copy.

type Message = { t: "ack"; position: number } | { t: "answer"; answer: Answer };
type History = { kinds: number[]; asksAfter: boolean[]; order: number[]; twice: boolean[] };

/** Replay the captured messages on a fresh device, in `order` (indices into `messages`, repeats allowed). */
async function deliver(start: State, messages: readonly Message[], order: readonly number[]): Promise<Record<string, unknown>> {
  const device = new Device();
  await device.start(start);
  for (const i of order) {
    const m = messages[i]!;
    if (m.t === "ack") await device.acknowledged(m.position);
    else await device.take(m.answer);
  }
  const local = await device.local();
  return Object.fromEntries(Object.keys(PICK).flatMap((pick) => viewsOf(pick).map((view) => [`${pick}/${view}`, PICK[pick]!(view === "store" ? device.store : local)])));
}

describe("MR-Y1 sync converges whatever the arrival order", () => {
  const history: fc.Arbitrary<History> = fc.record({
    kinds: fc.array(fc.nat(CASES.length - 1), { minLength: 1, maxLength: 6 }),
    asksAfter: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    order: fc.array(fc.nat(1000), { minLength: 20, maxLength: 20 }),
    twice: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  });

  it("the same messages in any order, some twice, end in the same state as in the order they happened", async () => {
    await metamorphic<History, { start: State; server: State; messages: Message[] }>({
      name: "MR-Y1 any arrival order, duplication and delay of answers and acknowledgements",
      source: history,
      setup: (h) => {
        const server = initial();
        const start = structuredClone(server);
        const messages: Message[] = [];
        h.kinds.forEach((k, i) => {
          if (h.asksAfter[i]) messages.push({ t: "answer", answer: answerOf(server) });
          server.head++;
          CASES[k]!.change(server, i + 1);
          messages.push({ t: "ack", position: server.head });
        });
        messages.push({ t: "answer", answer: answerOf(server) });
        return { start, server, messages };
      },
      relation: async ({ start, server, messages }, h) => {
        const inOrder = messages.map((_, i) => i);
        // Another order: a stable sort by a random key, then some messages sent twice (a retry, a duplicated answer).
        const shuffled = inOrder.map((i) => ({ i, key: h.order[i % h.order.length]! })).sort((a, b) => a.key - b.key).map((x) => x.i);
        const other = shuffled.flatMap((i, n) => (h.twice[n % h.twice.length] ? [i, i] : [i]));
        if (other.join() === inOrder.join()) return SKIP("the other order is the same order");
        const a = await deliver(start, messages, inOrder);
        const b = await deliver(start, messages, other);
        const want = serverPick(server);
        for (const [key, value] of Object.entries(a)) {
          if (JSON.stringify(value) !== JSON.stringify(b[key])) return `${key}: in order ${JSON.stringify(value)}, in the other order ${JSON.stringify(b[key])}`;
          if (JSON.stringify(value) !== JSON.stringify(want[key.split("/")[0]!])) return `${key}: ${JSON.stringify(value)}, the server holds ${JSON.stringify(want[key.split("/")[0]!])}`;
        }
        return null;
      },
      minCompared: 0.9,
      skipShare: { "the other order is the same order": 0.1 },
      maxRuns: 60,
    });
  }, 300_000);
});
