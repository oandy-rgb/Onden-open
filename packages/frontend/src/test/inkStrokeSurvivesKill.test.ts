// A stroke, then the page killed with no event (a crash, the OS reclaiming a tab, the power going) at ANY moment before
// its save is sent, then the page opened again on the same disk. The rule (docs/architecture/note-writes.md
// 「筆跡：抬筆就記下」):
//
//   from the moment a finished stroke reaches the surface's saver (pen-up: InkSaver.keepAdded returns) — before its queue
//   row is written, which waits for the writes before it (on CI it was still waiting 155 ms later) — killing the page
//   leaves the change where it WILL be sent from (its synchronous copy, taken into the queue by the next page, or the
//   queue row), and the next page sends it; a stroke is never stored twice by the
//   resends (the server merges by stroke id), and a save the server refused is not sent again by its kept copy.
//
// Before this rule the stroke waited in memory for the engine's ~800 ms pause, and a page killed then lost it
// (e2e: a renderer killed 150 ms after pen-up lost the stroke 5 of 5 times). Every kill point after the first commit
// is checked: storage steps one by one, then the clock 100 ms at a time past the pause, with the in-flight storage
// transaction committed and rolled back. Each run is the real client stack (tabWorld: InkSaver → inkWriter →
// writeQueue → localDb → localDbWorker with sql.js, its journal and snapshot), fresh module instances per page.

import "./helpers/offlineNetwork";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mergeInk, encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";

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

import { tabContext, theWorld, type Tab } from "./helpers/tabWorld";

const w = theWorld;
beforeAll(async () => { await (await import("sql.js")).default(); });
afterEach(() => w.uninstall());

const NOTE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const PATH = `/api/nodes/${NOTE}/attributes/ink_data`;
const stroke = (id: string, i: number): InkStroke => ({ id, points: [[i, 1], [i + 5, 9], [i + 9, 4]], color: "#000000", size: 2, toolId: "pen" });
const page = (...ids: string[]): InkDocument => ({ version: 1, strokes: ids.map((id, i) => stroke(id, i * 20)), erased: {}, page: { width: 1000 } } as InkDocument);

type Saver = InstanceType<typeof import("../lib/ink/surfaceSaver").InkSaver>;
type Scenario = {
  name: string;
  /** The strokes drawn, one finished edit each, `gapMs` apart. */
  strokes: string[];
  gapMs?: number;
  /** How the server answers the drawing's PUT. */
  answer: "deliver" | "refuse" | "net";
  offline?: boolean;
  /** The page goes away (pagehide) once storage has caught up with the first stroke: the saver sends a keepalive save. */
  leaves?: boolean;
};

async function bare(name: string, online = true): Promise<Tab> {
  const tab = await w.createTab(name);
  tab.online = online;
  await w.drive(w.start(tab, () => tab.mods.syncEngine.boot()));
  await w.advance(20_000);
  await w.drainStorage();
  return tab;
}

/** The steps of one run: storage completions (no time passes), then the clock 100 ms at a time. `durableAt[i]`: the
 *  step at which storage had caught up with edit i (nothing left to complete after it was handed over). */
type Played = { steps: number; durableAt: Array<number | null>; drawnAt: number[]; drawn: string[] };

