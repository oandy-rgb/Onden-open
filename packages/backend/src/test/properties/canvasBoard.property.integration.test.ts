// Random whiteboard writes through the real routes, two devices, against a model.
//
// A canvas keeps its cards in node_positions and its section frames in an
// attribute; a layout is written only as CHANGES (PATCH /api/boards/:id: the
// cards/sections a change names are upserted or removed, the rest is left
// alone) and read with GET /api/canvases/:id (and /api/boards/:id). What there
// is in the data model: cards that point at NOTES (no text cards, no
// connections) and section frames. Undo / redo is the client's: it sends the
// diff between two layouts, so the commands below do the same.
//
// Operations: place / move / resize / recolor / fold / remove a card, add /
// move / rename / resize / remove a section (frames are patched by field, like cards), trash a note and bring it back (POST /undelete),
// undo and redo (per device, a stack of layouts), a device offline for a while
// (its changes queue, then replay in order) and a sync (the device takes the
// server's layout, like GET on reconnect).
//
// The model server applies a change the way services/boardWrites.ts documents:
// per card FIELD, last write wins (a change names only the fields it changed); a card of a note that is in the trash is neither
// listed, written nor removed.
//
// After every command, and at the end once both devices flushed and synced:
//   1 never a 500 or an unnamed refusal
//   2 GET /api/canvases/:id and GET /api/boards/:id both equal the model
//     (cards of live notes, sections), position / size / style included
//   3 no card points at a missing or trashed note: reading a board whose notes
//     were trashed does not fail, and the card is back once the note is
//   4 two devices' edits to DIFFERENT cards are both kept after sync
//   5 an undo is exactly the previous layout, undo to the bottom then redo to
//     the top ends at the layout before the undos (single device)
//   6 after both devices synced, each device's layout equals the server's
//   7 replaying structure_log from its start gives the cards and section frames the tables hold
//
// A removal or placement naming a card whose note is in the trash still
// applies (also fixed as cases KNOWN A and B below).
//
//   PROPS_SEED=123 PROPS_RUNS=2000 npx vitest run src/test/properties/canvasBoard.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getWorkspaceId, pool, q } from "../../db.js";
import { joinDefaultSpace } from "../helpers/spaceFixtures.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync, PROPS_RUNS } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";
import { boardCardProblems, boardSectionProblems } from "../helpers/structureReplay.js";

vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../../app.js");

const isTestDb = isTestDatabase();
/** Every command is a few requests; keep the default run inside the time budget. */
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 40;

/** A run is ~50-100 ms of requests; a long PROPS_RUNS needs a longer test timeout. */
const TIMEOUT = 120_000 + PROPS_RUNS * 300;

