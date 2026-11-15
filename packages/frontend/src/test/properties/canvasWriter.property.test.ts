// Random whiteboard writes through the REAL canvas write path.
//
// Real: canvasWriter (create, save, place, updateCard, select, refreshOpenCanvas,
// layouts, revisions, membershipEdit), boardLayout.diffBoard, writeLifecycle,
// optimisticFields, writeQueue (submitWrite, the offline queue and its drain).
// Faked: the transport and the local database (test/helpers/canvasWorld.ts: a
// server that applies PATCH /api/boards/:id the way the backend's boardWrites
// does — canvasBoard.property.integration.test.ts runs that rule on the real
// routes).
//
// What the writer has: cards that point at notes and section frames. There are
// no text cards or connections in this data model, and undo / redo live in the
// UI (hooks/useCanvasUndo, positions only) — so "undo" here is what the UI does
// at the writer: save an earlier layout (the writer then sends only the cards
// that differ).
//
// Per command the model says what this device's layout, the queue, the server and
// the "appears on canvases" list must be; after every command:
//   1 the open board is the layout the user's operations built (model)
//   2 the server holds what the model's replay of every accepted / replayed
//     change produces (per card, the later arrival wins)
//   3 the queue holds exactly the writes that did not get through, in order
//   4 the local mirror of the board is the open board
//   5 canvas_memberships has the board's notes the user placed (and not the ones
//     taken off)
// and at the end (online, queue drained, refreshed):
//   6 the open board, the mirror and the server (cards of live notes) are equal
//   7 only a write the server refused can be in recovery, and nothing is left unconfirmed
//
// Commands: place (explicit and appended), move / resize / style (by save and by
// updateCard), remove, section add / remove, undo, two writes started together,
// offline / online / flush, the next request failing (503, network, response
// lost), one the server refuses (422), closing and reopening the board, the other device placing / moving / removing / trashing / restoring,
// and a refresh (what sync does after reconnect).
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/canvasWriter.property.test.ts
//          (fast-check prints the seed, path and the shrunk command list.)

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { BOARD_CARDS_PER_REQUEST_MAX } from "@onden/markdown";
import type { BoardCardPatch, BoardSectionPatch } from "@onden/contract";

vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: vi.fn(async (path: string, init?: unknown) => {
    const { canvasWorld } = await import("../helpers/canvasWorld");
    return canvasWorld.transport(path, init as never);
  }),
}));
vi.mock("../../lib/localDb", async () => {
  const { canvasWorld } = await import("../helpers/canvasWorld");
  return { ...canvasWorld.localDb };
});

import { ApiError, type Bootstrap, type Canvas, type CanvasData, type CanvasNodeEntry, type CanvasSection, type ContentNode } from "../../lib/api";
import { ownerData } from "../ownerData";
import { makeCanvasWriter, type CanvasCtx } from "../../lib/data/canvasWriter";
import { flushPendingWrites, stopWriteRetry } from "../../lib/data/writeQueue";
import { makeViewWriter } from "../../lib/data/viewWriter";
import type { DataCtx } from "../../lib/data/types";
import { getRecoveryWrites, refreshRecoveryWrites } from "../../lib/data/writeRecovery";
import { setPending } from "../../lib/data/syncStatus";
import { bindAccountStorage } from "../../lib/accountStorage";
import { DEFAULT_CARD_W, SPAWN_GAP_X } from "../../lib/cardGeometry";
import { applyCardPatch, applySectionPatch, canonCard, canonSection, canvasWorld as world, type FailureMode } from "../helpers/canvasWorld";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

bindAccountStorage("u", "");
world.makeApiError = (status) => new ApiError(status, JSON.stringify({ error: "x" }));

const NOTE_IDS = ["n0", "n1", "n2"];
/** A run is a few dozen microtask-heavy writes; scale the timeout with the run count. */
const TIMEOUT = 60_000 + PROPS_RUNS * 100;

// ── model ────────────────────────────────────────────────────────────────────

