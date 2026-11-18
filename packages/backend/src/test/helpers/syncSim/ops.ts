// The operations the simulator generates, and the world they run in. An op
// names things by position ("the 3rd note this device can see"), not by id, so
// a generated sequence stays meaningful when fast-check shrinks it, and a
// replay creates fresh ids but the same shape.
//
// To add an operation: add its type to `Op`, a `define(...)` entry (generator
// + runner + one plain-words line) to `OPS`. Nothing else needs to know.
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { SimClient, simSubtreeIds, mergeIntervals, ownerSlot, type NoteView, type TaskRow, type InkStroke, type Card, type ViewOwnerKey } from "./client.js";
import type { Fate, SimServer } from "./server.js";

export type ClientIx = 0 | 1 | 2;
export const DEVICE_COUNT = 3;
type Base = { client: ClientIx };
export type Op =
  | (Base & { kind: "create"; parent: number | null; fate: Fate })
  | (Base & { kind: "edit"; note: number; how: "insert" | "delete" | "replace"; at: number; fate: Fate })
  | (Base & { kind: "rename"; note: number; fate: Fate })
  | (Base & { kind: "move"; note: number; to: number | null; fate: Fate })
  | (Base & { kind: "delete"; note: number; fate: Fate })
  | (Base & { kind: "undelete"; pick: number; fate: Fate })
  | (Base & { kind: "tag"; note: number; tag: number; on: boolean; fate: Fate })
  | (Base & { kind: "createTask"; note: number; recurring: boolean; day: number | null; fate: Fate })
  | (Base & { kind: "patchTask"; task: number; how: "complete" | "reopen" | "reschedule" | "unschedule"; day: number; fate: Fate })
  | (Base & { kind: "checkbox"; note: number; how: "add" | "tick" | "untick"; at: number; fate: Fate })
  | (Base & { kind: "createLooseTask"; day: number | null; fate: Fate })
  | (Base & { kind: "setCard"; note: number; on: boolean; fate: Fate })
  | (Base & { kind: "reviewOpen" })
  | (Base & { kind: "grade"; card: number; rating: 1 | 2 | 3 | 4; fate: Fate })
  | (Base & { kind: "undoGrade"; fate: Fate })
  | (Base & { kind: "tomorrow"; card: number; fate: Fate })
  | (Base & { kind: "view"; owner: "tag" | "note"; of: number; how: "create" | "filter" | "sort" | "group" | "fields" | "rename" | "delete" | "setting" | "settingWhole"; pick: number; n: number; fate: Fate })
  | (Base & { kind: "draw"; note: number; fate: Fate })
  | (Base & { kind: "eraseInk"; note: number; stroke: number; at: number; fate: Fate })
  | (Base & { kind: "undoStroke"; note: number; stroke: number; fate: Fate })
  | (Base & { kind: "reopenInk"; note: number })
  | (Base & { kind: "place"; note: number; x: number; y: number; fate: Fate })
  | (Base & { kind: "arrangeCard"; board: number; note: number; how: "move" | "resize" | "fold" | "color"; x: number; y: number; fate: Fate })
  | (Base & { kind: "removeCard"; board: number; note: number; fate: Fate })
  | (Base & { kind: "setAttr"; note: number; key: number; fate: Fate })
  | (Base & { kind: "removeAttr"; note: number; key: number; fate: Fate })
  | (Base & { kind: "deliverLate"; pick: number })
  | (Base & { kind: "setMember"; member: 1 | 2; permission: "edit" | "view" | "none" })
  | (Base & { kind: "offline" })
  | (Base & { kind: "online"; fates: Fate[] });

/** The free-form property keys the simulator writes (a small set so devices collide on them). */
/** Days far in the future, so the scheduler's "overdue recurring task is rolled" never touches a run's tasks. */
export const TASK_DAYS = ["2099-01-01", "2099-01-02", "2099-01-03", "2099-01-04"] as const;
/** The `layout_config` keys the simulator's devices set on a saved view (a small set, so devices collide on them). */
const SETTING_KEYS = ["tree", "display", "hidden"] as const;
export const ATTR_KEYS = ["sim_a", "sim_b", "sim_c"] as const;

