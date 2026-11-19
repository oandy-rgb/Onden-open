// A page killed with no event (a crash, the OS reclaiming it, the power going)
// at ANY moment of a note save, then opened again on the same disk. The rule
// (docs/architecture/note-writes.md「送出前先記下」):
//
//   from the moment a save has left the editor (its first durable local write,
//   or its request, whichever comes first) until the server confirms it, a
//   kill at any instant leaves the write on the server or in a place it WILL
//   be sent from (the queue) or is shown from (recovery); and the local copy
//   never holds a body the server never accepted without such a record
//   (helpers/strandedText.ts).
//
// The kill points are not picked by hand: a dry run of each scenario counts its
// steps (every storage completion, every server answer, every jump of the
// clock), and the scenario is then run again once per step, killed after it,
// with the in-flight storage transaction committed and rolled back. Each run is
// the real client stack (tabWorld: noteWriter → writeQueue → localDb →
// localDbWorker with sql.js, its journal and snapshot) with fresh module
// instances per page, over one fake IndexedDB that outlives the page. A closed
// page also loses its sessionStorage.

import "./helpers/offlineNetwork";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  const shared = globalThis as { __ondenSql?: ReturnType<typeof real.default>; __ondenDatabases?: Array<{ close(): void }> };
  return {
    default: async () => {
      const SQL = await (shared.__ondenSql ??= real.default());
      class TrackedDatabase extends SQL.Database {
        constructor(data?: ArrayLike<number> | Buffer | null) { super(data); (shared.__ondenDatabases ??= []).push(this); }
      }
      return { ...SQL, Database: TrackedDatabase };
    },
  };
});
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: async (path: string, init?: unknown) => {
    const { tabContext, theWorld } = await import("./helpers/tabWorld");
    return theWorld.server.request(tabContext.getStore()!, path, init as never);
  },
}));

import { dataCtx, noteVersion, theWorld, type NoteId, type Tab } from "./helpers/tabWorld";
import { strandedTexts } from "./helpers/strandedText";

const w = theWorld;
beforeAll(async () => { await (await import("sql.js")).default(); });
afterEach(() => w.uninstall());

/** How the server treats the save's request. */
type Answer = "never" | "deliver" | "lose" | "arrive";
type Scenario = { name: string; answer: Answer; secondSaveAtMs?: number };
/** When nothing else can happen, the clock jumps to the next of these (ms since typing): the 2 s snapshot, the 15 s compaction, the 25 s deadline. */
const CLOCK = [500, 1_500, 2_500, 4_000, 16_000, 26_000, 30_000];

const bodyText = (body: string | null): number => {
  try { return noteVersion((JSON.parse(body ?? "{}") as { markdown?: string }).markdown); } catch { return -1; }
};

async function bare(name: string): Promise<Tab> {
  const tab = await w.createTab(name);
  await w.drive(w.start(tab, () => tab.mods.syncEngine.boot()));
  // Quiet before the person types: what the page stores from here on is the save's doing.
  await w.advance(20_000);
  await w.drainStorage();
  return tab;
}

function type(tab: Tab, id: NoteId, n: number): Promise<unknown> {
  return w.start(tab, () => tab.mods.noteWriter.makeNoteWriter(dataCtx(tab)).patch(id, { markdown: `v${n}` })).catch(() => undefined);
}

/** `left`: the texts that had left the editor when the page died. */
type Played = { steps: number; left: Set<number>; killed: boolean; sentUnrecorded: Set<number> };