type Card = CanvasNodeEntry;
type Layout = { cards: Map<string, Card>; sections: Map<string, CanvasSection> };
type Changes = { upsert: BoardCardPatch[]; remove: string[]; sectionUpsert: BoardSectionPatch[]; sectionRemove: string[] };
type Queued = { changes: Changes; applied: boolean };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cloneLayout = (l: Layout): Layout => ({ cards: new Map(l.cards), sections: new Map(l.sections) });
const sortedCards = (cards: Iterable<Card>) => [...cards].map(canonCard).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
const sortedSections = (sections: Iterable<CanvasSection>) => [...sections].map(canonSection).sort((a, z) => a.id.localeCompare(z.id));
const view = (l: Layout) => ({ cards: sortedCards(l.cards.values()), sections: sortedSections(l.sections.values()) });
const dataView = (d: CanvasData | undefined) => ({ cards: sortedCards(d?.nodes ?? []), sections: sortedSections(d?.sections ?? []) });
const toData = (l: Layout): CanvasData => ({ nodes: [...l.cards.values()], sections: [...l.sections.values()] });
/** The fields of `card` that differ from `old`; a card the server may not have is sent whole (boardLayout cardPatch). */
function cardPatch(old: Card | undefined, card: Card): BoardCardPatch | null {
  const patch: BoardCardPatch = { nodeId: card.nodeId };
  if (!old || old.x !== card.x || old.y !== card.y) { patch.x = card.x; patch.y = card.y; }
  for (const k of ["width", "height", "color", "subCanvasId"] as const) {
    if ((old?.[k] ?? null) !== (card[k] ?? null)) Object.assign(patch, { [k]: card[k] ?? null });
  }
  if (!!old?.folded !== !!card.folded) patch.folded = !!card.folded;
  return Object.keys(patch).length > 1 ? patch : null;
}
/** A frame on the wire: whole when new, else the changed fields (x with y, width with height). */
function sectionPatch(old: CanvasSection | undefined, s: CanvasSection): BoardSectionPatch | null {
  if (!old) return canonSection(s);
  const patch: BoardSectionPatch = { id: s.id };
  if (old.title !== s.title) patch.title = s.title;
  if (old.x !== s.x || old.y !== s.y) { patch.x = s.x; patch.y = s.y; }
  if (old.width !== s.width || old.height !== s.height) { patch.width = s.width; patch.height = s.height; }
  if ((old.color ?? null) !== (s.color ?? null)) patch.color = s.color ?? null;
  return Object.keys(patch).length > 1 ? patch : null;
}
/** The edits that turn `before` into `after` (what lib/boardLayout diffBoard must send). */
function diff(before: Layout, after: Layout): Changes {
  return {
    upsert: [...after.cards.values()].flatMap((c) => { const p = cardPatch(before.cards.get(c.nodeId), c); return p ? [p] : []; }),
    remove: [...before.cards.keys()].filter((id) => !after.cards.has(id)),
    sectionUpsert: [...after.sections.values()].flatMap((s) => { const p = sectionPatch(before.sections.get(s.id), s); return p ? [p] : []; }),
    sectionRemove: [...before.sections.keys()].filter((id) => !after.sections.has(id)),
  };
}
const isEmpty = (c: Changes) => !c.upsert.length && !c.remove.length && !c.sectionUpsert.length && !c.sectionRemove.length;

class Model {
  layout: Layout = { cards: new Map(), sections: new Map() };
  undo: Layout[] = [];
  queue: Queued[] = [];
  online = true;
  failNext: FailureMode | null = null;
  /** The server: stored cards (a trashed note's card stays stored), sections, trash. */
  stored = new Map<string, Card>();
  storedSections = new Map<string, CanvasSection>();
  trashed = new Set<string>();
  /** Notes this device placed and did not take off (canvas_memberships). */
  members = new Set<string>();
  /** Writes the server refused (422): their input stays in recovery. */
  refusals = 0;

  serverApply(c: Changes): void {
    const upserted = new Set<string>();
    for (const card of c.upsert) {
      if (this.trashed.has(card.nodeId)) continue;
      const next = applyCardPatch(this.stored.get(card.nodeId), card);
      if (next) this.stored.set(card.nodeId, next);
      upserted.add(card.nodeId);
    }
    for (const id of c.remove) if (!this.trashed.has(id) && !upserted.has(id)) this.stored.delete(id);
    for (const id of c.sectionRemove) this.storedSections.delete(id);
    for (const s of c.sectionUpsert) {
      const next = applySectionPatch(this.storedSections.get(s.id), s);
      if (next) this.storedSections.set(s.id, next);
    }
  }

  visible(): Layout {
    return {
      cards: new Map([...this.stored].filter(([id]) => !this.trashed.has(id))),
      sections: new Map(this.storedSections),
    };
  }

  /** This device sent `c` (writer.change): sent now, or queued behind a backlog / offline / failure. */
  send(c: Changes): void {
    if (isEmpty(c)) return;
    if (!this.online || this.queue.length) { this.queue.push({ changes: c, applied: false }); return; }
    const failure = this.failNext;
    this.failNext = null;
    if (!failure) { this.serverApply(c); return; }
    if (failure === "lost") this.serverApply(c);
    this.queue.push({ changes: c, applied: failure === "lost" });
  }

