// One simulated device of the two-device sync simulator (see syncSim/README
// in the test header). It copies what the real client does at the HTTP
// boundary, not its internals:
//
//  * Writes go through the note writer's requests (frontend lib/data/noteWriter,
//    tagWriter, noteHistoryWriter, propertyWriter, taskWriter, graphPositionWriter, inkWriter): POST /api/nodes, PATCH /api/nodes/:id,
//    DELETE, POST …/undelete, PUT/DELETE …/tags/:tagId, PUT/DELETE …/attributes/:key, POST /api/nodes/:id/tasks, PATCH /api/tasks/:id, PUT /api/nodes/:id/position, PUT …/attributes/ink_data (a drawing: value + base_value). Each carries an
//    Idempotency-Key and is sent at once when online and the queue is empty,
//    otherwise queued (writeQueue.submitWrite).
//  * Standalone tasks, saved views, the review panel and a note's review-card switch are copied from the writers named at each
//    method below (taskWriter.createStandaloneTask, viewWriter, modules/review/ReviewPanel.tsx and reviewCard.ts). Review, view create /
//    delete and the card switch are ONLINE decisions (sendWrite / onlineWrite): never queued, a lost reply keeps the intent and
//    the next attempt reuses its Idempotency-Key.
//  * The queue drains in order (writeQueue.drain): a network failure stops the
//    drain and keeps the write for a retry with the SAME key; a 4xx refusal is
//    set aside (preserveRejectedWrite) and the drain continues.
//  * A body save sends the editor's whole draft plus `base_markdown`, the
//    server text the draft derives from (draftActions.baseFor / `bases`).
//  * sync() is POST /api/sync {since} in hops until caught up (syncEngine.sync),
//    applying `nodes.upsert` / `nodes.delete` and `attributes.upsert` / `attributes.delete`
//  * Positions are NOT in the delta (the server writes them with no event). A device gets other
//    devices' positions from GET /api/bootstrap?nodes=none, which replaces its `graph_positions`
//    (syncEngine.refreshMeta, run after a reconnect's sync by connectivity.refreshIfStale).
//    and `tasks.upsert` / `tasks.delete` to the device's copy (storeOps.applySyncDelta: a node row replaces the whole row, attrs
//    included; the attribute channel then patches the node's `attrs` map key by key).
import { randomUUID } from "node:crypto";
import { decodeInk, encodeInk, mergeIntervals, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import type { SimServer, Fate, Reply } from "./server.js";

export type Row = {
  id: string; title: string; markdown: string; parent_id: string | null; node_type: string;
  label_tag_ids?: string[]; attrs?: Record<string, string>; [key: string]: unknown;
};
/** A task row as the device holds it (the server's synthesized row, services/tasksStore TaskRow). */
export type TaskRow = { id: string; node_id: string | null; title: string; status: string; when_date: string | null; recur: string | null; [key: string]: unknown };
export type PendingWrite = { method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"; path: string; body: Record<string, unknown> | null; idemKey: string };
/** What a note looks like on this device: the synced copy with its own queued writes on top. */
export type NoteView = { id: string; title: string; markdown: string; parent_id: string | null; tags: string[] };

/** One card on a board as the layout carries it (frontend CanvasNodeEntry): optional fields are absent when unset. */
export type Card = { nodeId: string; x: number; y: number; width?: number; height?: number; color?: string; folded?: boolean };
/** boardLayout.cardPatch: the fields of `card` that differ from `old` (absent = unchanged, null = cleared); a card the server may not have is sent whole. */
function cardPatch(old: Card | undefined, card: Card): Record<string, unknown> | null {
  const patch: Record<string, unknown> = { nodeId: card.nodeId };
  if (!old || old.x !== card.x || old.y !== card.y) { patch.x = card.x; patch.y = card.y; }
  for (const key of ["width", "height", "color"] as const) {
    if ((old?.[key] ?? null) !== (card[key] ?? null)) patch[key] = card[key] ?? null;
  }
  if (!!old?.folded !== !!card.folded) patch.folded = !!card.folded;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** Whose saved views (viewOwner.ViewOwner): a tag's or a note's. */
export type ViewOwnerKey = { kind: "tag" | "node"; id: string };
const viewOwnerPath = (owner: ViewOwnerKey) => `/api/${owner.kind === "tag" ? "tags" : "nodes"}/${encodeURIComponent(owner.id)}`;
export const ownerSlot = (owner: ViewOwnerKey) => `${owner.kind}:${owner.id}`;
const slotOwner = (slot: string): ViewOwnerKey => ({ kind: slot.startsWith("tag:") ? "tag" : "node", id: slot.slice(slot.indexOf(":") + 1) });

export const SPACE_NODE_TYPES = new Set(["content"]);

export class SimClient {
  online = true;
  readonly queue: PendingWrite[] = [];
  /** Idempotency-Keys of the writes this device made, in the order it made them (writeQueue's order guarantee is judged on it). */
  readonly submitted: string[] = [];
  readonly rejected: Array<{ write: PendingWrite; status: number }> = [];
  /** The device's copy of the server, built only from sync deltas and write responses. */
  readonly mirror = new Map<string, Row>();
  /** The device's task rows (the store's `tasks`), from write answers and sync deltas. */
  readonly tasks = new Map<string, TaskRow>();
  /** The open drawing surface per note (OverviewEditor): what is on screen and the drawing the next save
   *  was made from — what loaded, then each save sent (`inkBaseRef`). Loaded once, when first needed. */
  private readonly surfaces = new Map<string, { doc: InkDocument | null; base: InkDocument | null }>();
  /** The boards (notes with a whiteboard) this device has opened: the cards it shows, from GET /api/boards/:id plus its own changes
   *  (canvasWriter's `layouts`). A layout never travels in the sync delta: it is read again when the board is opened. */
  readonly layouts = new Map<string, Map<string, Card>>();
  /** The device's hand-placed graph positions (the store's `graph_positions`). */
  positions = new Map<string, { x: number; y: number }>();
  /** Notes this device deleted (for the undo toast; the server restores what it took along). */
  readonly trashed = new Map<string, NoteView[]>();
  cursor: string;
  /** Request headers that say who this device's person is (members runs); empty = the native-origin account. */
  headers: Record<string, string> = {};
  /** Members runs: this device runs the membership reconcile (syncEngine.maybeReconcileMembership). Off in the single-account runs,
   *  where the whole shared workspace of earlier runs would be fetched for nothing. */
  membershipAware = false;
  /** Members runs: network faults may also hit the membership check. Off in the property run: a lost check followed by a
   *  re-add of the member leaves the device stale (REGRESSIONS names the case); the pinned case turns it on. */
  membershipFaults = false;
  /** The membership epoch the device last reconciled to (null = never: the first sync always reconciles). */
  epoch: number | null = null;
  /** Review panel (ReviewPanel.tsx): the queue this device last read (GET /api/review/queue), with the reps each card showed;
   *  the card it just graded (undo's target); a grade or undo whose reply was lost (retried with the same key). */
  readonly reviewQueue = new Map<string, { reps: number }>();
  reviewLastGraded: string | null = null;
  /** The panel has been opened once: grading before that reads the queue first, the way opening the screen does. */
  private reviewOpened = false;
  /** What each grade request was made from: the card and the reps it showed (the invariants' "one human action"). */
  readonly gradeShown = new Map<string, { card: string; shown: number }>();
  /** The person's own schedule per card, as GET /api/review/:id/state last answered (null = no schedule). */
  readonly reviewStates = new Map<string, { reps: number; lapses: number; due: string } | null>();
  /** Direct (online-only) writes whose reply was lost: the person presses the same button again, with the same key. */
  private readonly unconfirmed: Array<{ write: PendingWrite; done: (reply: Reply) => void }> = [];
  /** Saved views as the owner's screens last read them (GET …/views), by owner "tag:<id>" / "node:<id>". */
  readonly viewLists = new Map<string, Array<Record<string, unknown> & { id: string }>>();
  /** The editor's state per note: the text/title on screen and the server text it derives from. */
  private readonly texts = new Map<string, { draft: string; base: string; title: string }>();

  /** `cursor`: where this device's copy starts. The simulator's workspace is shared by many runs, so a
   *  run starts at "now" instead of replaying everything (a device that already synced up to here). */
  constructor(readonly name: string, private readonly server: SimServer, private readonly spaceId: string, cursor: string) { this.cursor = cursor; }

  // ── What the user sees ──────────────────────────────────────────────────
  view(): Map<string, NoteView> {
    const notes = new Map<string, NoteView>();
    for (const row of this.mirror.values()) {
      if (row.node_type !== "content") continue;
      notes.set(row.id, { id: row.id, title: row.title, markdown: row.markdown, parent_id: row.parent_id, tags: [...(row.label_tag_ids ?? [])] });
    }
    for (const w of this.queue) {
      const id = noteIdOf(w.path);
      if (w.method === "POST" && w.path === "/api/nodes") {
        const b = w.body!;
        notes.set(b.id as string, { id: b.id as string, title: b.title as string, markdown: (b.markdown as string) ?? "", parent_id: (b.parent_id as string | undefined) ?? null, tags: [] });
      } else if (w.method === "PATCH" && id && notes.has(id)) {
        Object.assign(notes.get(id)!, pick(w.body!, ["title", "markdown", "parent_id"]));
      } else if (w.method === "DELETE" && NOTE_PATH.test(w.path) && id) {
        notes.delete(id); // storeOps.dropNode: the note alone; its children stay until the server says otherwise
      } else if (w.method === "POST" && w.path.endsWith("/undelete") && id) {
        for (const back of this.trashed.get(id) ?? []) notes.set(back.id, { ...back, tags: [...back.tags] });
      } else if (w.path.includes("/tags/") && id && notes.has(id)) {
        const tagId = w.path.split("/tags/")[1]!;
        const n = notes.get(id)!;
        n.tags = w.method === "PUT" ? [...new Set([...n.tags, tagId])] : n.tags.filter((t) => t !== tagId);
      }
    }
    return notes;
  }

  textOf(id: string): { draft: string; base: string; title: string } {
    const known = this.texts.get(id);
    if (known) return known;
    const note = this.view().get(id)!;
    return { draft: note.markdown, base: note.markdown, title: note.title };
  }

  /** The tasks the user sees: the synced rows with this device's queued task writes on top
   *  (taskWriter shows a created task and a patch at once). */
  taskView(): Map<string, TaskRow> {
    const out = new Map([...this.tasks].map(([id, row]) => [id, { ...row }]));
    for (const w of this.queue) {
      if (w.method === "POST" && /^\/api\/nodes\/[0-9a-f-]{36}\/tasks$/.test(w.path)) {
        const b = w.body!;
        out.set(b.id as string, { id: b.id as string, node_id: noteIdOf(w.path), title: b.title as string, status: "todo", when_date: (b.when_date as string | undefined) ?? null, recur: (b.recur as string | undefined) ?? null });
      } else if (w.method === "POST" && w.path === "/api/tasks") {
        const b = w.body!;
        out.set(b.id as string, { id: b.id as string, node_id: null, title: b.title as string, status: "todo", when_date: (b.when_date as string | undefined) ?? null, recur: null });
      } else if (w.method === "PATCH" && TASK_PATH.test(w.path)) {
        const row = out.get(taskIdOf(w.path)!);
        if (row) Object.assign(row, pick(w.body!, ["status", "when_date"]));
      }
    }
    return out;
  }

  // ── User actions: each one is a write ──────────────────────────────────
  create(id: string, title: string, markdown: string, parentId: string | null, fate: Fate): Promise<unknown> {
    this.texts.set(id, { draft: markdown, base: markdown, title });
    return this.submit({
      method: "POST", path: "/api/nodes", idemKey: randomUUID(),
      body: { id, title, markdown, source_type: "manual", node_type: "content", ...(parentId ? { parent_id: parentId } : { space_id: this.spaceId }) },
    }, fate);
  }

  /** The editor's autosave: title + whole draft, with the base it derives from. */
  async saveBody(id: string, draft: string, fate: Fate): Promise<void> {
    const text = this.textOf(id);
    const write: PendingWrite = {
      method: "PATCH", path: `/api/nodes/${id}`, idemKey: randomUUID(),
      body: { title: text.title, markdown: draft, base_markdown: text.base },
    };
    const outcome = await this.submit(write, fate);
    // The server holds (at least) what we sent, or the write is durably queued: the next save
    // builds on it (draftActions `bases`). A direct refusal throws before that, so the draft stays
    // unsaved on the old base.
    this.texts.set(id, { draft, base: outcome === "rejected" ? text.base : draft, title: text.title });
  }

  rename(id: string, title: string, fate: Fate): Promise<unknown> {
    const text = this.textOf(id);
    this.texts.set(id, { ...text, title });
    return this.submit({ method: "PATCH", path: `/api/nodes/${id}`, body: { title }, idemKey: randomUUID() }, fate);
  }
  move(id: string, parentId: string | null, fate: Fate): Promise<unknown> {
    return this.submit({ method: "PATCH", path: `/api/nodes/${id}`, body: { parent_id: parentId }, idemKey: randomUUID() }, fate);
  }
  remove(id: string, fate: Fate): Promise<unknown> {
    const note = this.view().get(id);
    if (note) this.trashed.set(id, [{ ...note, tags: [...note.tags] }]);
    return this.submit({ method: "DELETE", path: `/api/nodes/${id}`, body: null, idemKey: randomUUID() }, fate);
  }
  undelete(id: string, fate: Fate): Promise<unknown> {
    return this.submit({ method: "POST", path: `/api/nodes/${id}/undelete`, body: null, idemKey: randomUUID() }, fate);
  }
  /** propertyWriter.change: PUT with the edit time (`client_updated_at`); a write made while
   *  offline carries the time it was made, which is long before the replay (`ageMs`). */
  setAttr(id: string, key: string, value: string, fate: Fate): Promise<unknown> {
    const editedAt = new Date(Date.now() - (this.online ? 0 : OFFLINE_EDIT_AGE_MS)).toISOString();
    return this.submit({
      method: "PUT", path: `/api/nodes/${id}/attributes/${encodeURIComponent(key)}`, idemKey: randomUUID(),
      body: { value, value_type: "text", is_inheritable: false, client_updated_at: editedAt },
    }, fate);
  }
  removeAttr(id: string, key: string, fate: Fate): Promise<unknown> {
    return this.submit({ method: "DELETE", path: `/api/nodes/${id}/attributes/${encodeURIComponent(key)}`, body: null, idemKey: randomUUID() }, fate);
  }
  /** taskWriter.create: the id is minted here and is the Idempotency-Key. */
  createTask(id: string, noteId: string, title: string, fields: { when?: string; recur?: string }, fate: Fate): Promise<unknown> {
    return this.submit({
      method: "POST", path: `/api/nodes/${noteId}/tasks`, idemKey: id,
      body: { id, title, ...(fields.when ? { when_date: fields.when } : {}), ...(fields.recur ? { recur: fields.recur } : {}) },
    }, fate);
  }
  /** taskWriter.patch: only the changed fields, under the server's names (`null` clears). */
  patchTask(id: string, changes: Record<string, unknown>, fate: Fate): Promise<unknown> {
    return this.submit({ method: "PATCH", path: `/api/tasks/${id}`, body: changes, idemKey: randomUUID() }, fate);
  }
  /** graphPositionWriter.place: the position shows at once; the PUT carries surface 'graph'. */
  place(id: string, x: number, y: number, fate: Fate): Promise<unknown> {
    this.positions.set(id, { x, y });
    return this.submit({ method: "PUT", path: `/api/nodes/${id}/position`, body: { surface: "graph", x, y }, idemKey: randomUUID() }, fate);
  }
  // ── Board cards (lib/data/canvasWriter.change, boardLayout.diffBoard) ──
  /** canvasWriter.fetchBoard: the board's layout, read when it is opened (online); a refused or missing board has none. */
  async openBoard(boardId: string, force = false): Promise<void> {
    if (!this.online || (this.layouts.has(boardId) && !force)) return;
    const reply = await this.server.send(this.name, { method: "GET", path: `/api/boards/${boardId}`, body: null, idemKey: "" }, "deliver", this.headers);
    if (reply === "lost") return;
    if (reply.status >= 500) throw new Error(`GET /api/boards answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    if (reply.status !== 200) { this.layouts.delete(boardId); return; }
    this.layouts.set(boardId, new Map((reply.body as { cards: Card[] }).cards.map((card) => [card.nodeId, card])));
  }
  /** A layout change: the card (or its removal) shows at once; the PATCH carries only the cards that differ from the
   *  layout shown before (diffBoard), with a fresh Idempotency-Key. A refusal puts the previous layout back. */
  async arrange(boardId: string, change: (cards: Map<string, Card>) => void, fate: Fate): Promise<void> {
    await this.openBoard(boardId);
    const before = this.layouts.get(boardId) ?? new Map<string, Card>();
    const after = new Map([...before].map(([id, card]) => [id, { ...card }]));
    change(after);
    const upsert = [...after.values()].flatMap((card) => { const patch = cardPatch(before.get(card.nodeId), card); return patch ? [patch] : []; });
    const remove = [...before.keys()].filter((id) => !after.has(id));
    if (!upsert.length && !remove.length) return;
    this.layouts.set(boardId, after);
    const outcome = await this.submit({
      method: "PATCH", path: `/api/boards/${boardId}`, idemKey: randomUUID(),
      body: { cards: { ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}) } },
    }, fate);
    if (outcome === "rejected") this.layouts.set(boardId, before);
  }
  /** Reopening every board this device has shown (reconnect / reload): what the server holds replaces the local layout. */
  async refreshBoards(): Promise<void> { for (const id of [...this.layouts.keys()]) await this.openBoard(id, true); }

  tag(id: string, tagId: string, on: boolean, fate: Fate): Promise<unknown> {
    return this.submit({ method: on ? "PUT" : "DELETE", path: `/api/nodes/${id}/tags/${tagId}`, body: on ? {} : null, idemKey: randomUUID() }, fate);
  }

  // ── Drawing (lib/data/inkWriter.saveInk) ──────────────────────────────
  /** The surface of a note's drawing, opened from the device's copy (its last queued save on top). */
  inkSurface(id: string): { doc: InkDocument | null; base: InkDocument | null } {
    const known = this.surfaces.get(id);
    if (known) return known;
    const queued = [...this.queue].reverse().find((w) => w.method === "PUT" && w.path === `/api/nodes/${id}/attributes/${INK_ATTR}`);
    const stored = (queued?.body?.value as string | undefined) ?? this.mirror.get(id)?.attrs?.[INK_ATTR];
    const decoded = decodeInk(stored);
    const doc = decoded.kind === "page" ? decoded.doc : null;
    const surface = { doc, base: doc };
    this.surfaces.set(id, surface);
    return surface;
  }
  /** Leaving the note: the next visit loads it again. */
  closeInk(id: string): void { this.surfaces.delete(id); }
  /** A settled drawing change: the whole value and the base it was made from, then the base moves to it. */
  async editInk(id: string, change: (doc: InkDocument) => InkDocument, fate: Fate): Promise<void> {
    const surface = this.inkSurface(id);
    const next = change(surface.doc ?? { version: 1, strokes: [], erased: {}, page: { width: 1000 } });
    const base = surface.base;
    surface.doc = next;
    surface.base = next;
    await this.submit({
      method: "PUT", path: `/api/nodes/${id}/attributes/${INK_ATTR}`, idemKey: randomUUID(),
      body: { value: encodeInk(next), value_type: "text", is_inheritable: false, base_value: base === null ? "" : encodeInk(base) },
    }, fate);
  }


  /** taskWriter.createStandaloneTask: a task with no note, in the space the person picked; queued like any task write. */
  createLooseTask(id: string, title: string, when: string | undefined, fate: Fate): Promise<unknown> {
    return this.submit({
      method: "POST", path: "/api/tasks", idemKey: id,
      body: { id, title, ...(when ? { when_date: when } : {}), space_id: this.spaceId },
    }, fate);
  }

  // ── Direct (online-only) writes: onlineWrite.sendWrite ────────────────
  /** One request that is never queued: the person must be online with nothing waiting (onlineWrite's precondition). A refusal
   *  is shown to the person (recorded in `rejected`). A lost reply keeps the intent for `retryUnconfirmed` only where the screen
   *  retries under the same key (`retry`: a grade, an undo, a view create or delete); elsewhere the person presses the button
   *  again as a new action with a new key (the card switch, "tomorrow"). */
  private async direct(write: PendingWrite, fate: Fate, done: (reply: Reply) => void, retry = true): Promise<void> {
    const reply = await this.server.send(this.name, write, fate, this.headers);
    if (reply === "lost") { if (retry) this.unconfirmed.push({ write, done }); return; }
    if (reply.status >= 500) throw new Error(`server answered ${reply.status} to ${write.method} ${write.path}: ${JSON.stringify(reply.body)}`);
    if (reply.status >= 400) this.rejected.push({ write, status: reply.status });
    done(reply);
  }
  /** Whether a direct write may start now: online, nothing queued, and nothing unconfirmed left (the screen offers the same button again first). */
  private async ready(fate: Fate): Promise<boolean> {
    if (!this.online || this.queue.length) return false;
    await this.retryUnconfirmed(fateStream([fate]));
    return this.unconfirmed.length === 0;
  }
  /** The person presses the same button again: each unconfirmed write is sent with ITS key; the server answers {deduped:true} when
   *  the first send had landed. */
  async retryUnconfirmed(fate: () => Fate = () => "deliver"): Promise<void> {
    if (!this.online) return;
    for (const item of this.unconfirmed.splice(0)) await this.direct(item.write, fate(), item.done);
  }

  // ── Review card switch (modules/review/reviewCard.setNoteReviewCard) ──
  async setCard(noteId: string, on: boolean, fate: Fate): Promise<void> {
    if (!(await this.ready(fate))) return;
    // setNoteReviewCard sends with a fresh key and never retries under it: a lost reply is an error toast and a new press.
    await this.direct({ method: on ? "PUT" : "DELETE", path: `/api/review/cards/${noteId}`, body: null, idemKey: randomUUID() }, fate, () => {}, false);
  }

  // ── Review panel (modules/review/ReviewPanel.tsx; cardKey.cardPath) ──
  /** Opening the panel: the queue is read, and each card shows the reps of the schedule it has now. */
  async openReview(fate: Fate): Promise<void> {
    if (!this.online) return;
    const reply = await this.server.send(this.name, { method: "GET", path: "/api/review/queue", body: null, idemKey: "" }, fate, this.headers);
    if (reply === "lost") return;
    if (reply.status !== 200) { this.reviewQueue.clear(); return; }
    this.reviewOpened = true;
    this.reviewQueue.clear();
    for (const card of (reply.body as { cards: Array<{ node_id: string; state: { reps: number } | null }> }).cards) this.reviewQueue.set(card.node_id, { reps: card.state?.reps ?? 0 });
  }
  /** ReviewPanel.grade: one Idempotency-Key per attempt, reused until the server answers; the card leaves the queue once graded
   *  (a refusal re-reads the queue: the card is no longer in these reviews). */
  async grade(cardId: string | undefined, rating: 1 | 2 | 3 | 4, fate: Fate): Promise<void> {
    if (!(await this.ready(fate))) return;
    if (!this.reviewOpened || !this.reviewQueue.size) { await this.openReview("deliver"); cardId = [...this.reviewQueue.keys()][0]; } // an empty screen is opened again
    const shown = cardId === undefined ? undefined : this.reviewQueue.get(cardId);
    if (shown === undefined || cardId === undefined) return;
    const key = randomUUID();
    this.gradeShown.set(key, { card: cardId, shown: shown.reps });
    await this.direct({ method: "POST", path: `/api/review/${cardId}/grade`, body: { rating }, idemKey: key }, fate, (reply) => {
      this.reviewQueue.delete(cardId);
      if (reply.status < 300) this.reviewLastGraded = cardId;
    });
  }
  /** ReviewPanel.undoLastGrade: only the card this device just graded; a retry of an unconfirmed undo that is answered 409
   *  ("nothing to undo") means the first attempt had stepped back. The card returns to the front of the queue. */
  async undoGrade(fate: Fate): Promise<void> {
    const card = this.reviewLastGraded;
    if (!card || !(await this.ready(fate))) return;
    const done = (reply: Reply) => {
      if (reply.status >= 300) return;
      this.reviewLastGraded = null;
      // The step-back answer says what the card shows now; a replay ({deduped:true}) does not, and the card waits for the next read.
      const body = reply.body as { state?: { reps: number } | null };
      if ("state" in body) this.reviewQueue.set(card, { reps: body.state?.reps ?? 0 });
      else this.reviewQueue.delete(card);
    };
    await this.direct({ method: "POST", path: `/api/review/${card}/undo-grade`, body: {}, idemKey: randomUUID() }, fate, done);
  }
  /** ReviewPanel.putAside("tomorrow"): no grade; a fresh key each press (repeating it is harmless). */
  async putOffUntilTomorrow(cardId: string | undefined, fate: Fate): Promise<void> {
    if (!(await this.ready(fate))) return;
    if (!this.reviewOpened) { await this.openReview("deliver"); cardId = [...this.reviewQueue.keys()][0]; }
    if (!cardId) return;
    await this.direct({ method: "POST", path: `/api/review/${cardId}/tomorrow`, body: {}, idemKey: randomUUID() }, fate, (reply) => { if (reply.status < 300) this.reviewQueue.delete(cardId); }, false); // repeating it is harmless: a new press, a new key
  }
  /** Reopening the status of the cards this device has seen: GET /api/review/:id/state (the person's own schedule). */
  async readReviewStates(cardIds: string[]): Promise<void> {
    for (const id of cardIds) {
      const reply = await this.server.send(this.name, { method: "GET", path: `/api/review/${id}/state`, body: null, idemKey: "" }, "deliver", this.headers);
      if (reply === "lost" || reply.status !== 200) { this.reviewStates.delete(id); continue; }
      const state = (reply.body as { state: { reps: number; lapses: number; due: string } | null }).state;
      this.reviewStates.set(id, state ? { reps: state.reps, lapses: state.lapses, due: state.due } : null);
    }
  }

  // ── Saved views of a tag or a note (lib/data/viewWriter, viewOwner.viewOwnerPath) ──
  /** Opening an owner's view settings: GET …/views. A refused or missing owner has none. */
  async openViews(owner: ViewOwnerKey, fate: Fate = "deliver"): Promise<void> {
    if (!this.online) return;
    const reply = await this.server.send(this.name, { method: "GET", path: `${viewOwnerPath(owner)}/views`, body: null, idemKey: "" }, fate, this.headers);
    if (reply === "lost") return;
    if (reply.status !== 200) { this.viewLists.delete(ownerSlot(owner)); return; }
    this.viewLists.set(ownerSlot(owner), (reply.body as { views: Array<Record<string, unknown> & { id: string }> }).views);
  }
  /** viewWriter.create: online, nothing queued, refused offline; a retry of a create whose reply was lost is answered {deduped:true}. */
  async createView(owner: ViewOwnerKey, input: Record<string, unknown>, fate: Fate): Promise<void> {
    if (!(await this.ready(fate))) return;
    await this.direct({ method: "POST", path: `${viewOwnerPath(owner)}/views`, body: input, idemKey: randomUUID() }, fate, () => {});
    await this.openViews(owner);
  }
  /** viewWriter.update: an ordinary queued write that sends only the keys that changed; the screen shows them at once. */
  async changeView(owner: ViewOwnerKey, viewId: string, changes: Record<string, unknown>, fate: Fate): Promise<void> {
    await this.submit({ method: "PATCH", path: `${viewOwnerPath(owner)}/views/${viewId}`, body: changes, idemKey: randomUUID() }, fate);
    if (this.online && !this.queue.length) await this.openViews(owner);
  }
  /** viewWriter.remove: online like create. */
  async deleteView(owner: ViewOwnerKey, viewId: string, fate: Fate): Promise<void> {
    if (!(await this.ready(fate))) return;
    await this.direct({ method: "DELETE", path: `${viewOwnerPath(owner)}/views/${viewId}`, body: null, idemKey: randomUUID() }, fate, () => {});
    await this.openViews(owner);
  }
  /** What the person sees: the last list read, with this device's queued changes on top. */
  viewsOf(owner: ViewOwnerKey): Array<Record<string, unknown> & { id: string }> {
    const list = (this.viewLists.get(ownerSlot(owner)) ?? []).map((v) => ({ ...v }));
    for (const w of this.queue) {
      const id = /\/views\/([0-9a-f-]{36})$/.exec(w.path)?.[1];
      if (w.method === "PATCH" && w.path.startsWith(`${viewOwnerPath(owner)}/views/`) && id) {
        const view: Record<string, unknown> = list.find((v) => v.id === id) ?? {};
        const { layout_config_patch: patch, ...whole } = (w.body ?? {}) as Record<string, unknown>;
        Object.assign(view, whole);
        // A queued per-key change shows on top of the list's copy of the config, key by key.
        if (patch && typeof patch === "object") {
          const config: Record<string, unknown> = { ...((view.layout_config as Record<string, unknown> | undefined) ?? {}) };
          for (const [key, value] of Object.entries(patch)) { if (value === null) delete config[key]; else config[key] = value; }
          view.layout_config = config;
        }
      }
    }
    return list;
  }
  /** Reconnect: the screens read their views again. */
  async refreshViews(): Promise<void> { for (const slot of [...this.viewLists.keys()]) await this.openViews(slotOwner(slot)); }

  // ── Connectivity ───────────────────────────────────────────────────────
  goOffline(): void { this.online = false; }

  /** Back online: replay the queue, then pull (connectivity.ts: flush, then sync). */
  async comeOnline(fates: Fate[]): Promise<void> {
    this.online = true;
    const next = fateStream(fates);
    await this.flush(next);
    await this.retryUnconfirmed(next);
    await this.pull(next);
  }

  /** submitWrite: send at once when online with nothing queued, otherwise queue. */
  private async submit(write: PendingWrite, fate: Fate): Promise<"queued" | "synced" | "rejected"> {
    this.submitted.push(write.idemKey);
    this.queue.push(write); // kept until acknowledged: a lost reply is retried with the same key
    if (!this.online || this.queue.length > 1) return "queued";
    await this.flush(fateStream([fate]));
    if (this.queue.includes(write)) return "queued";
    return this.rejected.some((r) => r.write === write) ? "rejected" : "synced";
  }

  /** writeQueue.drain. */
  async flush(fate: () => Fate = () => "deliver"): Promise<void> {
    while (this.queue.length > 0) {
      const write = this.queue[0]!;
      const reply = await this.server.send(this.name, write, fate(), this.headers);
      if (reply === "lost") return; // network error: keep it, stop, retry later with the same key
      if (reply.status >= 500) throw new Error(`server answered ${reply.status} to ${write.method} ${write.path}: ${JSON.stringify(reply.body)}`);
      this.queue.shift();
      if (reply.status >= 400) {
        this.rejected.push({ write, status: reply.status });
        if (write.path.endsWith("/position")) this.positions.delete(noteIdOf(write.path)!); // `rejected` puts the previous position back; the simulator keeps none, so the next refresh decides
        continue;
      }
      this.apply(write, reply);
    }
  }

  private apply(write: PendingWrite, reply: Reply): void {
    const body = reply.body as Row & { deduped?: boolean };
    if (body?.deduped || !body) return;
    const id = noteIdOf(write.path);
    if (write.path.startsWith("/api/boards/")) {
      return; // the layout is already shown; the answer is only a count
    } else if (write.path.endsWith("/position")) {
      return; // graphPositionWriter has no `accepted` step: the optimistic position stays
    } else if (TASK_PATH.test(write.path) || write.path.endsWith("/tasks")) {
      // taskWriter: the row the server answers replaces the optimistic one.
      const row = body as unknown as TaskRow;
      if (row.id) this.tasks.set(row.id, row);
    } else if (write.method === "DELETE" && NOTE_PATH.test(write.path) && id) {
      this.mirror.delete(id);
      this.dropHostedTasks([id]);
    } else if ((write.path === "/api/nodes" || write.method === "PATCH") && body.id) {
      this.mirror.set(body.id, { ...this.mirror.get(body.id), ...body } as Row);
      // A merged body comes back: the editor shows it and builds on it (draftActions).
      if (typeof body.markdown === "string") {
        const text = this.texts.get(body.id);
        if (text && text.draft !== body.markdown && !this.queue.some((w) => w.method === "PATCH" && noteIdOf(w.path) === body.id && w.body && "markdown" in w.body)) {
          this.texts.set(body.id, { draft: body.markdown, base: body.markdown, title: text.title });
        }
      }
    } else if (isAttributePath(write.path) && id) {
      // propertyWriter: the local copy takes what the server stored (accepted → settle(true)).
      const row = this.mirror.get(id);
      const key = decodeURIComponent(write.path.split("/attributes/")[1]!);
      if (row) {
        const attrs = { ...(row.attrs ?? {}) };
        if (write.method === "PUT") attrs[key] = (body as unknown as { value: string }).value; else delete attrs[key];
        row.attrs = attrs;
      }
    } else if (write.path.includes("/tags/") && id) {
      const row = this.mirror.get(id);
      const tagId = write.path.split("/tags/")[1]!;
      if (row) row.label_tag_ids = write.method === "PUT" ? [...new Set([...(row.label_tag_ids ?? []), tagId])] : (row.label_tag_ids ?? []).filter((t) => t !== tagId);
    }
  }

  /** syncEngine.refreshMeta: what the delta does not carry. `graph_positions` is replaced wholesale. */
  async refreshMeta(fate: () => Fate = () => "deliver"): Promise<boolean> {
    const reply = await this.server.send(this.name, { method: "GET", path: "/api/bootstrap?nodes=none", body: null, idemKey: "" }, fate(), this.headers);
    if (reply === "lost") return false;
    if (reply.status !== 200) throw new Error(`bootstrap?nodes=none answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    const meta = reply.body as { nodes_omitted?: boolean; graph_positions?: Array<{ nodeId: string; x: number; y: number }> };
    if (meta.nodes_omitted !== true) return true;
    this.positions = new Map((meta.graph_positions ?? []).map((p) => [p.nodeId, { x: p.x, y: p.y }]));
    return true;
  }

  /** syncEngine.sync's delta loop. */
  async pull(fate: () => Fate = () => "deliver"): Promise<boolean> {
    for (let hop = 0; hop < 20; hop++) {
      const reply = await this.server.send(this.name, { method: "POST", path: "/api/sync", body: { since: this.cursor }, idemKey: "" }, fate(), this.headers);
      if (reply === "lost") return false;
      if (reply.status !== 200) throw new Error(`sync answered ${reply.status}: ${JSON.stringify(reply.body)}`);
      const delta = reply.body as { last_event_id: string | number; membership_epoch?: number; nodes: { upsert: Row[]; delete: string[] }; attributes?: { upsert: Array<{ node_id: string; key: string; value: string }>; delete: Array<{ node_id: string; key: string }> }; tasks?: { upsert: TaskRow[]; delete: string[] } };
      const empty = delta.nodes.upsert.length === 0 && delta.nodes.delete.length === 0 && !delta.attributes?.upsert.length && !delta.attributes?.delete.length && !delta.tasks?.upsert.length && !delta.tasks?.delete.length;
      const moved = BigInt(delta.last_event_id) > BigInt(this.cursor);
      this.land(delta.nodes);
      this.landAttributes(delta.attributes);
      for (const t of delta.tasks?.upsert ?? []) this.tasks.set(t.id, t);
      for (const id of delta.tasks?.delete ?? []) this.tasks.delete(id);
      if (moved) this.cursor = String(delta.last_event_id);
      if (!moved) return this.reconcileMembership(delta.membership_epoch, fate);
    }
    return false;
  }

  /** syncEngine.maybeReconcileMembership: once caught up on events, a changed epoch makes the device page the ids it may
   *  read (GET /api/sync/membership), delete the held ones that are not in it (a revoked note goes, unless it is a create
   *  still queued), and fetch the full projection of the ones it does not hold yet (POST /api/sync/nodes). */
  private async reconcileMembership(serverEpoch: number | undefined, requestFate: () => Fate): Promise<boolean> {
    if (!this.membershipAware || serverEpoch === undefined || serverEpoch === this.epoch) return true;
    const fate = (): Fate => (this.membershipFaults ? requestFate() : "deliver");
    const readable = new Set<string>();
    for (let cursor = ""; ; ) {
      const page = await this.server.send(this.name, { method: "GET", path: `/api/sync/membership?cursor=${encodeURIComponent(cursor)}&expected_epoch=${serverEpoch}&limit=1000`, body: null, idemKey: "" }, fate(), this.headers);
      if (page === "lost") return false;
      if (page.status !== 200) throw new Error(`sync/membership answered ${page.status}: ${JSON.stringify(page.body)}`);
      const body = page.body as { ids: string[]; next_cursor: string | null; retry_required?: boolean };
      if (body.retry_required) return false; // the epoch moved under us: the next sync starts over
      body.ids.forEach((id) => readable.add(id));
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    const pendingCreates = new Set(this.queue.filter((w) => w.method === "POST").map((w) => (w.body?.id as string | undefined) ?? ""));
    const held = new Set([...this.mirror.keys(), ...this.tasks.keys()]);
    const revoked = [...held].filter((id) => !readable.has(id) && !pendingCreates.has(id));
    for (const id of revoked) this.mirror.delete(id);
    this.dropHostedTasks(revoked);
    const granted = [...readable].filter((id) => !held.has(id));
    if (granted.length) {
      const reply = await this.server.send(this.name, { method: "POST", path: "/api/sync/nodes", body: { ids: granted, expected_epoch: serverEpoch }, idemKey: "" }, fate(), this.headers);
      if (reply === "lost") return false;
      if (reply.status !== 200) throw new Error(`sync/nodes answered ${reply.status}: ${JSON.stringify(reply.body)}`);
      const projection = reply.body as { nodes: Row[]; attributes?: { upsert: Array<{ node_id: string; key: string; value: string }>; delete: Array<{ node_id: string; key: string }> }; tasks?: TaskRow[]; retry_required?: boolean };
      if (projection.retry_required) return false;
      this.land({ upsert: projection.nodes, delete: [] });
      this.landAttributes(projection.attributes);
      for (const t of projection.tasks ?? []) this.tasks.set(t.id, t);
    }
    this.epoch = serverEpoch;
    return true;
  }

  private landAttributes(attributes: { upsert: Array<{ node_id: string; key: string; value: string }>; delete: Array<{ node_id: string; key: string }> } | undefined): void {
    for (const a of attributes?.upsert ?? []) {
      const row = this.mirror.get(a.node_id);
      if (row) row.attrs = { ...(row.attrs ?? {}), [a.key]: a.value };
    }
    for (const a of attributes?.delete ?? []) {
      const row = this.mirror.get(a.node_id);
      if (row?.attrs) { const attrs = { ...row.attrs }; delete attrs[a.key]; row.attrs = attrs; }
    }
  }

  private land(nodes: { upsert: Row[]; delete: string[] }): void {
    const editing = new Set(this.queue.filter((w) => w.method === "PATCH" && w.body && "markdown" in w.body).map((w) => noteIdOf(w.path)!));
    for (const row of nodes.upsert) {
      this.mirror.set(row.id, row);
      this.trashed.delete(row.id);
      // The editor reloads a note it holds no unsent text for.
      if (row.node_type === "content" && !editing.has(row.id)) this.texts.set(row.id, { draft: row.markdown, base: row.markdown, title: row.title });
    }
    for (const id of nodes.delete) this.mirror.delete(id);
    this.dropHostedTasks(nodes.delete);
  }

  /** storeOps.applySyncDelta: tasks hosted by a deleted note, and a task deleted as a node, go with it. */
  private dropHostedTasks(deletedIds: string[]): void {
    const gone = new Set(deletedIds);
    for (const [id, t] of this.tasks) if (gone.has(id) || (t.node_id !== null && gone.has(t.node_id))) this.tasks.delete(id);
  }
}

function fateStream(fates: Fate[]): () => Fate {
  let i = 0;
  return () => fates[i++] ?? "deliver";
}

/** A write on the note itself (not on one of its tags or attributes). */
const TASK_PATH = /^\/api\/tasks\/[0-9a-f-]{36}$/;
const taskIdOf = (path: string) => /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1] ?? null;
export const INK_ATTR = "ink_data";
export type { InkStroke };
export { mergeIntervals };
export const NOTE_PATH = /^\/api\/nodes\/[0-9a-f-]{36}$/;
const isAttributePath = (path: string) => path.includes("/attributes/");
/** How old an edit made offline is when it is replayed (the time it carries is the time of the edit). */
export const OFFLINE_EDIT_AGE_MS = 60 * 60_000;

export function noteIdOf(path: string): string | null {
  return /^\/api\/nodes\/([0-9a-f-]{36})/.exec(path)?.[1] ?? null;
}
function pick<T extends object>(source: T, keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => keys.includes(k))) as Partial<T>;
}
export function simSubtreeIds(notes: Map<string, { parent_id: string | null }>, rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const [id, n] of notes) if (n.parent_id === out[i] && !out.includes(id)) out.push(id);
  return out;
}