export class World {
  readonly clients: SimClient[];
  /** Creation order of every note: how "the 3rd note" is resolved on any device. */
  readonly ordinal = new Map<string, number>();
  /** Lines a user removed or replaced on purpose: not owed to the final body. */
  readonly removedLines = new Set<string>();
  /** Every parent a note was ever asked to have (a superset of what the server accepted). */
  readonly parentsEver = new Map<string, Set<string | null>>();
  /** Notes used as a board by some op (only to know which boards the invariants look at). */
  readonly boardOrdinal = new Map<string, number>();
  readonly everDeleted = new Set<string>();
  /** Creation order of every task (how "the 2nd task" is resolved), and the recurring ones. */
  readonly taskOrdinal = new Map<string, number>();
  readonly recurringTasks = new Set<string>();
  /** Notes some op made (or tried to make) a review card; the invariants judge the card switch on these. */
  readonly cardsEver = new Set<string>();
  /** Checkbox lines (their item text, "A7") some op un-ticked: the tick-not-lost check leaves them out. */
  readonly untickedItems = new Set<string>();
  /** The tags and notes whose saved views some op touched, by slot ("tag:<id>" / "node:<id>"). */
  readonly viewOwners = new Map<string, ViewOwnerKey>();
  /** Members runs: the actor id behind each device (device 0 is the workspace owner) and, set before the invariants run,
   *  the devices whose person is still a member of the shared space (null = single-account run: everyone reads). */
  people: string[] | null = null;
  readers: Set<string> | null = null;
  private counter = 0;

  constructor(readonly server: SimServer, readonly spaceId: string, readonly tagIds: string[], readonly startCursor: string, deviceCount = DEVICE_COUNT) {
    this.clients = Array.from({ length: deviceCount }, (_, i) => new SimClient(String.fromCharCode(65 + i), server, spaceId, startCursor));
  }

  mayRead(c: SimClient): boolean { return !this.readers || this.readers.has(c.name); }

  /** A line of text nobody else can write: "A7" is the 7th thing device A typed. */
  line(client: SimClient): string { return `${client.name}${++this.counter}`; }
  label(id: string): string { return `note#${this.ordinal.get(id) ?? "?"}`; }

  notes(client: SimClient): NoteView[] {
    return [...client.view().values()].sort((a, b) => (this.ordinal.get(a.id) ?? 0) - (this.ordinal.get(b.id) ?? 0));
  }
  tasks(client: SimClient): TaskRow[] {
    return [...client.taskView().values()].sort((a, b) => (this.taskOrdinal.get(a.id) ?? 0) - (this.taskOrdinal.get(b.id) ?? 0));
  }
  /** The cards a device's review queue shows, oldest note first ("the 2nd card"). */
  cardsOf(client: SimClient): string[] {
    return [...client.reviewQueue.keys()].sort((a, b) => (this.ordinal.get(a) ?? 0) - (this.ordinal.get(b) ?? 0));
  }
  /** The tag or note a view op names, from what the device sees. */
  viewOwner(client: SimClient, kind: "tag" | "note", of: number): ViewOwnerKey | undefined {
    if (kind === "tag") return { kind: "tag", id: this.tagIds[of % this.tagIds.length]! };
    const note = this.pick(this.notes(client), of);
    return note && { kind: "node", id: note.id };
  }
  pick<T>(list: T[], n: number): T | undefined { return list.length ? list[n % list.length] : undefined; }
  noteParent(id: string, parent: string | null) {
    const set = this.parentsEver.get(id) ?? new Set();
    this.parentsEver.set(id, set.add(parent));
  }

  /** Everyone online, queues empty, everything pulled: the state the invariants judge. */
  async settle(): Promise<void> {
    await this.server.deliverAllLate(); // the network heals: delayed requests arrive, newest first
    for (const c of this.clients) { c.online = true; await c.flush(); }
    // The person presses the same button again: an unconfirmed grade, undo, card switch or view write is finished before anyone reads.
    for (const c of this.clients) await c.retryUnconfirmed();
    for (let round = 0; round < 2; round++) for (const c of this.clients) await c.pull();
    for (const c of this.clients) await c.refreshMeta(); // reconnect: sync, then refreshIfStale
    for (const c of this.clients) await c.refreshBoards();
    // Opening Review and the view settings again.
    for (const c of this.clients) { await c.refreshViews(); await c.readReviewStates([...this.cardsEver]); }
  }
}