async function play(s: Scenario, killAt: number | null, commit: boolean, deliverKeepalive = false): Promise<Played> {
  const tab = await bare("A", !s.offline);
  if (s.offline) tab.mods.appStore.setOnline(false);
  // The page's own InkSaver, from this page's modules (createTab gave it a fresh registry).
  const { InkSaver } = await import("../lib/ink/surfaceSaver");
  const { pageWithOnly } = await import("../lib/ink/additions");
  let saver!: Saver;
  tabContext.run(tab, () => { saver = new InkSaver(); saver.rebase(NOTE, null); });
  let elapsed = 0;
  const drawn: string[] = [];
  const durableAt: Array<number | null> = [];
  const drawnAt: number[] = [];
  // Pen-up: only the new stroke, as the surfaces hand it over (lib/ink/additions); the surface's settled save follows its
  // pause (the engine's 800 ms debounce), with the whole drawing.
  const PAUSE_MS = 800;
  let lastDrawAt = 0;
  let saved = 0;
  const draw = (n: number) => {
    drawn.push(s.strokes[n]!); durableAt.push(null); drawnAt.push(steps); lastDrawAt = elapsed;
    tabContext.run(tab, () => saver.keepAdded(NOTE, pageWithOnly(page().page, { strokes: [page(...s.strokes.slice(0, n + 1)).strokes[n]!], shapes: [] })));
  };
  const settle = (options?: { keepalive: true }) => { saved = drawn.length; tabContext.run(tab, () => saver.save(NOTE, page(...drawn), options)); };
  let steps = 0;
  draw(0);
  let next = 1;
  let left = false;
  const answered = new Set<number>();
  for (;;) {
    await w.quiet();
    if (!w.idb.io.length) for (let i = 0; i < durableAt.length; i++) durableAt[i] ??= steps;
    if (s.leaves && !left && durableAt[0] !== null) { left = true; settle({ keepalive: true }); steps++; continue; }
    if (killAt !== null && steps === killAt) {
      w.kill(tab, commit, deliverKeepalive);
      sessionStorage.clear();
      return { steps, durableAt, drawnAt, drawn };
    }
    if (w.idb.io.length) { await w.pump(1); steps++; continue; }
    // A leaving save is never answered here: the page is going away (the case under test is it dying before the answer).
    const open = w.server.inflight.find((r) => r.tab === tab && r.method === "PUT" && !answered.has(r.id) && !r.keepalive);
    if (open) {
      answered.add(open.id);
      w.server.respond(open, s.answer === "refuse" ? "refuse" : s.answer === "net" ? "net" : "deliver");
      steps++;
      continue;
    }
    if (next < s.strokes.length && elapsed >= (s.gapMs ?? 0) * next) { draw(next++); steps++; continue; }
    if (saved < drawn.length && elapsed - lastDrawAt >= PAUSE_MS) { settle(); steps++; continue; }
    if (elapsed >= 1_600) break;
    await w.advance(100);
    elapsed += 100;
    steps++;
  }
  return { steps, durableAt, drawnAt, drawn };
}

/** What the server stores from the drawing's PUTs that arrived, in order, merged by base as services/attributeWrites.ts
 *  merges a drawing; a key's second arrival is answered from its record and changes nothing (the idempotency cache). */
function storedFrom(requests: Array<{ method: string; path: string; arrived: boolean; key: string | null; body: string | null }>): { stored: string; keys: string[] } {
  let stored = "";
  const keys: string[] = [];
  for (const r of requests) {
    if (r.method !== "PUT" || r.path !== PATH || !r.arrived) continue;
    if (r.key && keys.includes(r.key)) continue;
    if (r.key) keys.push(r.key);
    const body = JSON.parse(r.body ?? "{}") as { value?: string; base_value?: string };
    if (typeof body.value !== "string") throw new Error("a drawing save went out as a patch: the test's server only merges whole values");
    stored = stored === "" || body.base_value === undefined ? body.value : mergeInk(body.base_value, stored, body.value).value;
  }
  return { stored, keys };
}

/** Another device removes stroke `id` (its save is made from what the server holds now). */
function otherDeviceRemoves(id: string): void {
  const { stored } = storedFrom(w.server.requests);
  if (!stored) return;
  const doc = JSON.parse(stored) as InkDocument;
  const value = encodeInk({ ...doc, strokes: doc.strokes.filter((x) => x.id !== id) });
  w.server.requests.push({ method: "PUT", path: PATH, arrived: true, key: "other-device", body: JSON.stringify({ value, base_value: stored }) } as never);
}

/** Open the page again on the same disk, let it boot and send everything; what the server stores. */
async function reopen(): Promise<{ stored: InkDocument | null; arrivals: number }> {
  const tab = await w.createTab("A2");
  await w.drive(w.start(tab, () => tab.mods.syncEngine.boot()), "deliver");
  for (let round = 0; round < 3; round++) {
    await w.drive(w.start(tab, () => tab.mods.writeQueue.flushPendingWrites()), "deliver");
    await w.advance(30_000);
    await w.drainStorage();
  }
  const { stored, keys } = storedFrom(w.server.requests);
  return { stored: stored ? JSON.parse(stored) as InkDocument : null, arrivals: keys.filter((k) => k !== "other-device").length };
}

const SCENARIOS: Scenario[] = [
  { name: "one stroke, the server answers", strokes: ["s1"], answer: "deliver" },
  { name: "two strokes 300 ms apart (one save), the server answers", strokes: ["s1", "s2"], gapMs: 300, answer: "deliver" },
  { name: "one stroke, no connection (the save is queued)", strokes: ["s1"], answer: "net" },
  { name: "one stroke while offline", strokes: ["s1"], answer: "deliver", offline: true },
];