type Reply = { status: number; body: any };
async function call(path: string, method = "GET", json?: unknown): Promise<Reply> {
  const res = await app.request(path, {
    method,
    headers: { origin: "http://localhost", ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

// ── model ────────────────────────────────────────────────────────────────────

type Card = { nodeId: string; x: number; y: number; width?: number; height?: number; color?: string; folded?: boolean };
type Section = { id: string; x: number; y: number; width: number; height: number; title: string };
type Layout = { cards: Map<string, Card>; sections: Map<string, Section> };
/** A card on the wire: the fields that changed (absent = left as stored, null = cleared). */
type CardPatch = { nodeId: string; x?: number; y?: number; width?: number | null; height?: number | null; color?: string | null; folded?: boolean };
/** A frame on the wire: the fields that changed (x and y together, width and height together). */
type SectionPatch = { id: string; title?: string; x?: number; y?: number; width?: number; height?: number };
type Changes = { cards: { upsert: CardPatch[]; remove: string[] }; sections: { upsert: SectionPatch[]; remove: string[] } };

const emptyLayout = (): Layout => ({ cards: new Map(), sections: new Map() });
const cloneLayout = (l: Layout): Layout => ({ cards: new Map(l.cards), sections: new Map(l.sections) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The card as the server returns it: optional fields omitted when unset. */
const canon = (c: Card): Card => ({
  nodeId: c.nodeId, x: c.x, y: c.y,
  ...(c.width !== undefined ? { width: c.width } : {}),
  ...(c.height !== undefined ? { height: c.height } : {}),
  ...(c.color !== undefined ? { color: c.color } : {}),
  ...(c.folded ? { folded: true } : {}),
});
const canonSection = (s: Section): Section => ({ id: s.id, x: s.x, y: s.y, width: s.width, height: s.height, title: s.title });
/** lib/boardLayout.ts cardPatch: the fields of `card` that differ from `old`; a card the server may not have is sent whole. */
function cardPatch(old: Card | undefined, card: Card): CardPatch | null {
  const patch: CardPatch = { nodeId: card.nodeId };
  if (!old || old.x !== card.x || old.y !== card.y) { patch.x = card.x; patch.y = card.y; }
  for (const key of ["width", "height", "color"] as const) {
    if ((old?.[key] ?? null) !== (card[key] ?? null)) Object.assign(patch, { [key]: card[key] ?? null });
  }
  if (!!old?.folded !== !!card.folded) patch.folded = !!card.folded;
  return Object.keys(patch).length > 1 ? patch : null;
}
/** services/boardStore.ts patchNodePosition: absent fields stay, null clears; a missing card needs x and y. */
function applyPatch(old: Card | undefined, patch: CardPatch): Card | undefined {
  if (!old && (patch.x === undefined || patch.y === undefined)) return undefined;
  const next: Record<string, unknown> = { ...(old ?? { nodeId: patch.nodeId }) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key]; else next[key] = value;
  }
  return canon(next as Card);
}

/** lib/boardLayout.ts diffBoard: the edits that turn `before` into `after`. */
function diff(before: Layout, after: Layout): Changes {
  const out: Changes = { cards: { upsert: [], remove: [] }, sections: { upsert: [], remove: [] } };
  for (const [id, card] of after.cards) {
    const old = before.cards.get(id);
    const patch = cardPatch(old, card);
    if (patch) out.cards.upsert.push(patch);
  }
  for (const id of before.cards.keys()) if (!after.cards.has(id)) out.cards.remove.push(id);
  for (const [id, s] of after.sections) {
    const old = before.sections.get(id);
    if (!old) { out.sections.upsert.push({ ...s }); continue; }
    const patch: SectionPatch = { id };
    if (old.title !== s.title) patch.title = s.title;
    if (old.x !== s.x || old.y !== s.y) { patch.x = s.x; patch.y = s.y; }
    if (old.width !== s.width || old.height !== s.height) { patch.width = s.width; patch.height = s.height; }
    if (Object.keys(patch).length > 1) out.sections.upsert.push(patch);
  }
  for (const id of before.sections.keys()) if (!after.sections.has(id)) out.sections.remove.push(id);
  return out;
}
const isEmpty = (c: Changes) => !c.cards.upsert.length && !c.cards.remove.length && !c.sections.upsert.length && !c.sections.remove.length;
const wire = (c: Changes) => ({
  ...(c.cards.upsert.length || c.cards.remove.length ? { cards: { upsert: c.cards.upsert, remove: c.cards.remove } } : {}),
  ...(c.sections.upsert.length || c.sections.remove.length ? { sections: { upsert: c.sections.upsert, remove: c.sections.remove } } : {}),
});

const NOTES = 3;
type DeviceId = 0 | 1;

type Op =
  | { kind: "place"; dev: DeviceId; note: number; x: number; y: number }
  | { kind: "move"; dev: DeviceId; pick: number; x: number; y: number }
  | { kind: "resize"; dev: DeviceId; pick: number; width: number; height: number }
  | { kind: "style"; dev: DeviceId; pick: number; color: string; folded: boolean }
  | { kind: "remove"; dev: DeviceId; pick: number }
  | { kind: "section"; dev: DeviceId; slot: number; x: number; y: number }
  | { kind: "unsection"; dev: DeviceId; slot: number }
  | { kind: "retitle"; dev: DeviceId; slot: number; n: number }
  | { kind: "resection"; dev: DeviceId; slot: number; width: number; height: number }
  | { kind: "trash"; note: number }
  | { kind: "restore"; note: number }
  | { kind: "undo"; dev: DeviceId }
  | { kind: "redo"; dev: DeviceId }
  | { kind: "offline"; dev: DeviceId }
  | { kind: "online"; dev: DeviceId }
  | { kind: "sync"; dev: DeviceId };

const dev = fc.constantFrom<DeviceId>(0, 1);
const coord = fc.integer({ min: -500, max: 2000 });
const pick = fc.nat(9);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("place" as const), dev, note: fc.nat(NOTES - 1), x: coord, y: coord }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("move" as const), dev, pick, x: coord, y: coord }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("resize" as const), dev, pick, width: fc.integer({ min: 40, max: 900 }), height: fc.integer({ min: 40, max: 900 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("style" as const), dev, pick, color: fc.constantFrom("red", "blue", "green"), folded: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("remove" as const), dev, pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("section" as const), dev, slot: fc.nat(1), x: coord, y: coord }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unsection" as const), dev, slot: fc.nat(1) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("retitle" as const), dev, slot: fc.nat(1), n: fc.nat(99) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("resection" as const), dev, slot: fc.nat(1), width: fc.integer({ min: 160, max: 900 }), height: fc.integer({ min: 100, max: 700 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("trash" as const), note: fc.nat(NOTES - 1) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("restore" as const), note: fc.nat(NOTES - 1) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("undo" as const), dev }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("redo" as const), dev }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("offline" as const), dev }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("online" as const), dev }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("sync" as const), dev }) },
);

const describeOp = (op: Op) => JSON.stringify(op);

// ── the world: real canvas and notes, two devices, the model server ─────────

let workspaceId = "";
let spaceId = "";
const stamp = Date.now().toString(36);
let runSerial = 0;

class Device {
  layout = emptyLayout();
  undo: Layout[] = [];
  redo: Layout[] = [];
  offline = false;
  queue: Changes[] = [];
}

class World {
  readonly prefix = `BP${stamp}r${runSerial++}-`;
  canvasId = "";
  noteIds: string[] = [];
  /** What the server stores, per card (a trashed note's card stays stored). */
  stored: Layout = emptyLayout();
  live = new Set<number>();
  devices = [new Device(), new Device()];
  trace: string[] = [];
  /** What each device last meant for every card it ever changed (invariant 4);
   *  undefined = removed. Never cleared: a sync does not undo what was meant. */
  intent: [Map<string, Card | undefined>, Map<string, Card | undefined>] = [new Map(), new Map()];
  record(which: DeviceId, changes: Changes): void {
    for (const c of changes.cards.upsert) this.intent[which].set(c.nodeId, applyPatch(this.intent[which].get(c.nodeId), c));
    for (const id of changes.cards.remove) this.intent[which].set(id, undefined);
  }

  log(line: string) { this.trace.push(line); }
  fail(message: string): never { throw new Error(`${message}\n--- trace ---\n${this.trace.join("\n")}`); }

  async setup(): Promise<void> {
    const c = await call("/api/canvases", "POST", { title: `${this.prefix}canvas`, space_id: spaceId });
    if (c.status !== 201) this.fail(`create canvas: ${c.status} ${JSON.stringify(c.body)}`);
    this.canvasId = c.body.id;
    for (let i = 0; i < NOTES; i++) {
      const n = await call("/api/nodes", "POST", { space_id: spaceId, title: `${this.prefix}note${i}`, markdown: "x" });
      if (n.status !== 201) this.fail(`create note: ${n.status} ${JSON.stringify(n.body)}`);
      this.noteIds.push(n.body.id);
      this.live.add(i);
    }
  }

  /** Drop this run's rows now: thousands of runs would otherwise leave one cleanup too big for a statement. */
  async cleanup(): Promise<void> {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [this.canvasId, ...this.noteIds]]);
  }

  noteIndex(id: string) { return this.noteIds.indexOf(id); }

  /** The model server's side of one change: what a user means, also for a
   *  note in the trash (the write lands, the removal removes). */
  applyToStored(changes: Changes): void {
    for (const card of changes.cards.upsert) {
      const next = applyPatch(this.stored.cards.get(card.nodeId), card);
      if (next) this.stored.cards.set(card.nodeId, next);
    }
    const upserted = new Set(changes.cards.upsert.map((c) => c.nodeId));
    for (const id of changes.cards.remove) if (!upserted.has(id)) this.stored.cards.delete(id);
    for (const id of changes.sections.remove) this.stored.sections.delete(id);
    // services/boardWrites.ts mergeSections: patched by field; a frame not stored needs its whole geometry.
    for (const p of changes.sections.upsert) {
      const old = this.stored.sections.get(p.id);
      const next = { ...old, ...p } as Partial<Section>;
      if (old || (next.x !== undefined && next.y !== undefined && next.width !== undefined && next.height !== undefined)) this.stored.sections.set(p.id, next as Section);
    }
  }

  async send(changes: Changes): Promise<void> {
    if (isEmpty(changes)) return;
    const r = await call(`/api/boards/${this.canvasId}`, "PATCH", wire(changes));
    if (r.status !== 200) this.fail(`PATCH board answered ${r.status} ${JSON.stringify(r.body)} for ${JSON.stringify(wire(changes))}`);
    this.applyToStored(changes);
  }

  /** What GET shows: stored cards of live notes. */
  visible(): { cards: Card[]; sections: Section[] } {
    const cards = [...this.stored.cards.values()].filter((c) => this.live.has(this.noteIndex(c.nodeId)));
    return { cards, sections: [...this.stored.sections.values()] };
  }

  async serverLayout(): Promise<{ cards: Card[]; sections: Section[] }> {
    const r = await call(`/api/canvases/${this.canvasId}`);
    if (r.status !== 200) this.fail(`GET canvas answered ${r.status} ${JSON.stringify(r.body)}`);
    const b = await call(`/api/boards/${this.canvasId}`);
    if (b.status !== 200) this.fail(`GET board answered ${b.status} ${JSON.stringify(b.body)}`);
    const norm = (cards: Card[]) => cards.map(canon).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
    const sections = (list: Section[]) => list.map(canonSection).sort((a, z) => a.id.localeCompare(z.id));
    const viaCanvas = { cards: norm(r.body.data.nodes), sections: sections(r.body.data.sections ?? []) };
    const viaBoard = { cards: norm(b.body.cards), sections: sections(b.body.sections) };
    if (!same(viaCanvas.cards, viaBoard.cards) || !same(viaCanvas.sections, viaBoard.sections)) {
      this.fail(`#2 GET /api/canvases and GET /api/boards disagree:\n${JSON.stringify(viaCanvas)}\n${JSON.stringify(viaBoard)}`);
    }
    return viaCanvas;
  }

  cardsOf(d: Device): Card[] { return [...d.layout.cards.values()]; }

  /** A device edits its layout; the change is sent now, or queued offline. */
  async edit(which: DeviceId, mutate: (layout: Layout) => void): Promise<void> {
    const d = this.devices[which]!;
    const before = cloneLayout(d.layout);
    mutate(d.layout);
    const changes = diff(before, d.layout);
    if (isEmpty(changes)) return;
    d.undo.push(before);
    d.redo = [];
    this.record(which, changes);
    if (d.offline) d.queue.push(changes); else await this.send(changes);
  }

  async step(op: Op): Promise<void> {
    this.log(describeOp(op));
    const idOf = (i: number) => this.noteIds[i]!;
    switch (op.kind) {
      case "place": {
        const d = this.devices[op.dev]!;
        if (d.layout.cards.has(idOf(op.note))) return;
        await this.edit(op.dev, (l) => l.cards.set(idOf(op.note), { nodeId: idOf(op.note), x: op.x, y: op.y }));
        return;
      }
      case "move": case "resize": case "style": case "remove": {
        const cards = this.cardsOf(this.devices[op.dev]!);
        if (!cards.length) return;
        const card = cards[op.pick % cards.length]!;
        await this.edit(op.dev, (l) => {
          if (op.kind === "remove") l.cards.delete(card.nodeId);
          else if (op.kind === "move") l.cards.set(card.nodeId, { ...card, x: op.x, y: op.y });
          else if (op.kind === "resize") l.cards.set(card.nodeId, { ...card, width: op.width, height: op.height });
          else l.cards.set(card.nodeId, { ...card, color: op.color, folded: op.folded });
        });
        return;
      }
      case "section": {
        const id = `sec-${op.slot}`;
        // A frame this device already has is moved (its name and size stay); otherwise a new one is made.
        await this.edit(op.dev, (l) => l.sections.set(id, { ...(l.sections.get(id) ?? { id, width: 300, height: 200, title: `S${op.slot}` }), x: op.x, y: op.y }));
        return;
      }
      case "retitle": case "resection": {
        const id = `sec-${op.slot}`;
        await this.edit(op.dev, (l) => {
          const old = l.sections.get(id);
          if (!old) return;
          l.sections.set(id, op.kind === "retitle" ? { ...old, title: `T${op.n}` } : { ...old, width: op.width, height: op.height });
        });
        return;
      }
      case "unsection": await this.edit(op.dev, (l) => { l.sections.delete(`sec-${op.slot}`); }); return;
      case "trash": {
        if (!this.live.has(op.note)) return;
        const r = await call(`/api/nodes/${idOf(op.note)}`, "DELETE");
        if (r.status !== 200) this.fail(`trash note: ${r.status} ${JSON.stringify(r.body)}`);
        this.live.delete(op.note);
        return;
      }
      case "restore": {
        if (this.live.has(op.note)) return;
        const r = await call(`/api/nodes/${idOf(op.note)}/undelete`, "POST");
        if (r.status !== 200) this.fail(`restore note: ${r.status} ${JSON.stringify(r.body)}`);
        this.live.add(op.note);
        return;
      }
      case "undo": case "redo": {
        const d = this.devices[op.dev]!;
        const from = op.kind === "undo" ? d.undo : d.redo;
        const to = op.kind === "undo" ? d.redo : d.undo;
        const target = from.pop();
        if (!target) return;
        to.push(cloneLayout(d.layout));
        const changes = diff(d.layout, target);
        d.layout = cloneLayout(target);
        this.record(op.dev, changes);
        if (d.offline) d.queue.push(changes); else await this.send(changes);
        return;
      }
      case "offline": this.devices[op.dev]!.offline = true; return;
      case "online": await this.goOnline(op.dev); return;
      case "sync": await this.sync(op.dev); return;
    }
  }

  async goOnline(which: DeviceId): Promise<void> {
    const d = this.devices[which]!;
    d.offline = false;
    for (const changes of d.queue.splice(0)) await this.send(changes);
  }

  /** The device takes the server's layout, but keeps changes still queued. */
  async sync(which: DeviceId): Promise<void> {
    const d = this.devices[which]!;
    if (d.offline) return;
    const server = await this.serverLayout();
    d.layout = emptyLayout();
    for (const c of server.cards) d.layout.cards.set(c.nodeId, c);
    for (const s of server.sections) d.layout.sections.set(s.id, s);
    // History is of local layouts: after taking the server's, an undo would
    // rewind to a layout the server no longer has, so it starts over.
    d.undo = []; d.redo = [];
  }

  async checkAgainstModel(where: string): Promise<void> {
    const server = await this.serverLayout();
    const expected = this.visible();
    const key = (cards: Card[]) => cards.map(canon).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
    if (!same(server.cards, key(expected.cards))) {
      this.fail(`#2 after ${where}: server cards\n${JSON.stringify(server.cards)}\nmodel cards\n${JSON.stringify(key(expected.cards))}`);
    }
    const byId = (s: Section[]) => s.map(canonSection).sort((a, z) => a.id.localeCompare(z.id));
    if (!same(byId(server.sections), byId(expected.sections))) {
      this.fail(`#2 after ${where}: server sections ${JSON.stringify(server.sections)} model ${JSON.stringify(expected.sections)}`);
    }
    const live = new Set(this.noteIds.filter((_, i) => this.live.has(i)));
    for (const c of server.cards) if (!live.has(c.nodeId)) this.fail(`#3 after ${where}: card ${c.nodeId} points at a trashed or missing note`);
    // #7 replaying structure_log (causal-stamps S2) gives the cards and the section frames the tables hold now
    const replay = [...await boardCardProblems(workspaceId, this.canvasId), ...await boardSectionProblems(workspaceId, this.canvasId)];
    if (replay.length) this.fail(`#7 after ${where}: ${replay.join("; ")}`);
  }

  /** Both devices online, queues replayed, synced: nothing of either is lost. */
  async finish(): Promise<void> {
    await this.goOnline(0);
    await this.goOnline(1);
    await this.checkAgainstModel("replaying queued changes");
    // #4: a card only ONE device ever changed, whose note is live, ends as that
    // device last meant it, whatever the other device did meanwhile.
    const server = await this.serverLayout();
    const at = new Map(server.cards.map((c) => [c.nodeId, c]));
    for (const which of [0, 1] as const) {
      for (const [id, mine] of this.intent[which]) {
        if (this.intent[which === 0 ? 1 : 0].has(id) || !this.live.has(this.noteIndex(id))) continue;
        if (!same(at.get(id) ? canon(at.get(id)!) : undefined, mine)) {
          this.fail(`#4 device ${which} alone changed card ${id}, last meant ${JSON.stringify(mine)}, the server holds ${JSON.stringify(at.get(id))}`);
        }
      }
    }
    await this.sync(0);
    await this.sync(1);
    for (const which of [0, 1] as const) {
      const d = this.devices[which]!;
      const keep = (cards: Card[]) => cards.map(canon).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
      const mine = keep(this.cardsOf(d));
      if (!same(mine, keep(server.cards))) this.fail(`#6 device ${which} holds ${JSON.stringify(mine)} after sync, the server ${JSON.stringify(server.cards)}`);
    }
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

// File level, not inside one describe: tests run in any order and the pool closes once, at the end of the file.
beforeAll(async () => {
  if (!isTestDb) return;
  await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
  workspaceId = await getWorkspaceId();
  await q(`INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'System','agent','system') ON CONFLICT(workspace_id,external_id) DO NOTHING`, [workspaceId]);
  const systemId = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!.id;
  await joinDefaultSpace(workspaceId, systemId, "admin");
  spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
});

afterAll(async () => {
  if (!isTestDb) return;
  await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [workspaceId, `BP${stamp}%`]);
  await pool.end();
}, 300_000);

const SERIES = fc.array(opArb, { minLength: 1, maxLength: 24 });
describe.skipIf(!isTestDb)("whiteboard writes: random operations, two devices (DB)", () => {
  async function run(ops: Op[]): Promise<void> {
    const world = new World();
    await world.setup();
    try {
      for (const op of ops) {
        await world.step(op);
        await world.checkAgainstModel(describeOp(op));
      }
      await world.finish();
    } finally { await world.cleanup(); }
  }

  it("random placements, moves, resizes, removals, trash and undo keep server, devices and model equal", async () => {
    await checkAsync(fc.asyncProperty(SERIES, async (ops) => { await run(ops); }), RUN_CAP);
  }, TIMEOUT);

  // KNOWN A. applyBoardChanges used to filter removals through live notes
  // only, so a removal naming a trashed note's card was skipped without a word
  // and the node_positions row survived.
  it("KNOWN A: removing a card whose note is in the trash is ignored, so the card is back when the note is restored", async () => {
    const world = new World();
    await world.setup();
    const ops: Op[] = [
      { kind: "place", dev: 0, note: 0, x: 10, y: 10 },
      { kind: "sync", dev: 1 },
      { kind: "trash", note: 0 },
      { kind: "remove", dev: 1, pick: 0 },
      { kind: "restore", note: 0 },
    ];
    for (const op of ops) await world.step(op);
    const server = await world.serverLayout();
    expect(server.cards, "the user removed this card; it must not return on restore").toEqual([]);
  }, 30_000);

  // KNOWN B. Same filter on upserts: a placement / move naming a trashed note was
  // dropped with a 200 (`cards: 0`), e.g. device 2 trashed the note while device 1
  // was offline; once the note was restored the card the user placed was missing.
  it("KNOWN B: placing a card for a note trashed meanwhile answers 200 and is lost after restore", async () => {
    const world = new World();
    await world.setup();
    const ops: Op[] = [
      { kind: "trash", note: 0 },
      { kind: "place", dev: 0, note: 0, x: 10, y: 10 },
      { kind: "restore", note: 0 },
    ];
    for (const op of ops) await world.step(op);
    const server = await world.serverLayout();
    expect(server.cards.map((c) => c.nodeId), "the placement was accepted (200); it must be there after restore").toEqual([world.noteIds[0]]);
  }, 30_000);

  it("a single device: undo to the bottom, then redo to the top, passes through every layout", async () => {
    const single = fc.array(fc.oneof(
      fc.record({ kind: fc.constant("place" as const), dev: fc.constant<DeviceId>(0), note: fc.nat(NOTES - 1), x: coord, y: coord }),
      fc.record({ kind: fc.constant("move" as const), dev: fc.constant<DeviceId>(0), pick, x: coord, y: coord }),
      fc.record({ kind: fc.constant("resize" as const), dev: fc.constant<DeviceId>(0), pick, width: fc.integer({ min: 40, max: 900 }), height: fc.integer({ min: 40, max: 900 }) }),
      fc.record({ kind: fc.constant("remove" as const), dev: fc.constant<DeviceId>(0), pick }),
    ), { minLength: 1, maxLength: 12 });
    await checkAsync(fc.asyncProperty(single, async (ops) => {
      const world = new World();
      await world.setup();
      try {
      const states: string[] = [JSON.stringify(world.visible())];
      for (const op of ops) {
        await world.step(op);
        const s = JSON.stringify(world.visible());
        if (s !== states[states.length - 1]) states.push(s);
      }
      const d = world.devices[0]!;
      const steps = d.undo.length;
      for (let i = steps - 1; i >= 0; i--) {
        await world.step({ kind: "undo", dev: 0 });
        await world.checkAgainstModel(`undo ${steps - i}`);
        const server = await world.serverLayout();
        const want = JSON.parse(states[i]!) as { cards: Card[] };
        const norm = (c: Card[]) => c.map(canon).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
        if (!same(norm(want.cards), server.cards)) world.fail(`#5 undo ${steps - i} did not return to the previous layout:\n${JSON.stringify(norm(want.cards))}\n${JSON.stringify(server.cards)}`);
      }
      for (let i = 0; i < steps; i++) await world.step({ kind: "redo", dev: 0 });
      await world.checkAgainstModel("redo to the top");
      const top = JSON.parse(states[states.length - 1]!) as { cards: Card[] };
      const server = await world.serverLayout();
      const norm = (c: Card[]) => c.map(canon).sort((a, z) => a.nodeId.localeCompare(z.nodeId));
      if (!same(norm(top.cards), server.cards)) world.fail(`#5 redo to the top did not return to the last layout:\n${JSON.stringify(norm(top.cards))}\n${JSON.stringify(server.cards)}`);
      } finally { await world.cleanup(); }
    }), RUN_CAP);
  }, TIMEOUT);
});

// ── settings of one board (layout_config), two devices ───────────────────────
//
// A whiteboard's settings (tree, card display, folds, hidden…) are keys of the whiteboard tab's layout_config.
// A change names only its keys (`layout_config_patch`: a value sets the key, null removes it); the server applies
// them to the row as it is NOW, so a key another device set after this device read its copy survives.
// The older whole-object `layout_config` still replaces everything (older clients, backup restore).
// Model: a plain object; a patch is `{...model, set}` minus nulls, a whole write is the new model.

type SettingsOp =
  | { kind: "patch"; dev: 0 | 1; key: string; value: number | null }
  | { kind: "whole"; dev: 0 | 1; config: Record<string, number> };
const SETTING_KEYS = ["tree", "display", "hidden", "opens_first"];
const settingsOpArb: fc.Arbitrary<SettingsOp> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("patch" as const), dev: fc.constantFrom<0 | 1>(0, 1), key: fc.constantFrom(...SETTING_KEYS), value: fc.oneof(fc.nat(9), fc.constant(null)) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("whole" as const), dev: fc.constantFrom<0 | 1>(0, 1), config: fc.dictionary(fc.constantFrom(...SETTING_KEYS), fc.nat(9)) }) },
);