type Def<K extends Op["kind"]> = {
  arb: fc.Arbitrary<Extract<Op, { kind: K }>>;
  run: (world: World, op: Extract<Op, { kind: K }>) => Promise<void>;
  words: (op: Extract<Op, { kind: K }>) => string;
};
function define<K extends Op["kind"]>(def: Def<K>): Def<K> { return def; }

const fateArb: fc.Arbitrary<Fate> = fc.constantFrom<Fate>("deliver", "deliver", "deliver", "deliver", "deliver", "deliver", "lose_request", "lose_response", "delay", "delay");
const clientArb: fc.Arbitrary<ClientIx> = fc.constantFrom<ClientIx>(0, 1, 2);
const ix = fc.nat(40);
const pos = (n: number | null) => (n === null ? "the top level" : `visible note #${n}`);

const OPS = {
  create: define({
    arb: fc.record({ kind: fc.constant("create" as const), client: clientArb, parent: fc.option(ix, { nil: null, freq: 2 }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const parent = op.parent === null ? undefined : w.pick(w.notes(c), op.parent);
      if (op.parent !== null && !parent) return;
      const id = randomUUID();
      w.ordinal.set(id, w.ordinal.size + 1);
      w.noteParent(id, parent?.id ?? null);
      await c.create(id, `note ${w.ordinal.size}`, w.line(c), parent?.id ?? null, op.fate);
    },
    words: (op) => `${name(op)} creates a note under ${pos(op.parent)}`,
  }),
  edit: define({
    arb: fc.record({ kind: fc.constant("edit" as const), client: clientArb, note: ix, how: fc.constantFrom("insert", "delete", "replace", "insert") as fc.Arbitrary<"insert" | "delete" | "replace">, at: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      const lines = splitBody(c.textOf(note.id).draft);
      const at = lines.length ? op.at % (lines.length + (op.how === "insert" ? 1 : 0)) : 0;
      if (op.how === "insert" || lines.length === 0) lines.splice(at, 0, w.line(c));
      else if (op.how === "delete") w.removedLines.add(lines.splice(at, 1)[0]!);
      else { w.removedLines.add(lines[at]!); lines[at] = w.line(c); }
      await c.saveBody(note.id, lines.join("\n"), op.fate);
    },
    words: (op) => `${name(op)} ${op.how === "insert" ? "inserts a line into" : op.how === "delete" ? "deletes a line of" : "rewrites a line of"} visible note #${op.note} (line slot ${op.at}) and saves`,
  }),
  rename: define({
    arb: fc.record({ kind: fc.constant("rename" as const), client: clientArb, note: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) await c.rename(note.id, `renamed ${w.line(c)}`, op.fate);
    },
    words: (op) => `${name(op)} renames visible note #${op.note}`,
  }),
  move: define({
    arb: fc.record({ kind: fc.constant("move" as const), client: clientArb, note: ix, to: fc.option(ix, { nil: null, freq: 4 }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const view = c.view();
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      const inside = new Set(simSubtreeIds(view, note.id));
      const parent = op.to === null ? undefined : w.pick(w.notes(c).filter((n) => !inside.has(n.id)), op.to);
      if (op.to !== null && !parent) return;
      w.noteParent(note.id, parent?.id ?? null);
      await c.move(note.id, parent?.id ?? null, op.fate);
    },
    words: (op) => `${name(op)} moves visible note #${op.note} under ${pos(op.to)}`,
  }),
  delete: define({
    arb: fc.record({ kind: fc.constant("delete" as const), client: clientArb, note: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      w.everDeleted.add(note.id);
      await c.remove(note.id, op.fate);
    },
    words: (op) => `${name(op)} deletes visible note #${op.note} (with its subtree)`,
  }),
  undelete: define({
    arb: fc.record({ kind: fc.constant("undelete" as const), client: clientArb, pick: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const id = w.pick([...w.everDeleted].sort((a, b) => w.ordinal.get(a)! - w.ordinal.get(b)!), op.pick);
      if (id) await c.undelete(id, op.fate);
    },
    words: (op) => `${name(op)} restores the ${ordinalWord(op.pick)} note deleted so far (undo / history)`,
  }),
  tag: define({
    arb: fc.record({ kind: fc.constant("tag" as const), client: clientArb, note: ix, tag: fc.nat(5), on: fc.boolean(), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) await c.tag(note.id, w.tagIds[op.tag % w.tagIds.length]!, op.on, op.fate);
    },
    words: (op) => `${name(op)} ${op.on ? "adds" : "removes"} tag ${op.tag % 2} ${op.on ? "to" : "from"} visible note #${op.note}`,
  }),
  createTask: define({
    arb: fc.record({ kind: fc.constant("createTask" as const), client: clientArb, note: ix, recurring: fc.boolean(), day: fc.option(fc.nat(3), { nil: null }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      const id = randomUUID();
      w.taskOrdinal.set(id, w.taskOrdinal.size + 1);
      // A repeat rule without a day has no schedule to follow (no next occurrence), so a recurring task has a day.
      const day = op.recurring ? TASK_DAYS[(op.day ?? 0) % TASK_DAYS.length] : op.day === null ? undefined : TASK_DAYS[op.day % TASK_DAYS.length];
      if (op.recurring) w.recurringTasks.add(id);
      await c.createTask(id, note.id, `task ${w.taskOrdinal.size}`, { when: day, recur: op.recurring ? "1d" : undefined }, op.fate);
    },
    words: (op) => `${name(op)} adds a ${op.recurring ? "daily repeating " : ""}task under visible note #${op.note}${op.day !== null || op.recurring ? ` for day ${(op.day ?? 0) % 4}` : ""}`,
  }),
  patchTask: define({
    arb: fc.record({ kind: fc.constant("patchTask" as const), client: clientArb, task: ix, how: fc.constantFrom("complete", "complete", "reopen", "reschedule", "unschedule") as fc.Arbitrary<"complete" | "reopen" | "reschedule" | "unschedule">, day: fc.nat(3), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const task = w.pick(w.tasks(c), op.task);
      if (!task) return;
      const changes = op.how === "complete" ? { status: "done" } : op.how === "reopen" ? { status: "todo" }
        : op.how === "reschedule" ? { when_date: TASK_DAYS[op.day % TASK_DAYS.length] } : { when_date: null };
      await c.patchTask(task.id, changes, op.fate);
    },
    words: (op) => `${name(op)} ${op.how === "complete" ? "ticks off" : op.how === "reopen" ? "un-ticks" : op.how === "reschedule" ? `moves to day ${op.day % 4}` : "clears the day of"} visible task #${op.task}`,
  }),
  checkbox: define({
    // A checkbox line is plain text in the body (`- [ ] A7`); ticking it is a one-character edit saved like any typing
    // (lib/taskCheckbox.taskToggleEdit), so it travels the body save with its base text and merges with the other devices' edits.
    arb: fc.record({ kind: fc.constant("checkbox" as const), client: clientArb, note: ix, how: fc.constantFrom("add", "tick", "tick", "untick") as fc.Arbitrary<"add" | "tick" | "untick">, at: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      const lines = splitBody(c.textOf(note.id).draft);
      const flippable = lines.flatMap((line, i) => (op.how === "tick" ? line.startsWith("- [ ] ") : op.how === "untick" ? line.startsWith("- [x] ") : false) ? [i] : []);
      const at = w.pick(flippable, op.at);
      if (at === undefined) lines.splice(op.at % (lines.length + 1), 0, `- [ ] ${w.line(c)}`); // nothing to flip: a new box
      else {
        const before = lines[at]!;
        lines[at] = op.how === "tick" ? before.replace("- [ ] ", "- [x] ") : before.replace("- [x] ", "- [ ] ");
        w.removedLines.add(before); // the old form of the line was replaced on purpose
        if (op.how === "untick") w.untickedItems.add(before.slice("- [x] ".length));
      }
      await c.saveBody(note.id, lines.join("\n"), op.fate);
    },
    words: (op) => `${name(op)} ${op.how === "add" ? "adds a checkbox line to" : op.how === "tick" ? "ticks a checkbox line of (or adds one to, when it has none open)" : "un-ticks a checkbox line of (or adds one to, when it has none ticked)"} visible note #${op.note} (slot ${op.at}) and saves`,
  }),
  createLooseTask: define({
    arb: fc.record({ kind: fc.constant("createLooseTask" as const), client: clientArb, day: fc.option(fc.nat(3), { nil: null }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const id = randomUUID();
      w.taskOrdinal.set(id, w.taskOrdinal.size + 1);
      await c.createLooseTask(id, `task ${w.taskOrdinal.size}`, op.day === null ? undefined : TASK_DAYS[op.day % TASK_DAYS.length], op.fate);
    },
    words: (op) => `${name(op)} adds a task that belongs to no note${op.day !== null ? ` for day ${op.day % 4}` : ""}`,
  }),
  setCard: define({
    arb: fc.record({ kind: fc.constant("setCard" as const), client: clientArb, note: ix, on: fc.constantFrom(true, true, true, false), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      w.cardsEver.add(note.id);
      await c.setCard(note.id, op.on, op.fate);
    },
    words: (op) => `${name(op)} ${op.on ? "makes" : "stops"} visible note #${op.note} a review card`,
  }),
  reviewOpen: define({
    arb: fc.record({ kind: fc.constant("reviewOpen" as const), client: clientArb }),
    async run(w, op) { await w.clients[op.client].openReview("deliver"); },
    words: (op) => `${name(op)} opens Review (reads its queue)`,
  }),
  grade: define({
    arb: fc.record({ kind: fc.constant("grade" as const), client: clientArb, card: ix, rating: fc.constantFrom<1 | 2 | 3 | 4>(1, 2, 3, 3, 4), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      await c.grade(w.pick(w.cardsOf(c), op.card), op.rating, op.fate);
    },
    words: (op) => `${name(op)} grades the card #${op.card} of the queue it last read as ${["", "again", "hard", "good", "easy"][op.rating]}`,
  }),
  undoGrade: define({
    arb: fc.record({ kind: fc.constant("undoGrade" as const), client: clientArb, fate: fateArb }),
    async run(w, op) { await w.clients[op.client].undoGrade(op.fate); },
    words: (op) => `${name(op)} undoes the grade it gave last`,
  }),
  tomorrow: define({
    arb: fc.record({ kind: fc.constant("tomorrow" as const), client: clientArb, card: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      await c.putOffUntilTomorrow(w.pick(w.cardsOf(c), op.card), op.fate);
    },
    words: (op) => `${name(op)} puts the card #${op.card} of its queue off until tomorrow`,
  }),
  view: define({
    arb: fc.record({
      kind: fc.constant("view" as const), client: clientArb, owner: fc.constantFrom<"tag" | "note">("tag", "note"), of: ix,
      how: fc.constantFrom("create", "create", "filter", "sort", "group", "fields", "rename", "delete", "setting", "setting", "settingWhole") as fc.Arbitrary<"create" | "filter" | "sort" | "group" | "fields" | "rename" | "delete" | "setting" | "settingWhole">,
      pick: ix, n: fc.nat(8), fate: fateArb,
    }),
    async run(w, op) {
      const c = w.clients[op.client];
      const owner = w.viewOwner(c, op.owner, op.of);
      if (!owner) return;
      const slot = ownerSlot(owner);
      w.viewOwners.set(slot, owner);
      if (!c.viewLists.has(slot)) await c.openViews(owner); // the first look at the owner's view settings
      if (op.how === "create") {
        await c.createView(owner, { name: `view ${w.line(c)}`, layout: "table", filters: [], sorts: [], visible_fields: ["title"] }, op.fate);
        return;
      }
      const view = w.pick([...c.viewsOf(owner)].sort((a, b) => String(a.name).localeCompare(String(b.name))), op.pick);
      if (!view) return;
      if (op.how === "delete") { await c.deleteView(owner, view.id, op.fate); return; }
      const fields = ["title", "updated_at", "created_at"];
      // A whiteboard setting: this device names only its own key (a patch, null removes it); `settingWhole` is the older client's
      // whole-object write built from its own copy of the config.
      const settingKey = SETTING_KEYS[op.n % SETTING_KEYS.length]!;
      if (op.how === "setting" || op.how === "settingWhole") {
        const value = op.n % 3 === 0 ? null : { n: op.n };
        const own = (view.layout_config ?? {}) as Record<string, unknown>;
        const whole = Object.fromEntries(Object.entries({ ...own, [settingKey]: value }).filter(([, v]) => v !== null));
        await c.changeView(owner, view.id, op.how === "setting" ? { layout_config_patch: { [settingKey]: value } } : { layout_config: whole }, op.fate);
        return;
      }
      const changes: Record<string, unknown> = op.how === "filter" ? { filters: op.n % 3 === 0 ? [] : [{ field: "title", op: "contains", value: `q${op.n}` }] }
        : op.how === "sort" ? { sorts: op.n % 3 === 0 ? [] : [{ field: fields[op.n % 3]!, dir: op.n % 2 ? "asc" : "desc" }] }
          : op.how === "group" ? { group_by: op.n % 2 ? fields[op.n % 3]! : null }
            : op.how === "fields" ? { visible_fields: fields.slice(0, 1 + (op.n % 3)) }
              : { name: `view ${w.line(c)}` };
      await c.changeView(owner, view.id, changes, op.fate);
    },
    words: (op) => `${name(op)} ${op.how === "create" ? "saves a new view" : op.how === "delete" ? `deletes saved view #${op.pick}` : `changes the ${{ filter: "filters", sort: "sorts", group: "grouping", fields: "visible fields", rename: "name", setting: "settings (one key)", settingWhole: "settings (whole, older client)" }[op.how]} of saved view #${op.pick}`} on ${op.owner === "tag" ? `tag ${op.of % 2}` : `visible note #${op.of}`}`,
  }),
  draw: define({
    arb: fc.record({ kind: fc.constant("draw" as const), client: clientArb, note: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (!note) return;
      const stroke: InkStroke = { id: w.line(c), points: [[0, 0], [1, 1], [2, 2], [3, 3]], color: "#000000", size: 2, toolId: "pen" };
      await c.editInk(note.id, (doc) => ({ ...doc, strokes: [...doc.strokes, stroke] }), op.fate);
    },
    words: (op) => `${name(op)} draws a stroke on visible note #${op.note}'s handwriting page`,
  }),
  eraseInk: define({
    arb: fc.record({ kind: fc.constant("eraseInk" as const), client: clientArb, note: ix, stroke: ix, at: fc.nat(2), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      const stroke = note && w.pick(c.inkSurface(note.id).doc?.strokes ?? [], op.stroke);
      if (!note || !stroke) return;
      await c.editInk(note.id, (doc) => ({ ...doc, erased: { ...doc.erased, [stroke.id]: mergeIntervals([...(doc.erased[stroke.id] ?? []), [op.at, op.at + 1]]) } }), op.fate);
    },
    words: (op) => `${name(op)} erases part of stroke #${op.stroke} on visible note #${op.note}'s page`,
  }),
  undoStroke: define({
    arb: fc.record({ kind: fc.constant("undoStroke" as const), client: clientArb, note: ix, stroke: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      const stroke = note && w.pick(c.inkSurface(note.id).doc?.strokes ?? [], op.stroke);
      if (!note || !stroke) return;
      await c.editInk(note.id, (doc) => {
        const { [stroke.id]: _gone, ...erased } = doc.erased;
        return { ...doc, strokes: doc.strokes.filter((s) => s.id !== stroke.id), erased };
      }, op.fate);
    },
    words: (op) => `${name(op)} removes stroke #${op.stroke} from visible note #${op.note}'s page (undo)`,
  }),
  reopenInk: define({
    arb: fc.record({ kind: fc.constant("reopenInk" as const), client: clientArb, note: ix }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) c.closeInk(note.id);
    },
    words: (op) => `${name(op)} closes visible note #${op.note}'s handwriting page and opens it again later`,
  }),
  place: define({
    arb: fc.record({ kind: fc.constant("place" as const), client: clientArb, note: ix, x: fc.integer({ min: -500, max: 500 }), y: fc.integer({ min: -500, max: 500 }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) await c.place(note.id, op.x, op.y, op.fate);
    },
    words: (op) => `${name(op)} drags visible note #${op.note} to (${op.x}, ${op.y}) on the graph`,
  }),
  arrangeCard: define({
    arb: fc.record({ kind: fc.constant("arrangeCard" as const), client: clientArb, board: ix, note: ix, how: fc.constantFrom("move", "move", "resize", "fold", "color") as fc.Arbitrary<"move" | "resize" | "fold" | "color">, x: fc.integer({ min: -500, max: 500 }), y: fc.integer({ min: -500, max: 500 }), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const board = w.pick(w.notes(c), op.board);
      const note = w.pick(w.notes(c), op.note);
      if (!board || !note) return;
      w.boardOrdinal.set(board.id, w.boardOrdinal.size);
      await c.arrange(board.id, (cards) => {
        const card = cards.get(note.id) ?? { nodeId: note.id, x: op.x, y: op.y };
        if (op.how === "move") { card.x = op.x; card.y = op.y; }
        else if (op.how === "resize") { card.width = 100 + Math.abs(op.x); card.height = 80 + Math.abs(op.y); }
        else if (op.how === "fold") card.folded = !card.folded;
        else card.color = ["#ff0000", "#00ff00", "#0000ff"][Math.abs(op.x) % 3]!;
        cards.set(note.id, card);
      }, op.fate);
    },
    words: (op) => `${name(op)} ${op.how === "move" ? `drags the card of visible note #${op.note} to (${op.x}, ${op.y})` : op.how === "resize" ? `resizes the card of visible note #${op.note}` : op.how === "fold" ? `folds or unfolds the card of visible note #${op.note}` : `recolours the card of visible note #${op.note}`} on the board of visible note #${op.board}`,
  }),
  removeCard: define({
    arb: fc.record({ kind: fc.constant("removeCard" as const), client: clientArb, board: ix, note: ix, fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const board = w.pick(w.notes(c), op.board);
      if (!board) return;
      const cards = [...(c.layouts.get(board.id)?.keys() ?? [])];
      const id = w.pick(cards, op.note);
      if (!id) return;
      w.boardOrdinal.set(board.id, w.boardOrdinal.size);
      await c.arrange(board.id, (all) => { all.delete(id); }, op.fate);
    },
    words: (op) => `${name(op)} takes card #${op.note} off the board of visible note #${op.board}`,
  }),
  setAttr: define({
    arb: fc.record({ kind: fc.constant("setAttr" as const), client: clientArb, note: ix, key: fc.nat(2), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) await c.setAttr(note.id, ATTR_KEYS[op.key % ATTR_KEYS.length]!, `${w.line(c)}`, op.fate);
    },
    words: (op) => `${name(op)} sets property "${ATTR_KEYS[op.key % ATTR_KEYS.length]}" on visible note #${op.note}`,
  }),
  removeAttr: define({
    arb: fc.record({ kind: fc.constant("removeAttr" as const), client: clientArb, note: ix, key: fc.nat(2), fate: fateArb }),
    async run(w, op) {
      const c = w.clients[op.client];
      const note = w.pick(w.notes(c), op.note);
      if (note) await c.removeAttr(note.id, ATTR_KEYS[op.key % ATTR_KEYS.length]!, op.fate);
    },
    words: (op) => `${name(op)} removes property "${ATTR_KEYS[op.key % ATTR_KEYS.length]}" from visible note #${op.note}`,
  }),
  deliverLate: define({
    // A network event, not a device's action: `client` is only a placeholder.
    arb: fc.record({ kind: fc.constant("deliverLate" as const), client: fc.constant<ClientIx>(0), pick: ix }),
    async run(w, op) { await w.server.deliverLate(op.pick); },
    words: (op) => `the network delivers the ${ordinalWord2(op.pick)} delayed request (it may arrive after newer writes of other devices and after the sender's own retry)`,
  }),
  setMember: define({
    // The owner's management screen: a direct call (not queued), always delivered. Device `client` is ignored.
    arb: fc.record({ kind: fc.constant("setMember" as const), client: fc.constant<ClientIx>(0), member: fc.constantFrom<1 | 2>(1, 2), permission: fc.constantFrom("edit", "view", "none") as fc.Arbitrary<"edit" | "view" | "none"> }),
    async run(w, op) {
      if (!w.people) return;
      const path = `/api/spaces/${w.spaceId}/members/${w.people[op.member]}`;
      const none = op.permission === "none";
      await w.server.send(w.clients[0].name, { method: none ? "DELETE" : "PUT", path, body: none ? null : { permission: op.permission }, idemKey: randomUUID() }, "deliver", w.clients[0].headers);
    },
    words: (op) => `the owner (device A) ${op.permission === "none" ? "removes" : `sets to "${op.permission}"`} ${op.permission === "none" ? "" : "the permission of "}device ${String.fromCharCode(65 + op.member)}'s person ${op.permission === "none" ? "from the shared space" : "in the shared space"}`,
  }),
  offline: define({
    arb: fc.record({ kind: fc.constant("offline" as const), client: clientArb }),
    async run(w, op) { w.clients[op.client].goOffline(); },
    words: (op) => `${name(op)} goes offline`,
  }),
  online: define({
    arb: fc.record({ kind: fc.constant("online" as const), client: clientArb, fates: fc.array(fateArb, { maxLength: 6 }) }),
    async run(w, op) { await w.clients[op.client].comeOnline(op.fates); },
    words: (op) => `${name(op)} comes online, sends its queued writes, then pulls${op.fates.some((f) => f !== "deliver") ? ` (network faults: ${op.fates.join(", ")})` : ""}`,
  }),
};

export const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: OPS.create.arb, weight: 3 }, { arbitrary: OPS.edit.arb, weight: 8 }, { arbitrary: OPS.rename.arb, weight: 1 },
  { arbitrary: OPS.move.arb, weight: 3 }, { arbitrary: OPS.delete.arb, weight: 2 }, { arbitrary: OPS.undelete.arb, weight: 2 },
  { arbitrary: OPS.tag.arb, weight: 2 }, { arbitrary: OPS.createTask.arb, weight: 3 }, { arbitrary: OPS.patchTask.arb, weight: 6 }, { arbitrary: OPS.place.arb, weight: 3 }, { arbitrary: OPS.arrangeCard.arb, weight: 5 }, { arbitrary: OPS.removeCard.arb, weight: 2 }, { arbitrary: OPS.checkbox.arb, weight: 6 }, { arbitrary: OPS.createLooseTask.arb, weight: 2 }, { arbitrary: OPS.setCard.arb, weight: 6 }, { arbitrary: OPS.reviewOpen.arb, weight: 4 }, { arbitrary: OPS.grade.arb, weight: 10 }, { arbitrary: OPS.undoGrade.arb, weight: 5 }, { arbitrary: OPS.tomorrow.arb, weight: 3 }, { arbitrary: OPS.view.arb, weight: 10 }, { arbitrary: OPS.draw.arb, weight: 5 }, { arbitrary: OPS.eraseInk.arb, weight: 2 }, { arbitrary: OPS.undoStroke.arb, weight: 2 }, { arbitrary: OPS.reopenInk.arb, weight: 2 }, { arbitrary: OPS.setAttr.arb, weight: 4 }, { arbitrary: OPS.removeAttr.arb, weight: 2 }, { arbitrary: OPS.deliverLate.arb, weight: 4 }, { arbitrary: OPS.offline.arb, weight: 3 }, { arbitrary: OPS.online.arb, weight: 4 },
);

/** The members run: the same operations, plus the owner changing who is in the shared space. Device C starts with
 *  view only, so its edits are refused (the web client has no "suggestion" write: that is an agent's write_mode). */
export const opArbitraryMembers: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: opArbitrary, weight: 12 }, { arbitrary: OPS.setMember.arb, weight: 2 },
);

export async function runOp(world: World, op: Op): Promise<void> {
  await (OPS[op.kind] as Def<typeof op.kind>).run(world, op as never);
}
export function describeOp(op: Op): string { return (OPS[op.kind] as Def<typeof op.kind>).words(op as never); }

const name = (op: Base) => `Device ${String.fromCharCode(65 + op.client)}`;
const ordinalWord2 = (n: number) => `#${n} (counted from the oldest, wrapping)`;
const ordinalWord = (n: number) => `#${n} (counted in the order notes were deleted by number, wrapping)`;
export function splitBody(body: string): string[] { return body === "" ? [] : body.split("\n"); }