  /** flushPendingWrites: in order; a failure keeps the head and everything behind it. */
  drain(): void {
    while (this.queue.length) {
      const head = this.queue[0]!;
      const failure = this.failNext;
      this.failNext = null;
      if (failure) {
        if (failure === "lost" && !head.applied) { this.serverApply(head.changes); head.applied = true; }
        return;
      }
      if (!head.applied) this.serverApply(head.changes);
      this.queue.shift();
    }
  }

  /** A write of the user's: the layout becomes `next`, the diff goes out, undo remembers. */
  edit(next: Layout): void {
    const before = this.layout;
    const c = diff(before, next);
    this.layout = next;
    this.members = new Set([...this.members].filter((id) => !c.remove.includes(id)));
    for (const card of c.upsert) if (!before.cards.has(card.nodeId) && NOTE_IDS.includes(card.nodeId)) this.members.add(card.nodeId);
    if (isEmpty(c)) return;
    this.undo.push(before);
    this.send(c);
  }
}

// ── the rig: the real writer around the fake world ───────────────────────────

/** The writer's context, reading the rig's current state. */
function contextOf(rig: Rig): CanvasCtx {
  return {
    get online() { return rig.online; },
    get data() { return rig.data; },
    setData: (update) => { rig.data = typeof update === "function" ? update(rig.data) : update; },
    get activeCanvas() { return rig.active; },
    setActiveCanvas: (update) => { rig.active = typeof update === "function" ? update(rig.active) : update; },
    addToast: (message) => { rig.toasts.push(String(message)); },
  };
}

class Rig {
  data: Bootstrap = { ...ownerData, nodes: [], canvas_memberships: [] };
  active: Canvas | null = null;
  online = true;
  toasts: string[] = [];
  canvasId = "";
  writer!: ReturnType<typeof makeCanvasWriter>;

  async setup(): Promise<void> {
    world.reset("");
    localStorage.clear();
    await refreshRecoveryWrites();
    setPending(0);
    this.online = true; this.toasts = []; this.active = null;
    const now = "2026-01-01T00:00:00.000Z";
    const notes: ContentNode[] = NOTE_IDS.map((id) => ({ id, title: `Note ${id}`, slug: id, markdown: "", source_type: "manual", node_type: "content", created_at: now, updated_at: now }));
    this.data = { ...ownerData, nodes: notes, canvas_memberships: [] };
    const ctx = contextOf(this);
    this.writer = makeCanvasWriter(ctx);
    const created = await this.writer.create("Board");
    this.canvasId = created.id;
  }