describe.skipIf(!isTestDb)("whiteboard settings: per-key patches from two devices (DB)", () => {
  async function newBoardTab(): Promise<{ noteId: string; viewId: string; path: string; cleanup: () => Promise<void> }> {
    const n = await call("/api/nodes", "POST", { space_id: spaceId, title: `BP${stamp}s${runSerial++}-settings`, markdown: "x" });
    if (n.status !== 201) throw new Error(`create note: ${n.status} ${JSON.stringify(n.body)}`);
    const noteId: string = n.body.id;
    const v = await call(`/api/nodes/${noteId}/views`, "POST", { name: "Canvas", layout: "canvas", layout_config: { opens_first: true } });
    if (v.status !== 201) throw new Error(`create tab: ${v.status} ${JSON.stringify(v.body)}`);
    const viewId: string = v.body.id;
    return {
      noteId, viewId, path: `/api/nodes/${noteId}/views/${viewId}`,
      cleanup: async () => { await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, noteId]); },
    };
  }
  async function stored(noteId: string, viewId: string): Promise<{ layout_config: Record<string, unknown>; name: string; pin_order: number }> {
    const r = await call(`/api/nodes/${noteId}/views`);
    return r.body.views.find((x: { id: string }) => x.id === viewId);
  }

  it("random patches and whole writes from two devices end as the model says", async () => {
    await checkAsync(fc.asyncProperty(fc.array(settingsOpArb, { minLength: 1, maxLength: 16 }), async (ops) => {
      const tab = await newBoardTab();
      try {
        let model: Record<string, unknown> = { opens_first: true };
        for (const op of ops) {
          if (op.kind === "patch") {
            const r = await call(tab.path, "PATCH", { layout_config_patch: { [op.key]: op.value } });
            if (r.status !== 200) throw new Error(`patch: ${r.status} ${JSON.stringify(r.body)}`);
            if (op.value === null) delete model[op.key]; else model = { ...model, [op.key]: op.value };
          } else {
            const r = await call(tab.path, "PATCH", { layout_config: op.config });
            if (r.status !== 200) throw new Error(`whole: ${r.status} ${JSON.stringify(r.body)}`);
            model = { ...op.config };
          }
          const now = await stored(tab.noteId, tab.viewId);
          if (!same(Object.entries(now.layout_config).sort(), Object.entries(model).sort())) {
            throw new Error(`after ${JSON.stringify(op)} the server holds ${JSON.stringify(now.layout_config)}, the model ${JSON.stringify(model)}`);
          }
          if (now.name !== "Canvas") throw new Error("a settings write changed the tab's name");
        }
      } finally { await tab.cleanup(); }
    }), RUN_CAP);
  }, TIMEOUT);

  it("fixed case: device A saves `tree` while device B's `display` (set after A read the tab) stays", async () => {
    const tab = await newBoardTab();
    try {
      // Both devices read { opens_first } and then each changes a different setting.
      expect((await call(tab.path, "PATCH", { layout_config_patch: { display: { cardDefault: "folded" } } })).status).toBe(200);
      expect((await call(tab.path, "PATCH", { layout_config_patch: { tree: { mode: "manual" } } })).status).toBe(200);
      expect((await stored(tab.noteId, tab.viewId)).layout_config).toEqual({
        opens_first: true, display: { cardDefault: "folded" }, tree: { mode: "manual" },
      });
    } finally { await tab.cleanup(); }
  }, 30_000);

  it("fixed case: null removes a key (a hidden tab shown again), the other keys stay", async () => {
    const tab = await newBoardTab();
    try {
      await call(tab.path, "PATCH", { layout_config_patch: { hidden: true } });
      await call(tab.path, "PATCH", { layout_config_patch: { hidden: null } });
      expect((await stored(tab.noteId, tab.viewId)).layout_config).toEqual({ opens_first: true });
    } finally { await tab.cleanup(); }
  }, 30_000);

  it("fixed case: the same key from two devices is last write wins, and the value is replaced whole (not merged inside)", async () => {
    const tab = await newBoardTab();
    try {
      await call(tab.path, "PATCH", { layout_config_patch: { tree: { mode: "auto", depth: 2 } } });
      await call(tab.path, "PATCH", { layout_config_patch: { tree: { mode: "manual" } } });
      expect((await stored(tab.noteId, tab.viewId)).layout_config.tree).toEqual({ mode: "manual" });
    } finally { await tab.cleanup(); }
  }, 30_000);

  it("fixed case: a whole-object write from an older client is still accepted and replaces the config; both forms in one request are refused", async () => {
    const tab = await newBoardTab();
    try {
      await call(tab.path, "PATCH", { layout_config_patch: { tree: { mode: "manual" } } });
      expect((await call(tab.path, "PATCH", { layout_config: { opens_first: true } })).status).toBe(200);
      expect((await stored(tab.noteId, tab.viewId)).layout_config).toEqual({ opens_first: true });
      const both = await call(tab.path, "PATCH", { layout_config: {}, layout_config_patch: { tree: 1 } });
      expect(both.status).toBe(400);
      expect((await stored(tab.noteId, tab.viewId)).layout_config).toEqual({ opens_first: true });
    } finally { await tab.cleanup(); }
  }, 30_000);
});