describe("a stroke, then the page killed at any step before (and after) its save goes out, then opened again", () => {
  // Review of PR #1958: a stroke, the page goes away (a keepalive save that reaches the server), the page dies before
  // the answer, another device then removes the stroke, and this device opens again. What this page left must not put
  // the stroke back: its kept row and its leaving save are one write under one key, so the server applies it once.
  it("a leaving save that reached the server, then another device removes the stroke: what this page left does not bring it back", async () => {
    const s: Scenario = { name: "leaves", strokes: ["s1"], answer: "deliver", leaves: true };
    w.install();
    const dry = await play(s, null, false);
    w.uninstall();
    const problems: string[] = [];
    for (let killAt = 1; killAt <= dry.steps; killAt++) {
      for (const commit of [true, false]) {
        w.install();
        try {
          await play(s, killAt, commit, true);
          const at = `killed after step ${killAt}/${dry.steps} (${commit ? "committed" : "rolled back"})`;
          if (!storedFrom(w.server.requests).stored.includes('"s1"')) continue; // the leaving save had not reached it
          otherDeviceRemoves("s1");
          const { stored } = await reopen();
          if (stored?.strokes.some((x) => x.id === "s1")) problems.push(`${at}: s1, removed on another device, came back`);
        } finally { w.uninstall(); }
      }
    }
    expect(problems).toEqual([]);
  }, 600_000);

  for (const s of SCENARIOS) {
    it(`${s.name}: every stroke drawn before the kill is on the server, once (whatever storage had finished)`, async () => {
      w.install();
      const dry = await play(s, null, false);
      w.uninstall();
      // The kept copy is written before any time passes: storage catches up with the first edit before the clock moves.
      expect(dry.durableAt[0], "storage caught up with the edit").not.toBeNull();
      const problems: string[] = [];
      for (let killAt = 0; killAt <= dry.steps; killAt++) {
        for (const commit of [true, false]) {
          w.install();
          try {
            const played = await play(s, killAt, commit);
            const { stored } = await reopen();
            const at = `killed after step ${killAt}/${dry.steps} (${commit ? "in-flight storage committed" : "rolled back"})`;
            const ids = stored?.strokes.map((x) => x.id) ?? [];
            for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problems.push(`${at}: ${id} is stored twice`);
            // From pen-up (keepAdded returned), not from the queue row's write: on CI the row was still waiting 155 ms
            // after pen-up when the page went (review of #1958). The synchronous copy covers that wait.
            played.drawn.forEach((id, i) => {
              if (killAt >= played.drawnAt[i]! && !ids.includes(id)) problems.push(`${at}: ${id} was drawn at step ${played.drawnAt[i]} but it is not on the server`);
            });
          } finally { w.uninstall(); }
        }
      }
      expect(problems).toEqual([]);
    }, 600_000);
  }

  it("a save the server refused is not sent again by its kept copy (no stroke the server said no to reaches it later)", async () => {
    w.install();
    try {
      await play({ name: "refused", strokes: ["s1"], answer: "refuse" }, null, false);
      expect(w.server.requests.filter((r) => r.method === "PUT" && r.path === PATH)).toHaveLength(1);
      const { arrivals } = await reopen();
      expect(arrivals, "the refused stroke is not resent from its kept copy").toBe(0);
      expect(w.server.requests.filter((r) => r.method === "PUT" && r.path === PATH)).toHaveLength(1);
    } finally { w.uninstall(); }
  }, 120_000);

  // Review of PR #1958 (property 4): the page opened after a kill shows the stroke before anything is sent — the copy on the
  // device with the queued save laid over it (reads attributeValues → inkWriter.withQueuedInk) — so nobody draws it again.
  it("the page opened after the kill shows the kept stroke before it is sent (the queued save laid over this device's copy)", async () => {
    const s: Scenario = { name: "reopen", strokes: ["s1"], answer: "net", offline: true };
    w.install();
    const dry = await play(s, null, false);
    w.uninstall();
    // Killed in the pen-up step itself (only the synchronous copy holds the stroke: its queue row was not written yet), and
    // killed once storage has caught up (the queue row holds it). Either way, before its save.
    for (const killAt of [0, dry.durableAt[0]!]) {
      w.install();
      try {
        await play(s, killAt, killAt !== 0); // at step 0 the in-flight row write is rolled back: only the copy is left
        const tab = await w.createTab("A2");
        tab.online = false;
        tab.mods.appStore.setOnline(false);
        const { reads } = await import("../lib/data/reads");
        // The boot's order (syncEngine runBoot): the local copy, then what the last page left, then the first reads.
        const values = await w.drive(w.start(tab, async () => {
          await tab.mods.localDb.initLocalDb();
          await tab.mods.writeQueue.takeInLeftWrites();
          return reads.notes.attributeValues(NOTE, ["ink_data"] as const);
        }) as Promise<Record<"ink_data", string | null>>, null);
        const shown = values.ink_data ? (JSON.parse(values.ink_data) as InkDocument).strokes.map((x) => x.id) : [];
        expect(shown, `killed after step ${killAt}`).toEqual(["s1"]);
      } finally { w.uninstall(); }
    }
  }, 120_000);

  it("while the page lives, nothing sends the kept copy: one request, after the pause, carrying both strokes", async () => {
    w.install();
    try {
      await play({ name: "live", strokes: ["s1", "s2"], gapMs: 300, answer: "deliver" }, null, false);
      const puts = w.server.requests.filter((r) => r.method === "PUT" && r.path === PATH);
      expect(puts).toHaveLength(1);
      expect((JSON.parse(puts[0]!.body!) as { value: string }).value).toBe(encodeInk(page("s1", "s2")));
    } finally { w.uninstall(); }
  }, 120_000);
});