  get layout(): CanvasData | undefined { return this.active?.id === this.canvasId ? this.active.data : undefined; }
  members(): string[] {
    return (this.data.canvas_memberships ?? []).filter((m) => m.canvas_id === this.canvasId).map((m) => m.node_id).sort();
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

type Real = Rig;
class Cmd implements fc.AsyncCommand<Model, Real, false> {
  constructor(private readonly name: string, private readonly act: (m: Model, r: Rig) => Promise<void> | void, private readonly when: (m: Model) => boolean = () => true) {}
  check(m: Readonly<Model>): boolean { return this.when(m); }
  async run(m: Model, r: Real): Promise<void> {
    await this.act(m, r);
    verify(m, r, this.name);
  }
  toString(): string { return this.name; }
}

const hasCards = (m: Model) => m.layout.cards.size > 0;
const cardAt = (m: Model, pick: number): Card => {
  const cards = [...m.layout.cards.values()].sort((a, z) => a.nodeId.localeCompare(z.nodeId));
  return cards[pick % cards.length]!;
};

type CardFields = Partial<Omit<Card, "nodeId">>;
type UserOp = { name: string; model: (m: Model) => Layout | null; real: (m: Model, r: Rig) => Promise<unknown> };

/** Operations of the user on the open board; each says what the layout becomes (the model)
 *  and how the UI asks the writer for it (the real). Both read the model's layout at the
 *  time the operation starts, so two started together are two edits in order. */
const userOps = {
  place: (note: number, x: number, y: number): UserOp => {
    const id = NOTE_IDS[note]!;
    return {
      name: `place ${id} at (${x},${y})`,
      model: (m) => { if (m.layout.cards.has(id)) return null; const l = cloneLayout(m.layout); l.cards.set(id, { nodeId: id, x, y }); return l; },
      real: (_m, r) => r.writer.place(r.canvasId, id, { x, y }),
    };
  },
  placeNext: (note: number): UserOp => {
    const id = NOTE_IDS[note]!;
    return {
      name: `place ${id} to the right`,
      model: (m) => {
        if (m.layout.cards.has(id)) return null;
        const cards = [...m.layout.cards.values()];
        const right = cards.reduce((edge, c) => Math.max(edge, c.x + (c.width ?? DEFAULT_CARD_W)), 0);
        const top = cards.reduce((edge, c) => Math.min(edge, c.y), Infinity);
        const point = cards.length ? { x: right + SPAWN_GAP_X, y: top } : { x: 100, y: 100 };
        const l = cloneLayout(m.layout); l.cards.set(id, { nodeId: id, x: Math.round(point.x), y: Math.round(point.y) }); return l;
      },
      real: (_m, r) => r.writer.place(r.canvasId, id),
    };
  },
  /** move / resize / style, asked as a whole layout (the board's drag) or per card. */
  change: (kind: string, pick: number, fields: CardFields, viaCard: boolean): UserOp => ({
    name: `${kind} card #${pick} ${viaCard ? "(updateCard)" : "(save)"} ${JSON.stringify(fields)}`,
    model: (m) => { if (!hasCards(m)) return null; const c = cardAt(m, pick); const l = cloneLayout(m.layout); l.cards.set(c.nodeId, { ...c, ...fields }); return l; },
    real: (m, r) => {
      const c = cardAt(m, pick);
      if (viaCard) return r.writer.updateCard(r.canvasId, c.nodeId, fields);
      const data = toData(m.layout);
      return r.writer.save(r.canvasId, { ...data, nodes: data.nodes.map((n) => n.nodeId === c.nodeId ? { ...n, ...fields } : n) });
    },
  }),
  remove: (pick: number): UserOp => ({
    name: `remove card #${pick}`,
    model: (m) => { if (!hasCards(m)) return null; const l = cloneLayout(m.layout); l.cards.delete(cardAt(m, pick).nodeId); return l; },
    real: (m, r) => {
      const id = cardAt(m, pick).nodeId;
      const data = toData(m.layout);
      return r.writer.save(r.canvasId, { ...data, nodes: data.nodes.filter((n) => n.nodeId !== id) });
    },
  }),
  section: (slot: number, x: number, y: number): UserOp => {
    const id = `sec-${slot}`;
    const section: CanvasSection = { id, x, y, width: 300, height: 200, title: `S${slot}` };
    return {
      name: `section ${id} at (${x},${y})`,
      model: (m) => { const l = cloneLayout(m.layout); l.sections.set(id, section); return l; },
      real: (m, r) => r.writer.save(r.canvasId, { ...toData(m.layout), sections: [...[...m.layout.sections.values()].filter((s) => s.id !== id), section] }),
    };
  },
  // Rename or resize a frame that exists (only the changed fields travel, so another device's edit to the others stays).
  editSection: (slot: number, change: "title" | "size", n: number): UserOp => {
    const id = `sec-${slot}`;
    const edit = (s: CanvasSection): CanvasSection => change === "title" ? { ...s, title: `T${n}` } : { ...s, width: 160 + n, height: 100 + n };
    return {
      name: `${change === "title" ? "rename" : "resize"} section ${id} (${n})`,
      model: (m) => { const l = cloneLayout(m.layout); const old = l.sections.get(id); if (old) l.sections.set(id, edit(old)); return l; },
      real: (m, r) => r.writer.save(r.canvasId, { ...toData(m.layout), sections: [...m.layout.sections.values()].map((s) => s.id === id ? edit(s) : s) }),
    };
  },
  unsection: (slot: number): UserOp => {
    const id = `sec-${slot}`;
    return {
      name: `remove section ${id}`,
      model: (m) => { const l = cloneLayout(m.layout); l.sections.delete(id); return l; },
      real: (m, r) => r.writer.save(r.canvasId, { ...toData(m.layout), sections: [...m.layout.sections.values()].filter((s) => s.id !== id) }),
    };
  },
  undo: (): UserOp => ({
    name: "undo",
    model: (m) => m.undo.length ? m.undo[m.undo.length - 1]! : null,
    real: (m, r) => r.writer.save(r.canvasId, toData(m.undo[m.undo.length - 1]!)),
  }),
};

/** Start the user operations together (no awaiting between), then wait for all. */
async function runUser(m: Model, r: Rig, ops: UserOp[]): Promise<void> {
  const started: Array<Promise<unknown>> = [];
  for (const op of ops) {
    const next = op.model(m);
    if (!next) continue;
    const isUndo = op.name === "undo";
    const real = op.real(m, r);
    if (isUndo) {
      // An undo is a write of the earlier layout and is not itself undoable.
      const before = m.layout;
      const c = diff(before, next);
      m.layout = next;
      m.undo.pop();
      m.members = new Set([...m.members].filter((id) => !c.remove.includes(id)));
      for (const card of c.upsert) if (!before.cards.has(card.nodeId) && NOTE_IDS.includes(card.nodeId)) m.members.add(card.nodeId);
      m.send(c);
    } else m.edit(next);
    started.push(real);
  }
  await Promise.all(started);
}

/** One operation whose request the server refuses (422), when it would be sent at all.
 *  A refusal rolls this one change back (layout, "appears on canvases"), keeps the
 *  input in recovery and never reaches the server. Offline or behind a backlog the
 *  write is only queued, so there is nothing to refuse yet. */
const refused = (op: UserOp) => new Cmd(`${op.name} (server refuses it)`, async (m, r) => {
  const next = op.model(m);
  if (!next) return;
  // A failure already armed (503, …) takes the next request; then this is an ordinary write.
  const will = !m.failNext && m.online && !m.queue.length && !isEmpty(diff(m.layout, next));
  if (will) world.failNext = "reject";
  const real = op.real(m, r);
  if (will) m.refusals++; else m.edit(next);
  try { await real; if (will) throw new Error("the refused write was reported as saved"); }
  catch (error) { if (!will) throw error; }
  if (will) world.failNext = null;
});

const user = (...ops: UserOp[]) => new Cmd(ops.map((o) => o.name).join(" + "), (m, r) => runUser(m, r, ops));

const remote = {
  place: (note: number, x: number, y: number) => new Cmd(`other device places ${NOTE_IDS[note]} at (${x},${y})`, (m) => {
    const c = { upsert: [{ nodeId: NOTE_IDS[note]!, x, y }], remove: [], sectionUpsert: [], sectionRemove: [] };
    m.serverApply(c); world.applyChanges({ cards: { upsert: c.upsert } });
  }),
  move: (pick: number, x: number, y: number) => new Cmd(`other device moves card #${pick} to (${x},${y})`, (m) => {
    const cards = [...m.stored.values()].sort((a, z) => a.nodeId.localeCompare(z.nodeId));
    const c = cards[pick % cards.length]!;
    const next = { ...c, x, y };
    m.serverApply({ upsert: [next], remove: [], sectionUpsert: [], sectionRemove: [] }); world.applyChanges({ cards: { upsert: [next] } });
  }, (m) => m.stored.size > 0),
  remove: (pick: number) => new Cmd(`other device removes card #${pick}`, (m) => {
    const cards = [...m.stored.values()].sort((a, z) => a.nodeId.localeCompare(z.nodeId));
    const id = cards[pick % cards.length]!.nodeId;
    m.serverApply({ upsert: [], remove: [id], sectionUpsert: [], sectionRemove: [] }); world.applyChanges({ cards: { remove: [id] } });
  }, (m) => m.stored.size > 0),
  trash: (note: number) => new Cmd(`other device trashes ${NOTE_IDS[note]}`, (m) => { m.trashed.add(NOTE_IDS[note]!); world.trashed.add(NOTE_IDS[note]!); }),
  restore: (note: number) => new Cmd(`other device restores ${NOTE_IDS[note]}`, (m) => { m.trashed.delete(NOTE_IDS[note]!); world.trashed.delete(NOTE_IDS[note]!); }),
};

const net = {
  offline: () => new Cmd("go offline", (m, r) => { m.online = false; r.online = false; }),
  online: () => new Cmd("go online and replay the queue", async (m, r) => { m.online = true; r.online = true; m.drain(); await flushPendingWrites(); }),
  flush: () => new Cmd("queue drain retry", async (m) => { if (!m.online) return; m.drain(); await flushPendingWrites(); }, (m) => m.online),
  fail: (mode: FailureMode) => new Cmd(`next request fails (${mode})`, (m) => { m.failNext = mode; world.failNext = mode; }),
  reopen: () => new Cmd("close the board and open it again", async (m, r) => {
    await r.writer.select(null);
    await r.writer.select(r.canvasId);
    // Online with nothing queued the board is read from the server; otherwise from this device.
    if (m.online && !m.queue.length) { m.layout = m.visible(); m.undo = []; }
  }),
  refresh: () => new Cmd("refresh the open board (sync after reconnect)", async (m, r) => {
    await r.writer.refreshOpenCanvas();
    // The writer keeps a board that still has queued input; otherwise it takes the server's.
    if (!m.queue.length) { m.layout = m.visible(); m.undo = []; }
  }),
};

// ── invariants ───────────────────────────────────────────────────────────────

function verify(m: Model, r: Rig, after: string): void {
  const problems: string[] = [];
  if (!same(dataView(r.layout), view(m.layout))) problems.push(`#1 the open board is\n${JSON.stringify(dataView(r.layout))}\nbut the user's operations built\n${JSON.stringify(view(m.layout))}`);
  if (!same({ cards: sortedCards(world.cards.values()), sections: sortedSections(world.sections.values()) }, { cards: sortedCards(m.stored.values()), sections: sortedSections(m.storedSections.values()) })) {
    problems.push(`#2 the server holds\n${JSON.stringify({ cards: sortedCards(world.cards.values()), sections: sortedSections(world.sections.values()) })}\nthe model expects\n${JSON.stringify({ cards: sortedCards(m.stored.values()), sections: sortedSections(m.storedSections.values()) })}`);
  }
  const queued = world.queue.pending.map((w) => `${w.method} ${w.path}`);
  if (queued.length !== m.queue.length) problems.push(`#3 the queue holds ${queued.length} writes (${queued.join(", ")}), the model expects ${m.queue.length}`);
  const row = world.mirror.get(r.canvasId);
  if (row && !same(dataView(row.data ?? undefined), dataView(r.layout))) problems.push(`#4 the local mirror holds ${JSON.stringify(dataView(row.data ?? undefined))} but the board shows ${JSON.stringify(dataView(r.layout))}`);
  if (!row) problems.push("#4 the board has no local mirror");
  if (!same(r.members(), [...m.members].sort())) problems.push(`#5 "appears on canvases" holds ${JSON.stringify(r.members())}, the user placed ${JSON.stringify([...m.members].sort())}`);
  if (problems.length) throw new Error(`after "${after}":\n${problems.join("\n")}\nrequests: ${world.requests.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path} ${JSON.stringify(q.body)}`).join("\n          ")}`);
}

async function settle(m: Model, r: Rig): Promise<void> {
  world.failNext = null; m.failNext = null;
  m.online = true; r.online = true;
  for (let round = 0; round < 5 && m.queue.length; round++) { m.drain(); await flushPendingWrites(); }
  await r.writer.refreshOpenCanvas();
  if (!m.queue.length) { m.layout = m.visible(); m.undo = []; }
  verify(m, r, "settling (online, queue drained, refreshed)");
  const problems: string[] = [];
  if (m.queue.length || world.queue.pending.length) problems.push(`the queue never emptied: ${world.queue.pending.length} writes left`);
  const shown = dataView(r.layout);
  const server = dataView(world.visible());
  if (!same(shown, server)) problems.push(`#6 the open board\n${JSON.stringify(shown)}\nis not the server's board\n${JSON.stringify(server)}`);
  const mirror = world.mirror.get(r.canvasId);
  if (!same(dataView(mirror?.data ?? undefined), server)) problems.push(`#6 the local mirror is not the server's board`);
  // A layout holds nothing the user typed, so a refusal is rolled back and told, not kept in recovery.
  if (world.queue.rejected.length > m.refusals) problems.push(`#7 ${world.queue.rejected.length} writes are in recovery, the server refused ${m.refusals}`);
  if (getRecoveryWrites().filter((w) => w.rejection === undefined).length) problems.push("#7 an unconfirmed write was left behind");
  if (problems.length) throw new Error(problems.join("\n"));
}

// ── generators ───────────────────────────────────────────────────────────────

const note = fc.nat(NOTE_IDS.length - 1);
const coord = fc.integer({ min: -400, max: 1600 });
const pick = fc.nat(9);
const fields: fc.Arbitrary<{ kind: string; fields: CardFields }> = fc.oneof(
  fc.record({ x: coord, y: coord }).map((f) => ({ kind: "move", fields: f })),
  fc.record({ width: fc.integer({ min: 40, max: 800 }), height: fc.integer({ min: 40, max: 800 }) }).map((f) => ({ kind: "resize", fields: f })),
  fc.record({ color: fc.constantFrom("red", "blue", "green"), folded: fc.boolean() }).map((f) => ({ kind: "style", fields: f })),
);
const userOp: fc.Arbitrary<UserOp> = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(note, coord, coord).map(([n, x, y]) => userOps.place(n, x, y)) },
  { weight: 2, arbitrary: note.map(userOps.placeNext) },
  { weight: 5, arbitrary: fc.tuple(pick, fields, fc.boolean()).map(([p, f, via]) => userOps.change(f.kind, p, f.fields, via)) },
  { weight: 3, arbitrary: pick.map(userOps.remove) },
  { weight: 1, arbitrary: fc.tuple(fc.nat(1), coord, coord).map(([s, x, y]) => userOps.section(s, x, y)) },
  { weight: 1, arbitrary: fc.nat(1).map(userOps.unsection) },
  { weight: 1, arbitrary: fc.tuple(fc.nat(1), fc.constantFrom<"title" | "size">("title", "size"), fc.nat(500)).map(([s, change, n]) => userOps.editSection(s, change, n)) },
  { weight: 3, arbitrary: fc.constant(userOps.undo()) },
);
/** PROPS_WITHOUT=burst,fail leaves those kinds out, to look past a known bug. */
const WITHOUT = (process.env.PROPS_WITHOUT ?? "").split(",").filter(Boolean);
const kinds: Array<[kind: string, weight: number, arb: fc.Arbitrary<Cmd>]> = [
  ["user", 12, userOp.map((op) => user(op))],
  ["refused", 2, userOp.filter((op) => op.name !== "undo").map(refused)],
  ["reopen", 2, fc.constant(net.reopen())],
  ["burst", 3, fc.tuple(userOp, userOp).map(([a, b]) => user(a, b))],
  ["offline", 2, fc.constant(net.offline())],
  ["online", 3, fc.constant(net.online())],
  ["flush", 1, fc.constant(net.flush())],
  ["fail", 2, fc.constantFrom<FailureMode>("503", "network", "lost").map(net.fail)],
  ["refresh", 3, fc.constant(net.refresh())],
  ["remotePlace", 2, fc.tuple(note, coord, coord).map(([n, x, y]) => remote.place(n, x, y))],
  ["remoteMove", 2, fc.tuple(pick, coord, coord).map(([p, x, y]) => remote.move(p, x, y))],
  ["remoteRemove", 1, pick.map(remote.remove)],
  ["remoteTrash", 1, note.map(remote.trash)],
  ["remoteRestore", 1, note.map(remote.restore)],
];
const commandArbs = kinds.filter(([kind]) => !WITHOUT.includes(kind)).flatMap(([, weight, arb]) => Array.from({ length: weight }, () => arb));