/** Type v1 (and maybe v2) in a page and play the scenario; kill the page after step `killAt` (null: play to the end). */
async function play(s: Scenario, killAt: number | null, commit: boolean): Promise<{ played: Played; page: Tab }> {
  const page = await bare("A");
  // "Left the editor": the page's first durable write after the text was typed, or a request carrying it.
  const typed = new Set<number>();
  const left = new Set<number>();
  const stored = new Set<number>();
  const sentUnrecorded = new Set<number>();
  w.idb.onCommit = (tab) => { if (tab === page) for (const n of typed) { left.add(n); stored.add(n); } };
  w.server.nextN = 3;
  let elapsed = 0;
  typed.add(1);
  const saves = [type(page, "n0", 1)];
  let typedSecond = false;
  let steps = 0;
  let clock = 0;
  const answered = new Set<number>();
  for (;;) {
    await w.quiet();
    for (const r of w.server.requests) {
      if (r.tab !== page || r.method !== "PATCH") continue;
      const n = bodyText(r.body);
      if (!stored.has(n)) sentUnrecorded.add(n);
      left.add(n);
    }
    if (killAt !== null && steps === killAt) {
      w.kill(page, commit, false);
      sessionStorage.clear(); // a closed page's session storage goes with it
      return { played: { steps, left, killed: true, sentUnrecorded }, page };
    }
    if (s.secondSaveAtMs !== undefined && !typedSecond && elapsed >= s.secondSaveAtMs) { typedSecond = true; typed.add(2); saves.push(type(page, "n0", 2)); steps++; continue; }
    if (w.idb.io.length) { await w.pump(1); steps++; continue; }
    const open = w.server.inflight.find((r) => r.tab === page && r.method === "PATCH" && !answered.has(r.id));
    if (open && s.answer !== "never") { answered.add(open.id); w.server.respond(open, s.answer === "deliver" ? "deliver" : s.answer === "lose" ? "lose" : "arrive"); steps++; continue; }
    if (clock >= CLOCK.length) break;
    const next = CLOCK[clock++]!;
    await w.advance(next - elapsed);
    elapsed = next;
    steps++;
  }
  void saves;
  return { played: { steps, left, killed: false, sentUnrecorded }, page };
}

type Outcome = { stranded: string[]; lost: number[]; keys: Map<number, Set<string>>; arrivedApplied: Map<number, number>; reopenedShows: number };