// Review of PR #1958 (property 1), counted rather than timed: what one pen-up writes on this device — the synchronous copy
// in localStorage and the queue row's journal record — is the size of the strokes added since the last save, never of the
// drawing. 50 strokes in a row (no pause, so no save) on a PDF of 200 and of 2,000 strokes: the same writes, pen-up by
// pen-up, each under the row cap (KEPT_ROW_MAX_CHARS) plus its wrapping.
describe("what one pen-up writes on the device does not grow with the drawing", () => {
  const written = async (strokesOnPage: number): Promise<number[]> => {
    w.install();
    try {
      const tab = await bare("A");
      const { InkSaver } = await import("../lib/ink/surfaceSaver");
      const { emptyMultiPageDoc, setPdfPageDoc, pdfWithOnly } = await import("../lib/pdf");
      let envelope = emptyMultiPageDoc();
      for (let p = 1; p <= 10; p++) envelope = setPdfPageDoc(envelope, p, page(...Array.from({ length: strokesOnPage / 10 }, (_, i) => `p${p}s${i}`)), 1.414);
      let saver!: Saver;
      tabContext.run(tab, () => { saver = new InkSaver(); saver.rebase(NOTE, envelope); });
      const journalChars = () => (w.idb.databases.get("onden-journal")?.stores.get("entries") ?? [])
        .reduce((sum, e) => sum + JSON.stringify(e.value).length, 0);
      let local = 0;
      const realSetItem = Storage.prototype.setItem;
      const counted = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
        local += key.length + value.length;
        realSetItem.call(this, key, value);
      });
      const perPenUp: number[] = [];
      try {
        for (let n = 0; n < 50; n++) {
          const before = journalChars();
          local = 0;
          const added = pdfWithOnly(envelope, "pdf:3", { strokes: [stroke(`new${n}`, n)], shapes: [] }, 1.414)!;
          tabContext.run(tab, () => saver.keepAdded(NOTE, added));
          await w.quiet();
          await w.drainStorage();
          perPenUp.push(local + Math.max(0, journalChars() - before));
        }
      } finally { counted.mockRestore(); }
      return perPenUp;
    } finally { w.uninstall(); }
  };

  it("PDF of 200 and of 2,000 strokes, 50 pen-ups in a row: the same bytes per pen-up, each bounded", async () => {
    const small = await written(200);
    const large = await written(2_000);
    const whole = encodeInk(page(...Array.from({ length: 200 }, (_, i) => `s${i}`))).length;
    expect(large, `bytes per pen-up — 200 strokes: ${small.join(",")}; 2,000 strokes: ${large.join(",")}`).toEqual(small);
    // A pen-up rewrites the row with every stroke since the last save (here about 750 chars a stroke: 1.8 KB growing to
    // 38 KB at the 50th), and the row is sealed at KEPT_ROW_MAX_CHARS (32,000) of strokes; the copy and the journal record
    // each wrap one row. Writing the whole drawing instead was 156 KB a pen-up at 200 strokes.
    expect(Math.max(...large), `largest pen-up wrote ${Math.max(...large)} chars (one page of 200 strokes encodes to ${whole})`).toBeLessThan(100_000);
  }, 120_000);
});