const rig = new Rig();
async function runCommands(commands: Iterable<fc.AsyncCommand<Model, Real, false>>): Promise<void> {
  await rig.setup();
  const model = new Model();
  await fc.asyncModelRun(() => ({ model, real: rig }), commands);
  await settle(model, rig);
}

describe("whiteboard writer under random operations", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a card dragged on a device that was offline lands once online, beside the other device's card", async () => {
    await runCommands([
      remote.place(1, 500, 0),
      user(userOps.place(0, 10, 10)), net.offline(), user(userOps.change("move", 0, { x: 40, y: 40 }, false)),
      net.online(), net.refresh(),
    ]);
    expect(world.cards.get("n0")).toMatchObject({ x: 40, y: 40 });
    expect(world.cards.get("n1")).toMatchObject({ x: 500, y: 0 });
    expect(rig.layout?.nodes.map((c) => c.nodeId).sort()).toEqual(["n0", "n1"]);
  });

  it("a change of more cards than one request may carry goes out in capped requests, in order, each once (F7)", async () => {
    await rig.setup();
    await rig.writer.select(rig.canvasId);
    const total = BOARD_CARDS_PER_REQUEST_MAX * 2 + 10;
    const nodes = Array.from({ length: total }, (_, i) => ({ nodeId: `big${i}`, x: i, y: i }));
    await rig.writer.save(rig.canvasId, { nodes });
    const sent = world.requests.filter((r) => r.method === "PATCH").map((r) => r.body?.cards?.upsert ?? []);
    expect(sent).toHaveLength(3);
    expect(sent.every((cards) => cards.length <= BOARD_CARDS_PER_REQUEST_MAX)).toBe(true);
    expect(sent.flat().map((c) => c.nodeId)).toEqual(nodes.map((c) => c.nodeId));
    expect(new Set(world.requests.filter((r) => r.method === "PATCH").map((r) => r.idemKey)).size).toBe(3);
    expect(world.cards.size).toBe(total);
  });

  it("random operations keep the open board, queue, mirror and server in step with the model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 25, size: "max" }), runCommands),
      { seed: PROPS_SEED, numRuns: PROPS_RUNS, endOnFailure: false },
    );
  }, TIMEOUT);
});