/** Open the page again on the same disk: check the stored state first, then let it boot, sync and send everything. */
async function reopen(texts: number[]): Promise<Outcome> {
  const tab = await w.createTab("A2");
  const stranded = await strandedTexts(w, tab);
  const booting = w.start(tab, () => tab.mods.syncEngine.boot());
  await w.drive(booting, "deliver");
  const reopenedShows = tab.display("n0");
  for (let round = 0; round < 3; round++) {
    await w.drive(w.start(tab, () => tab.mods.writeQueue.flushPendingWrites()), "deliver");
    await w.drive(w.start(tab, () => tab.mods.syncEngine.sync()), "deliver");
    await w.advance(30_000);
    await w.drainStorage();
  }
  await w.drive(w.start(tab, () => tab.mods.writeRecovery.refreshRecoveryWrites()), "deliver");
  const refused = await w.drive(w.start(tab, () => tab.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, "deliver");
  const recovered = new Set([...tab.mods.writeRecovery.getRecoveryWrites(), ...refused].map((x) => bodyText(x.body)));
  const keys = new Map<number, Set<string>>();
  for (const r of w.server.requests.filter((x) => x.method === "PATCH")) {
    const n = bodyText(r.body);
    if (!keys.has(n)) keys.set(n, new Set());
    keys.get(n)!.add(r.key ?? "(none)");
  }
  const arrivedApplied = new Map<number, number>();
  for (const a of w.server.arrivals) if (a.applied) arrivedApplied.set(a.n, (arrivedApplied.get(a.n) ?? 0) + 1);
  const lost = texts.filter((n) => !w.server.appliedNs.has(n) && !recovered.has(n));
  return { stranded, lost, keys, arrivedApplied, reopenedShows };
}

const SCENARIOS: Scenario[] = [
  { name: "the server never answers (a stalled connection)", answer: "never" },
  { name: "the server answers", answer: "deliver" },
  { name: "the server applies it and the answer is lost", answer: "lose" },
  { name: "the server applies it and has not answered yet", answer: "arrive" },
  { name: "a second save to the same note while the first is stalled", answer: "never", secondSaveAtMs: 1_500 },
];

describe("a page killed at any step of a save, then opened again", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: nothing it recorded is lost, stranded or sent under a new key`, async () => {
      const texts = scenario.secondSaveAtMs === undefined ? [1] : [1, 2];
      w.install();
      const { played: dry } = await play(scenario, null, false);
      w.uninstall();
      expect(dry.steps).toBeGreaterThan(5);
      // Recorded before sent: no request carries a text before the page stored something after it was typed.
      expect([...dry.sentUnrecorded], "sent before anything of it was stored").toEqual([]);
      const problems: string[] = [];
      for (let killAt = 0; killAt <= dry.steps; killAt++) {
        for (const commit of [true, false]) {
          w.install();
          try {
            const { played } = await play(scenario, killAt, commit);
            const outcome = await reopen(texts);
            const at = `killed after step ${killAt}/${dry.steps} (${commit ? "in-flight storage committed" : "rolled back"})`;
            for (const s of outcome.stranded) problems.push(`${at}: ${s}`);
            for (const n of outcome.lost) if (played.left.has(n)) problems.push(`${at}: v${n} had left the editor and is neither on the server nor in recovery`);
            for (const [n, keys] of outcome.keys) if (keys.size > 1) problems.push(`${at}: v${n} was sent under ${keys.size} keys`);
            for (const [n, count] of outcome.arrivedApplied) if (count > 1) problems.push(`${at}: v${n} was applied ${count} times`);
          } finally { w.uninstall(); }
        }
      }
      expect(problems).toEqual([]);
    }, 300_000);
  }
});

describe("two pages of one browser", () => {
  it("a save another LIVE page is sending is not sent by this page; once that page is dead, it is, once, under its key", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 2;
      void type(a, "n0", 1);
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.tab === a && r.method === "PATCH"); i++) await w.pump(3, i);
      const sent = w.server.inflight.find((r) => r.tab === a && r.method === "PATCH")!;
      expect(sent).toBeDefined();
      await w.advance(3_000); // A's local copy, with the text, is saved
      await w.drainStorage();
      // B drains and syncs while A's request is on the wire: B must leave it to A.
      void w.start(b, () => b.mods.writeQueue.flushPendingWrites());
      void w.start(b, () => b.mods.syncEngine.sync());
      for (let i = 0; i < 40; i++) {
        await w.pump(5, i);
        for (const r of w.server.inflight.filter((x) => x.tab === b && x.method !== "PATCH")) w.server.respond(r, "deliver");
      }
      expect(w.server.requests.filter((r) => r.tab === b && r.method === "PATCH")).toEqual([]);
      expect(w.server.violations).toEqual([]);
      // A dies with its request unanswered. B (still open) sends it the next time it drains.
      w.kill(a, true, false);
      sessionStorage.clear();
      await w.drive(w.start(b, () => b.mods.writeQueue.flushPendingWrites()), "deliver");
      await w.drive(w.start(b, () => b.mods.syncEngine.sync()), "deliver");
      const fromB = w.server.requests.filter((r) => r.tab === b && r.method === "PATCH");
      expect(fromB.map((r) => r.key)).toEqual([sent.key]);
      expect(w.server.appliedNs.has(1)).toBe(true);
      expect(w.server.violations).toEqual([]);
      expect(b.display("n0")).toBe(1);
    } finally { w.uninstall(); }
  });
});

describe("editing the note again after the reopen", () => {
  // The stranded save is shown on reopen (not the server's older text), so the
  // person edits on top of it. The queue sends the two saves in order, each
  // carrying the text it was made from: the server merges each against that
  // base (three-way, like any other base it is given), so neither is lost.
  it("the text from before the crash is shown, sent first, and the new edit builds on it", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      void type(a, "n0", 1);
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.tab === a && r.method === "PATCH"); i++) await w.pump(3, i);
      await w.advance(3_000);
      await w.drainStorage();
      w.kill(a, true, false);
      sessionStorage.clear();
      const r = await w.createTab("A2");
      r.online = false; // the person types before the page reaches the server again
      const booting = w.start(r, () => r.mods.syncEngine.boot());
      await w.drive(booting, "net");
      expect(r.display("n0")).toBe(1);
      const editing = w.start(r, () => r.mods.noteWriter.makeNoteWriter(dataCtx(r)).patch("n0", { markdown: "v2" }, { baseMarkdown: "v1" }));
      await w.drive(editing, "net");
      r.online = true;
      r.mods.appStore.setOnline(true);
      await w.drive(w.start(r, () => r.mods.writeQueue.flushPendingWrites()), "deliver");
      await w.drive(w.start(r, () => r.mods.syncEngine.sync()), "deliver");
      const patches = w.server.requests.filter((x) => x.method === "PATCH" && x.arrived).map((x) => bodyText(x.body));
      expect(patches.filter((n) => n > 0)).toEqual([1, 2]);
      expect(w.server.notes.get("n0")!.n).toBe(2);
      expect(r.display("n0")).toBe(2);
    } finally { w.uninstall(); }
  });
});

describe("two saves of one key at once", () => {
  // The day's note asked for from two places at the same moment (quick capture and a new task): both create it under
  // the one id the day gives it, so both saves carry that key. Each save holds its own write lock and lets go of its
  // own; neither may leave the other's held, or this page's lane stops at that write for good.
  it("both finish, and a later save of another note still goes out", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      const save = (n: number) => w.start(a, () => a.mods.writeQueue.submitWrite({
        method: "PATCH", path: "/api/nodes/n0", body: JSON.stringify({ markdown: `v${n}` }), idemKey: "the-day-note",
      }));
      const both = Promise.all([save(1), save(1)]);
      await w.drive(both, "deliver", 200);
      const later = w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).patch("n1", { markdown: "v2" }));
      await w.drive(later, "deliver", 200);
      expect(w.server.appliedNs.has(2)).toBe(true);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, null);
      expect(queued).toEqual([]);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });

  it("refused, the text is kept for the person once, and the lane goes on", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      const save = () => w.start(a, () => a.mods.writeQueue.submitWrite({
        method: "PATCH", path: "/api/nodes/n0", body: JSON.stringify({ markdown: "v1" }), idemKey: "the-day-note",
      }), () => {});
      const both = Promise.all([save(), save()]);
      await w.drive(both, "refuse", 200);
      const refused = await w.drive(w.start(a, () => a.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, null);
      expect(refused.map((x) => bodyText(x.body))).toEqual([1]);
      // Kept without a storage failure: one row of the key, so the refusal knows which write it is.
      expect(a.mods.appStore.getAppState().toasts.filter((x) => x.kind === "error").map((x) => x.message)).toEqual([]);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, null);
      expect(queued).toEqual([]);
      const later = w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).patch("n1", { markdown: "v2" }));
      await w.drive(later, "deliver", 200);
      expect(w.server.appliedNs.has(2)).toBe(true);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("two saves of one key: the day's note created twice, an attempt resent", () => {
  // The real entry: noteWriter.create under the day's id (its key), twice at once, through the write lifecycle.
  it("two creates of the day's note at once both finish, and this page's next save is sent", async () => {
    w.install();
    try {
      const a = await bare("A");
      const create = () => w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).create({ id: "day-note", title: "today" }));
      await w.drive(Promise.all([create(), create()]), "deliver");
      w.server.nextN = 2;
      await w.drive(type(a, "n1", 2), "deliver");
      expect(w.server.appliedNs.has(2), "the next save was sent").toBe(true);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, "deliver");
      expect(queued).toEqual([]);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });

  // A key names one queued write, whatever the second request under it carries (two entry points can start the day's
  // note with different seeds; the server keeps the first and answers the other as its repeat). Refused, every text
  // sent under the key is kept for the person, and nothing of it stays queued.
  it("a resend under the key of a queued write, with other text, keeps one queued row; refused, both texts are kept", async () => {
    w.install();
    try {
      const a = await bare("A");
      const send = (n: number) => w.start(a, () => a.mods.writeQueue.submitWrite({ method: "PATCH", path: "/api/nodes/n0", body: JSON.stringify({ markdown: `v${n}` }), idemKey: "one-attempt" }), () => {});
      a.online = false;
      a.mods.appStore.setOnline(false);
      const first = send(1);
      await w.drive(first, null);
      expect(await first).toEqual({ status: "queued" });
      a.online = true;
      a.mods.appStore.setOnline(true);
      await w.drive(send(2), "refuse");
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, "deliver");
      const refused = await w.drive(w.start(a, () => a.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, "deliver");
      expect(queued).toEqual([]);
      expect(refused.map((x) => bodyText(x.body)).sort()).toEqual([1, 2]);
      expect(a.mods.appStore.getAppState().toasts.filter((x) => x.kind === "error").map((x) => x.message)).toEqual([]);
      expect(a.workerErrors).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("local storage cannot take the save (the disk is full) while online", () => {
  // No row could be kept, so the save goes straight out as it did before rows existed (note-writes.md). The row the
  // worker tried to add is not left behind in its memory, where the lane would take it for older work ahead.
  it("the save is sent at once, succeeds, and nothing of it is queued or in recovery", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 2;
      w.idb.full = true;
      const saving = w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).patch("n0", { markdown: "v1" }), (error) => { throw error; });
      await w.drive(saving, "deliver", 200);
      expect(w.server.requests.filter((r) => r.method === "PATCH").map((r) => bodyText(r.body))).toEqual([1]);
      expect(w.server.appliedNs.has(1)).toBe(true);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, null);
      expect(queued).toEqual([]);
      expect(a.mods.writeRecovery.getRecoveryWrites().map((x) => bodyText(x.body))).toEqual([]);
    } finally { w.uninstall(); }
  });
});

const patchOf = (n: number, key: string, extra: Record<string, unknown> = {}) => ({
  method: "PATCH" as const, path: "/api/nodes/n0", body: JSON.stringify({ markdown: `v${n}` }), idemKey: key, ...extra,
});
const sentPatches = () => w.server.requests.filter((r) => r.method === "PATCH").map((r) => bodyText(r.body));
const errorToasts = (tab: Tab) => tab.mods.appStore.getAppState().toasts.filter((x) => x.kind === "error").map((x) => x.message);

describe("a full disk and many saves", () => {
  // The save's record could not go into the journal, so the worker falls back to saving the whole database. Once that
  // failed and waits out its backoff, a save does not try the whole export again: every save would copy the database.
  it("each save is sent, and the whole local copy is not exported again for each one", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 7;
      w.idb.full = true;
      const writer = a.mods.noteWriter.makeNoteWriter(dataCtx(a));
      for (let n = 1; n <= 6; n++) await w.drive(w.start(a, () => writer.patch("n0", { markdown: `v${n}` }), (error) => { throw error; }), "deliver", 200);
      expect(sentPatches()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(w.idb.refusedPuts.get("onden-storage") ?? 0).toBeLessThanOrEqual(2);
      expect(a.mods.writeRecovery.getRecoveryWrites()).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("the queue keeps the order saves were made in", () => {
  // Each save holds a Web Lock of its own name, and the spec orders only the grants of one name. Two saves of one
  // note made one after the other (a burst on pagehide, two writers of one note) must keep that order in the queue,
  // and so in what is sent, whichever lock the browser grants first.
  it("when the browser grants their write locks the other way round", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      a.online = false;
      a.mods.appStore.setOnline(false);
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let asked = 0;
      w.lockGate = (name) => (name.startsWith("onden-write:") && ++asked === 1 ? firstHeld : undefined);
      const first = w.start(a, () => a.mods.writeQueue.submitWrite(patchOf(1, "save-a", { online: false })));
      const second = w.start(a, () => a.mods.writeQueue.submitWrite(patchOf(2, "save-b", { online: false })));
      for (let i = 0; i < 40; i++) await w.pump(5, i); // the second save's lock is held, its row could be written
      releaseFirst();
      await w.drive(Promise.all([first, second]), null, 200);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<Array<{ idem_key: string | null }>>, null);
      expect(queued.map((x) => x.idem_key)).toEqual(["save-a", "save-b"]);
      a.online = true;
      a.mods.appStore.setOnline(true);
      await w.drive(w.start(a, () => a.mods.writeQueue.flushPendingWrites()), "deliver");
      expect(sentPatches()).toEqual([1, 2]);
      // The fake server keeps the larger version, so its note does not tell the order; what it applied, in order, does.
      expect([...w.server.appliedNs]).toEqual([1, 2]);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("online, a save behind another page-held save is sent, not queued", () => {
  // A save is a queue row from the moment it is made, while its request waits for its note's turn. Such a row is
  // the live page's own, on its way: it is not work waiting in the queue, and a save of something else made
  // meanwhile goes out and reports its real result (as before rows existed for saves on their way).
  it("a note's second save waiting behind its first: a save of another note is synced, with no waiting notice", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 4;
      const writer = a.mods.noteWriter.makeNoteWriter(dataCtx(a));
      void w.start(a, () => writer.patch("n0", { markdown: "v1" }));
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.method === "PATCH"); i++) await w.pump(3, i);
      void w.start(a, () => writer.patch("n0", { markdown: "v2" })); // recorded now, waits for v1 in n0's lane
      const other = w.start(a, () => writer.patch("n1", { markdown: "v3" }));
      const result = await w.drive(other, "deliver", 300);
      expect(result?.status).toBe("synced");
      expect(errorToasts(a)).toEqual([]);
      expect(a.mods.appStore.getAppState().toasts.map((x) => x.message).filter((m) => /sync|queued|device/i.test(m))).toEqual([]);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });

  it("a note's save stuck behind an online operation that never ends does not hold up a save of another note", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      const ctx = dataCtx(a);
      const operation = a.mods.onlineWrite.makeOnlineOperation(ctx);
      // A version restore on n0 whose request never comes back (its api() has no deadline).
      void w.start(a, () => operation("node:n0", "offline", (submit) => submit("/api/nodes/n0/restore", "{}")), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.path.endsWith("/restore")); i++) await w.pump(3, i);
      const writer = a.mods.noteWriter.makeNoteWriter(ctx);
      void w.start(a, () => writer.patch("n0", { markdown: "v1" }), () => {}); // its row exists; it waits for the restore
      const other = w.start(a, () => writer.patch("n1", { markdown: "v2" }));
      const result = await w.drive(other, (req) => (req.path.endsWith("/restore") ? null : "deliver"), 300);
      expect(result?.status).toBe("synced");
      expect(w.server.appliedNs.has(2)).toBe(true);
      expect(a.unexpected).toEqual([]);
    } finally { w.uninstall(); }
  });

  it("this page's drain does not stop at its own row waiting behind an online operation", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 3;
      const ctx = dataCtx(a);
      const operation = a.mods.onlineWrite.makeOnlineOperation(ctx);
      void w.start(a, () => operation("node:n0", "offline", (submit) => submit("/api/nodes/n0/restore", "{}")), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.path.endsWith("/restore")); i++) await w.pump(3, i);
      void w.start(a, () => a.mods.noteWriter.makeNoteWriter(ctx).patch("n0", { markdown: "v1" }), () => {});
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      // A save of another note queued while the page thought it was offline; online again, the drain sends it.
      a.mods.appStore.setOnline(false);
      await w.drive(w.start(a, () => a.mods.writeQueue.submitWrite({ ...patchOf(2, "queued-a", { online: false }), path: "/api/nodes/n1" })), (req) => (req.path.endsWith("/restore") ? null : "deliver"), 300);
      a.mods.appStore.setOnline(true);
      await w.drive(w.start(a, () => a.mods.writeQueue.flushPendingWrites()), (req) => (req.path.endsWith("/restore") ? null : "deliver"), 300);
      expect(w.server.appliedNs.has(2)).toBe(true);
    } finally { w.uninstall(); }
  });

  it("another tab's drain does not stop at a row this page holds while it waits behind an online operation", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 3;
      const ctx = dataCtx(a);
      const operation = a.mods.onlineWrite.makeOnlineOperation(ctx);
      void w.start(a, () => operation("node:n0", "offline", (submit) => submit("/api/nodes/n0/restore", "{}")), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.path.endsWith("/restore")); i++) await w.pump(3, i);
      void w.start(a, () => a.mods.noteWriter.makeNoteWriter(ctx).patch("n0", { markdown: "v1" }), () => {}); // A's row, held by A
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      // B queued a save of another note while offline (made after A's row); back online, B's drain sends it.
      b.online = false;
      b.mods.appStore.setOnline(false);
      const queuing = w.start(b, () => b.mods.writeQueue.submitWrite({ ...patchOf(2, "queued-b", { online: false }), path: "/api/nodes/n1" }));
      await w.drive(queuing, (req) => (req.path.endsWith("/restore") ? null : "deliver"), 300);
      b.online = true;
      b.mods.appStore.setOnline(true);
      await w.drive(w.start(b, () => b.mods.writeQueue.flushPendingWrites()), (req) => (req.path.endsWith("/restore") || req.tab === a ? null : "deliver"), 300);
      expect(w.server.appliedNs.has(2)).toBe(true);
    } finally { w.uninstall(); }
  });

  it("a save refused while a closed tab's later save waits behind it: that one is sent", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 3;
      // A's save is on the wire; meanwhile B records one (made later, so it comes after A's) and is closed before
      // its turn (the drain lane is one for all tabs, and A's request holds it).
      const refused = w.start(a, () => a.mods.writeQueue.submitWrite(patchOf(1, "refused-a")), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.tab === a && r.method === "PATCH"); i++) await w.pump(3, i);
      void w.start(b, () => b.mods.writeQueue.submitWrite(patchOf(2, "left-by-b")), () => {});
      for (let i = 0; i < 100; i++) await w.pump(5, i); // storage steps only: the clock stands, A's request stays out
      w.kill(b, true, false);
      sessionStorage.clear();
      expect(w.server.requests.filter((r) => r.tab === a && r.method === "PATCH" && r.abandoned)).toEqual([]);
      // A's save is refused. What waited behind it is next: A sends B's save now, not at its next sync or save.
      await w.drive(refused, (req) => (req.tab === a && req.method === "PATCH" && bodyText(req.body) === 1 ? "refuse" : null), 300);
      for (let i = 0; i < 200 && !w.server.appliedNs.has(2); i++) {
        await w.pump(5, i);
        for (const r of w.server.inflight.filter((x) => x.tab === a && x.method === "PATCH")) w.server.respond(r, "deliver");
      }
      expect(sentPatches()).toEqual([1, 2]);
      expect(w.server.appliedNs.has(2)).toBe(true);
    } finally { w.uninstall(); }
  });
});

describe("a save whose lane could not start (the drain lock was refused)", () => {
  // The write's own lock is let go even then: a row kept as this page's to send, with nothing left to send it, would
  // hold up this page's drains and be hidden from the waiting count until a reload.
  it("its row is sent by the next drain", async () => {
    w.install();
    try {
      const a = await bare("A");
      w.server.nextN = 2;
      let refusals = 0;
      w.lockRefused = (name) => name === "onden-pending-drain" && refusals++ === 0;
      await w.drive(w.start(a, () => a.mods.writeQueue.submitWrite(patchOf(1, "lane-refused")), () => {}), null, 200);
      w.lockRefused = null;
      await w.drive(w.start(a, () => a.mods.writeQueue.flushPendingWrites()), "deliver");
      expect(w.server.appliedNs.has(1)).toBe(true);
      const queued = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<unknown[]>, null);
      expect(queued).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("upgrading from the build that kept the save on the wire in sessionStorage", () => {
  // That build sent a save without a queue row and kept it in one sessionStorage slot per account. A tab reloaded
  // into this build while such a save was out reads the slot once: the save is queued under its key and sent.
  it("the save the old page had on the wire is sent, once, under its key; the slot is gone", async () => {
    w.install();
    try {
      w.server.nextN = 2;
      const tab = await w.createTab("A");
      const { accountStorageKey } = await import("../lib/accountStorage"); // this tab's module: bound to its account
      const slot = await w.drive(w.start(tab, async () => accountStorageKey("onden-write-in-flight")) as Promise<string>, null);
      sessionStorage.setItem(slot, JSON.stringify({ method: "PATCH", path: "/api/nodes/n0", body: JSON.stringify({ markdown: "v1" }), idemKey: "old-build-key" }));
      await w.drive(w.start(tab, () => tab.mods.syncEngine.boot()));
      await w.drive(w.start(tab, () => tab.mods.writeQueue.flushPendingWrites()), "deliver");
      const sent = w.server.requests.filter((r) => r.method === "PATCH");
      expect(sent.map((r) => [bodyText(r.body), r.key])).toEqual([[1, "old-build-key"]]);
      expect(w.server.appliedNs.has(1)).toBe(true);
      expect(Object.keys(sessionStorage).filter((k) => k.startsWith("onden-write-in-flight"))).toEqual([]);
    } finally { w.uninstall(); }
  });
});

describe("one key alive in two tabs at once (the day's note created in both)", () => {
  // A save waits for its own write lock before its row is written, and rows are written in the order saves are made.
  // The lock of a key another live tab holds can be a long wait (that tab's request, or a stuck operation before it):
  // the save waits for it only a moment, then writes its row anyway (same key: the server answers the other tab's
  // request and this one as one write), so the saves made after it are not held up.
  it("tab B's later saves are still recorded, and sent, while tab A holds the key", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 3;
      void w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).create({ id: "day-note", title: "today" }), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.tab === a && r.method === "POST" && r.path === "/api/nodes"); i++) await w.pump(3, i);
      const writer = b.mods.noteWriter.makeNoteWriter(dataCtx(b));
      void w.start(b, () => writer.create({ id: "day-note", title: "today" }), () => {});
      const later = w.start(b, () => writer.patch("n1", { markdown: "v2" }));
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      await w.advance(2_000); // a moment: A still holds the key, its request still out
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      const queued = await w.drive(w.start(b, () => b.mods.localDb.getPendingWrites()) as Promise<Array<{ body: string | null }>>, null);
      expect(queued.map((x) => bodyText(x.body))).toContain(2); // B's later save has its durable row
      await w.drive(later, "deliver", 300);
      expect(w.server.appliedNs.has(2)).toBe(true);
    } finally { w.uninstall(); }
  });

  it("a tab that drains again and again while another holds a row's lock waits for that lock once", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 2;
      // A's save of n0 is recorded (A holds its lock) and waits in n0's lane behind an online operation that never ends.
      const ctx = dataCtx(a);
      const operation = a.mods.onlineWrite.makeOnlineOperation(ctx);
      void w.start(a, () => operation("node:n0", "offline", (submit) => submit("/api/nodes/n0/restore", "{}")), () => {});
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.path.endsWith("/restore")); i++) await w.pump(3, i);
      let waits = 0;
      let heldKey: string | null = null;
      w.lockGate = (name) => { if (heldKey && name === `onden-write:${heldKey}`) waits++; return undefined; };
      void w.start(a, () => a.mods.noteWriter.makeNoteWriter(ctx).patch("n0", { markdown: "v1" }), () => {});
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      const rows = await w.drive(w.start(a, () => a.mods.localDb.getPendingWrites()) as Promise<Array<{ idem_key: string | null }>>, null);
      heldKey = rows[0]!.idem_key;
      // B drains three times while A holds that row: B waits for its lock once, not once per drain.
      const notRestore = (req: { path: string }) => (req.path.endsWith("/restore") ? null : "deliver" as const);
      for (let round = 0; round < 3; round++) await w.drive(w.start(b, () => b.mods.writeQueue.flushPendingWrites()), notRestore, 200);
      expect(waits).toBe(1);
    } finally { w.uninstall(); }
  });

  it("two tabs waiting on each other's key and drain lane both go on sending", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.nextN = 4;
      // A's lane is busy with a slow request (A holds the drain lane); A's create of the day's note is recorded (A
      // holds its key) and waits for the lane.
      const slow = w.start(a, () => a.mods.writeQueue.submitWrite(patchOf(1, "slow-a")));
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.tab === a && r.method === "PATCH"); i++) await w.pump(3, i);
      const createdInA = w.start(a, () => a.mods.noteWriter.makeNoteWriter(dataCtx(a)).create({ id: "day-note", title: "today" }), () => {});
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      // B creates the same note (waits for A's key), then sends a write of its own straight away (it asks for the
      // lane before A asks again).
      const createdInB = w.start(b, () => b.mods.noteWriter.makeNoteWriter(dataCtx(b)).create({ id: "day-note", title: "today" }), () => {});
      const direct = w.start(b, () => b.mods.writeQueue.submitWrite({ ...patchOf(2, "direct-b"), path: "/api/nodes/n1" }));
      for (let i = 0; i < 100; i++) await w.pump(5, i);
      await w.drive(Promise.all([slow, createdInA, createdInB, direct]), "deliver", 600);
      expect(w.server.appliedNs.has(1)).toBe(true);
      expect(w.server.appliedNs.has(2)).toBe(true);
    } finally { w.uninstall(); }
  });
});