// Review of PR #1958 round 2 (item 1): a copy taken at pen-up must never outlive a queue row that holds more than it. With
// the copy refused by storage from some pen-up on (localStorage full), the row goes on taking the later strokes; an older
// copy left behind would, on the next page, replace that row and take those strokes out.
describe("a copy refused by storage after some pen-ups, then the page killed", () => {
  it("every stroke written to the queue row is on the server after reopening (the older copy does not replace the row)", async () => {
    w.install();
    const realSetItem = localStorage.setItem.bind(localStorage);
    let full = false;
    const storage = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (full && key.includes("keptWrites")) throw new DOMException("the device is full", "QuotaExceededError");
      realSetItem(key, value);
    });
    try {
      const tab = await bare("A");
      const { InkSaver } = await import("../lib/ink/surfaceSaver");
      const { pageWithOnly } = await import("../lib/ink/additions");
      let saver!: Saver;
      tabContext.run(tab, () => { saver = new InkSaver(); saver.rebase(NOTE, null); });
      const penUp = (id: string, i: number) => tabContext.run(tab, () => saver.keepAdded(NOTE, pageWithOnly(page().page, { strokes: [stroke(id, i * 20)], shapes: [] })));
      // s1, then s2 while s1's row is still being written: s2 is only in the copy, which now holds s1 and s2.
      penUp("s1", 0);
      penUp("s2", 1);
      // From here every copy is refused. The row is written with s1, then rewritten with s1 and s2, then with s3 as well.
      full = true;
      await w.quiet(); await w.drainStorage();
      penUp("s3", 2);
      await w.quiet(); await w.drainStorage();
      const held = Object.keys(localStorage).filter((key) => key.includes("keptWrites"));
      w.kill(tab, true, false);
      sessionStorage.clear();
      full = false;
      const { stored } = await reopen();
      const ids = stored?.strokes.map((x) => x.id) ?? [];
      expect(ids.sort(), `copies left at the kill: ${held.length}; stored after reopening: ${ids.join(",") || "nothing"}`).toEqual(["s1", "s2", "s3"]);
    } finally { storage.mockRestore(); w.uninstall(); }
  }, 120_000);
});

// Review of PR #1958 round 2 (item 4): copies are one localStorage entry per row key, so two tabs taking copies at the
// same time write different entries and never read-modify-write a shared one. (In one JS thread two tabs cannot
// interleave inside a read-modify-write; the layout removes that step instead of relying on it.) Both tabs die before
// either queue row is written; the page opened next queues both copies.
describe("two tabs taking copies at once", () => {
  it("both strokes are on the server after both tabs die before their rows are written", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      const savers = new Map<Tab, Saver>();
      for (const tab of [a, b]) {
        const { InkSaver } = await w.drive(w.start(tab, async () => import("../lib/ink/surfaceSaver")), null) as typeof import("../lib/ink/surfaceSaver");
        tabContext.run(tab, () => { const saver = new InkSaver(); saver.rebase(NOTE, null); savers.set(tab, saver); });
      }
      const { pageWithOnly } = await import("../lib/ink/additions");
      tabContext.run(a, () => savers.get(a)!.keepAdded(NOTE, pageWithOnly(page().page, { strokes: [stroke("fromA", 0)], shapes: [] })));
      tabContext.run(b, () => savers.get(b)!.keepAdded(NOTE, pageWithOnly(page().page, { strokes: [stroke("fromB", 40)], shapes: [] })));
      const held = Object.keys(localStorage).filter((key) => key.includes("keptWrites")).length;
      expect(held, "each tab's copy is an entry of its own").toBe(2);
      w.kill(a, false, false);
      w.kill(b, false, false);
      sessionStorage.clear();
      const { stored } = await reopen();
      expect(stored?.strokes.map((x) => x.id).sort()).toEqual(["fromA", "fromB"]);
      expect(Object.keys(localStorage).filter((key) => key.includes("keptWrites")), "the copies are let go once queued").toEqual([]);
    } finally { w.uninstall(); }
  }, 120_000);
});