// Scan 08 #5a: the board's settings (a key of the whiteboard tab's layout_config) written from two devices. This device
// names only its own key (`layout_config_patch`), also in the offline queue; the other device changes another key (or the
// same one) meanwhile. Through the real viewWriter, write queue and replay; the server is canvasWorld's view rule.
describe("board settings written from two devices", () => {
  type SettingOp =
    | { kind: "mine"; key: string; value: number | null }
    | { kind: "theirs"; key: string; value: number | null }
    | { kind: "offline" }
    | { kind: "online" };
  const KEYS = ["tree", "display", "hidden"];
  const opArb: fc.Arbitrary<SettingOp> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("mine" as const), key: fc.constantFrom(...KEYS), value: fc.oneof(fc.nat(9), fc.constant(null)) }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("theirs" as const), key: fc.constantFrom(...KEYS), value: fc.oneof(fc.nat(9), fc.constant(null)) }) },
    { weight: 1, arbitrary: fc.constant({ kind: "offline" as const }) },
    { weight: 2, arbitrary: fc.constant({ kind: "online" as const }) },
  );
  const put = (config: Record<string, unknown>, key: string, value: number | null) => {
    const next = { ...config };
    if (value === null) delete next[key]; else next[key] = value;
    return next;
  };

  async function play(ops: SettingOp[]): Promise<void> {
    await rig.setup();
    const ctx = { ...contextOf(rig), scheduleUserFolderSync: () => {}, refresh: async () => {} } as unknown as DataCtx;
    const views = makeViewWriter(ctx);
    let expected: Record<string, unknown> = {};
    let online = true;
    const queued: Array<{ key: string; value: number | null }> = [];
    for (const op of ops) {
      if (op.kind === "mine") {
        await views.update({ kind: "node", id: "n0" }, "tab", { layout_config_patch: { [op.key]: op.value } });
        if (online) expected = put(expected, op.key, op.value); else queued.push(op);
      } else if (op.kind === "theirs") {
        world.applyViewChanges({ layout_config_patch: { [op.key]: op.value } });
        expected = put(expected, op.key, op.value);
      } else if (op.kind === "offline") {
        online = false; rig.online = false; world.viewsDown = true;
      } else {
        online = true; rig.online = true; world.viewsDown = false;
        for (const q of queued.splice(0)) expected = put(expected, q.key, q.value);
        await flushPendingWrites();
      }
      if (online) expect(world.viewConfig, `after ${JSON.stringify(op)}`).toEqual(expected);
    }
    rig.online = true; world.viewsDown = false;
    for (const q of queued.splice(0)) expected = put(expected, q.key, q.value);
    await flushPendingWrites();
        stopWriteRetry();
    expect(world.viewConfig).toEqual(expected);
  }

  it("fixed case: a setting queued offline replays as its own key and keeps the one the other device set meanwhile", async () => {
    await play([{ kind: "offline" }, { kind: "mine", key: "display", value: 1 }, { kind: "theirs", key: "tree", value: 2 }, { kind: "online" }]);
    expect(world.viewConfig).toEqual({ display: 1, tree: 2 });
    const sent = world.requests.filter((r) => r.method === "PATCH" && r.path.includes("/views/")).map((r) => r.body);
    // The attempt that failed offline and the replay carry the same body: only this device's key.
    expect(new Set(sent.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify({ layout_config_patch: { display: 1 } })]));
  });

  it("fixed case: the same key changed on both devices while this one was offline: the replayed write is the later one", async () => {
    await play([{ kind: "offline" }, { kind: "mine", key: "hidden", value: 0 }, { kind: "theirs", key: "hidden", value: 1 }, { kind: "online" }]);
    expect(world.viewConfig).toEqual({ hidden: 0 });
  });

  it("fixed case: removing a key offline (null) removes only that key", async () => {
    await play([{ kind: "theirs", key: "hidden", value: 1 }, { kind: "offline" }, { kind: "mine", key: "hidden", value: null }, { kind: "theirs", key: "tree", value: 3 }, { kind: "online" }]);
    expect(world.viewConfig).toEqual({ tree: 3 });
  });

  it("random: two devices' settings end as the order the server received them says", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 20 }), play), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  }, TIMEOUT);
});
