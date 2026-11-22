// Random interleavings through the REAL note save path.
//
// Real: draftActions (drafts, bases, draftRevision, pendingSave), noteWriter,
// writeLifecycle, writeQueue (submitWrite, the offline queue and its drain),
// writeRecovery. Faked: the transport, the local database and the clock
// (test/helpers/saveWorld.ts). Per request the test decides: delayed,
// delivered, failed retryably, failed permanently, or applied with the
// response lost. The fake server merges bodies with the backend's own
// threeWayMergeBody and records BODY_CONFLICT regions.
//
// Notes hold lines that are unique tokens ("T7x"), so "this typing is still
// there" is a substring test, and a deleted line is a token someone removed
// on purpose.
//
// After a run settles (online, every request delivered, synced):
//   1 no lost typing: every token not deleted on purpose is in the server
//     body, in a BODY_CONFLICT of that note, or in a recovery copy
//   2 no resurrected deletion, no text twice
//   3 a title-only save never undoes another device's body edit, a body
//     save never undoes another device's rename
//   4 the open note's editor text equals the server (unless its save was refused)
//   5 pagehide / background never leaves the newest typing unprotected
//   6 a refused save is in recovery once and is not sent again
//   S5 an answer that is the server's current state is taken for every note this device has nothing of its own waiting on,
//      whatever the server's clock did (command `serverClockStepsBack` / `serverClockFreezes`: updated_at earlier than or equal to the held row's)
//   S1–S4 (a late sync answer, the owner report 2026-11-16; commands `syncStarts` / `syncAnswer`):
//   S1 once a save of this device is acknowledged, the editor's base is never older than that save
//      (the base is private to draftActions, so it is read where it is used: S3)
//   S2 the editor never shows a text an acknowledged save of this device already replaced (unless somebody typed or wrote it again)
//   S3 a save request never carries a base this device already replaced by an acknowledged save
//   S4 with no other device writing, the server never merges a save of this device
//   (1 also covers saves the CLIENT refuses before sending: a title over 500 characters, a body over the cap, NUL, half a surrogate
//    pair, the note gone from the store; the generator types them, deletes the open note elsewhere, and reloads)
//
// STATUS (fix/save-in-flight-across-reload, 2026-11-19): the random property and the named cases are ordinary tests;
// the one literal expected failure (`known`, it.fails) is "open (seed 432211385)" (a refused text typed again after a
// reload is sent again, #6). The random property takes a fresh seed every run (printed; PROPS_SEED replays one).
// A reload is a real one (loadPage / reloadPage): the app's modules are loaded afresh, the old page's unanswered
// requests are decided by the server and heard by nobody. Before this the simulated reload kept the old page's
// memory, and seed 11 (S3) failed only there.
// SAVE_TIMING_FLIP=1 runs the expected failures as ordinary tests to read their output.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npm run test:props
//          (fast-check prints seed, path and the shrunk command list.)

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const responses = vi.hoisted(() => ({ listener: null as null | ((path: string, init: RequestInit | undefined, response: Response) => void) }));
// The world outlives every page: a reload loads the app's modules afresh (vi.resetModules), and this mock hands each
// load the same world, where a fresh import would make a new, empty one.
const kept = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("../helpers/saveWorld", async (original) => {
  kept.world ??= await original();
  return kept.world as typeof import("../helpers/saveWorld");
});
// Each page load gets its own transport and local database, cut off when that page dies (saveWorld.pageDied).
// vi.resetModules does not run a vi.mock factory again, so a reload registers them anew (reloadPage).
function mockPageBoundary(): void {
  vi.doMock("../../lib/api", async (original) => {
    const { world } = await import("../helpers/saveWorld");
    const life = world.life;
    return {
      ...await original<typeof import("../../lib/api")>(),
      // lib/data/writePositions installs its recorder here; the world's responses are handed to it (see world.onResponse).
      setWriteResponseListener: (listener: typeof responses.listener) => { responses.listener = listener; },
      api: vi.fn(async (path: string, init?: unknown) => world.transport(path, init as never, life)),
    };
  });
  vi.doMock("../../lib/localDb", async () => {
    const { world } = await import("../helpers/saveWorld");
    return { ...world.localDbFor(world.life) };
  });
}
import { ownerData } from "../ownerData";
import type { ContentNode } from "../../lib/api";
import type { AppliedSyncDelta } from "../../lib/localDb";
import { bodyKey, mergeGuard, tokensIn, world, SERVER_ID, type WorldRequest } from "../helpers/saveWorld";

// ── one page load ───────────────────────────────────────────────────────────
//
// The app's modules as one page load holds them. A reload (Editor.reload) ends this page and loads a new one:
// every module is evaluated again, so every module-level Map, queue, lane, watermark, timer and listener of the old
// page is gone by construction, not by a list of resets that could miss one. What survives is what survives a real
// reload: the world's server, its local database (queue rows, refused rows, the local copy, the copy's watermark),
// localStorage and sessionStorage. The old page's requests already on the wire are decided by the server and their
// answers reach nobody (saveWorld.pageDied); its timers and window/document listeners are removed.
async function loadPage() {
  // lib/api first, alone: its mock awaits the real module, and an import racing it would get the real one (as tabWorld).
  const api = await import("../../lib/api");
  const localDb = await import("../../lib/localDb");
  const appStore = await import("../../lib/appStore");
  const draftActions = await import("../../lib/data/draftActions");
  const optimisticFields = await import("../../lib/data/optimisticFields");
  const storeOps = await import("../../lib/data/storeOps");
  const writeQueue = await import("../../lib/data/writeQueue");
  const writeRecovery = await import("../../lib/data/writeRecovery");
  const syncStatus = await import("../../lib/data/syncStatus");
  const accountStorage = await import("../../lib/accountStorage");
  const writePositions = await import("../../lib/data/writePositions");
  void localDb;
  accountStorage.bindAccountStorage("u", "");
  world.onResponse = (path, init, response) => responses.listener?.(path, init, response as unknown as Response);
  world.makeApiError = (status) => new api.ApiError(status, JSON.stringify({ error: "x" }));
  return { api, appStore, draftActions, optimisticFields, storeOps, writeQueue, writeRecovery, syncStatus, writePositions };
}
mockPageBoundary();
vi.resetModules();
let page = await loadPage();

/** Listeners the app's modules put on window and document, by the page load that added them: a dead page's are removed. */
const pageListeners: Array<{ life: number; remove: () => void }> = [];
for (const target of [window, document] as EventTarget[]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    add(type, listener, options);
    pageListeners.push({ life: world.life, remove: () => target.removeEventListener(type, listener, options) });
  }) as typeof target.addEventListener;
}

/** The page dies and a new one loads: see loadPage. */
async function reloadPage(): Promise<void> {
  vi.clearAllTimers();
  world.pageDied();
  for (const entry of pageListeners.splice(0)) entry.remove();
  mockPageBoundary();
  vi.resetModules();
  page = await loadPage();
}

// The current page's functions, by the names the app uses.
const nodeNeedsBody: typeof page.api.nodeNeedsBody = (...a) => page.api.nodeNeedsBody(...a);
const getAppState: typeof page.appStore.getAppState = () => page.appStore.getAppState();
const resetAppState: typeof page.appStore.resetAppState = (...a) => page.appStore.resetAppState(...a);
const selectOverviewSelectedNode: typeof page.appStore.selectOverviewSelectedNode = (...a) => page.appStore.selectOverviewSelectedNode(...a);
const setAppState: typeof page.appStore.setAppState = (...a) => page.appStore.setAppState(...a);
const setData: typeof page.appStore.setData = (...a) => page.appStore.setData(...a);
const subscribeApp: typeof page.appStore.subscribeApp = (...a) => page.appStore.subscribeApp(...a);
const __resetDraftStateForTests = () => page.draftActions.__resetDraftStateForTests();
const applyRemoteNode: typeof page.draftActions.applyRemoteNode = (...a) => page.draftActions.applyRemoteNode(...a);
const flushPendingSave: typeof page.draftActions.flushPendingSave = (...a) => page.draftActions.flushPendingSave(...a);
const readOverviewDraft: typeof page.draftActions.readOverviewDraft = (...a) => page.draftActions.readOverviewDraft(...a);
const resetDraftForNode: typeof page.draftActions.resetDraftForNode = (...a) => page.draftActions.resetDraftForNode(...a);
const typeIntoDraft: typeof page.draftActions.typeIntoDraft = (...a) => page.draftActions.typeIntoDraft(...a);
const pendingFields: typeof page.optimisticFields.pendingFields = (...a) => page.optimisticFields.pendingFields(...a);
const applySyncDelta: typeof page.storeOps.applySyncDelta = (...a) => page.storeOps.applySyncDelta(...a);
const flushPendingWrites = () => page.writeQueue.flushPendingWrites();
const stopWriteRetry = () => page.writeQueue.stopWriteRetry();
const getRecoveryWrites = () => page.writeRecovery.getRecoveryWrites();
const refreshRecoveryWrites = () => page.writeRecovery.refreshRecoveryWrites();
const removeRecoveryWrite: typeof page.writeRecovery.removeRecoveryWrite = (...a) => page.writeRecovery.removeRecoveryWrite(...a);
const setPending: typeof page.syncStatus.setPending = (...a) => page.syncStatus.setPending(...a);
const askedNow = () => page.writePositions.askedNow();
const forgetWatermark = () => page.writePositions.forgetWatermark();
const takeAnswer: typeof page.writePositions.takeAnswer = (...a) => page.writePositions.takeAnswer(...a);

/** PROPS_SKIP=3,6 ignores those invariants: once one bug is known, the shrinker
 *  would report it first every time and hide the others. */
const SKIP = (process.env.PROPS_SKIP ?? "").split(",").filter(Boolean).map((n) => `#${n} `);
const RUNS = Number(process.env.PROPS_RUNS ?? 100);
// A fresh seed every run (printed below), so each run looks at interleavings the last one did not; PROPS_SEED replays one.
const SEED = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) : Math.floor(Math.random() * 2 ** 31);
console.log(`[props] saveTiming seed=${SEED} runs=${RUNS} (replay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS})`);

// ── the editor, wired like useOverviewMode ──────────────────────────────────

/** Let every promise chain finish, then render: React runs effects in a later
 *  task than the microtasks that changed the store, so an effect never sees a
 *  save that is still finishing its own continuation. */
let effectsDue: (() => void) | null = null;
const flush = async () => {
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 80; i++) await Promise.resolve();
    const due = effectsDue;
    if (!due) return;
    effectsDue = null;
    due();
  }
};

/** How much of its exit save a page got done before it died (Editor.reload). */
type ReloadGrace = "at once" | "after its work";

// "extend": the token goes at the end of the last line, the way characters are typed into a sentence (the merge
// works on lines, so two writers in one line is the case where it has to choose).
type LineKind = "append" | "prepend" | "insert" | "delete" | "replace" | "extend";
type LineOp = { kind: LineKind; k: number };

function editLines(text: string, op: LineOp, token: string): string {
  const lines = text === "" ? [] : text.split("\n");
  const at = lines.length ? op.k % lines.length : 0;
  switch (op.kind) {
    case "prepend": return [token, ...lines].join("\n");
    case "insert": lines.splice(at + 1, 0, token); return lines.join("\n");
    case "delete": if (!lines.length) return token; lines.splice(at, 1); return lines.join("\n");
    case "replace": if (!lines.length) return token; lines[at] = token; return lines.join("\n");
    case "extend": if (!lines.length) return token; lines[lines.length - 1] += token; return lines.join("\n");
    default: return [...lines, token].join("\n");
  }
}

class Editor {
  userTokens = new Set<string>();
  /** Notes removed from the store (deleted on another device): their typed text can only live in recovery. */
  vanished = new Set<string>();
  exitProblems: string[] = [];
  /** Answers the device asked the server for (`syncStarts`) and has not been given yet, as the server held them then. */
  asked: Array<{ rows: ContentNode[]; head: number; request: ReturnType<typeof askedNow>; delivered: boolean }> = [];
  /** Step-back problems (S2) seen after a command; they are gone from the state by the end of the run. */
  stepProblems = new Set<string>();
  /** Per note: the text the person last typed (the editor showing it is typing, not a step back). */
  private lastTyped = new Map<string, string>();
  private unsubscribe = () => {};
  private resetKey = "";
  private remoteKey = "";
  private titleSeq = 0;
  private readonly onHide = () => { void flushPendingSave({ keepalive: true }); };
  private readonly onVisibility = () => { if (document.visibilityState === "hidden") this.onHide(); };

  async setup(): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stopWriteRetry();
    __resetDraftStateForTests();
    world.reset();
    forgetWatermark();
    localStorage.clear();
    await refreshRecoveryWrites();
    setPending(0);
    this.userTokens.clear(); this.vanished.clear(); this.exitProblems = []; this.titleSeq = 0; this.asked = []; this.stepProblems = new Set(); this.lastTyped.clear();
    this.resetKey = ""; this.remoteKey = ""; effectsDue = null;
    resetAppState({ data: { ...ownerData, nodes: world.rows() }, online: true, selectedId: "a" });
    this.unsubscribe = subscribeApp(() => { effectsDue = () => this.effects(); });
    window.addEventListener("pagehide", this.onHide);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.effects();
    await flush();
  }

  teardown(): void {
    this.unsubscribe();
    window.removeEventListener("pagehide", this.onHide);
    document.removeEventListener("visibilitychange", this.onVisibility);
    __resetDraftStateForTests();
    vi.useRealTimers();
  }

  /** The two effects of useOverviewMode: seed the draft when the open note (or
   *  whether its body is loaded) changes, then apply a newer row. */
  private effects(): void {
    const node = selectOverviewSelectedNode(getAppState());
    const needsBody = nodeNeedsBody(node);
    const resetKey = `${node?.id}|${needsBody}`;
    if (resetKey !== this.resetKey) { this.resetKey = resetKey; resetDraftForNode(needsBody ? null : node); }
    const remoteKey = JSON.stringify([node?.id, node?.markdown, node?.title]);
    if (remoteKey !== this.remoteKey) { this.remoteKey = remoteKey; applyRemoteNode(node); }
  }

  get open(): string { return getAppState().selectedId!; }

  /** `unsendable`: text the client itself refuses before sending (NUL, half a surrogate pair). */
  type(op: LineOp, unsendable = ""): void {
    const current = readOverviewDraft(this.open);
    if (!current) return; // the editor does not own the note (its body is loading)
    const adds = op.kind !== "delete";
    const token = adds ? world.nextToken(this.open) : "";
    if (adds) this.userTokens.add(token);
    // The app refuses this save itself, so the editor is not expected to equal the server (invariant 4).
    if (unsendable) world.rejectedNotes.add(this.open);
    const markdown = editLines(current.markdown, op, token + (adds ? unsendable : ""));
    world.recordEdit(current.markdown, markdown);
    world.wrote(this.open, markdown);
    this.lastTyped.set(this.open, markdown);
    typeIntoDraft(this.open, { markdown });
  }

  rename(): void {
    if (!readOverviewDraft(this.open)) return;
    const title = `Title${++this.titleSeq}-${this.open}`;
    world.userTitles.add(title);
    typeIntoDraft(this.open, { title });
  }

  /** A title pasted over the 500-character cap: every save of this note is refused by the app until it is shortened. */
  pasteLongTitle(): void {
    if (!readOverviewDraft(this.open)) return;
    world.rejectedNotes.add(this.open);
    typeIntoDraft(this.open, { title: "x".repeat(501) });
  }

  /** The note is deleted on another device: a sync takes it out of the store while the editor shows it. */
  vanish(): void {
    const id = this.open;
    this.vanished.add(id);
    world.rejectedNotes.add(id); // the editor is no longer expected to equal the server (invariant 4)
    setData((data) => ({ ...data, nodes: data.nodes.filter((n) => n.id !== id) }));
  }

  /** Reload the page: pagehide first (the keepalive flush), then the page dies and a new one loads (reloadPage: its
   *  modules afresh; the old page's memory, timers, listeners and unanswered requests reach nothing). `grace`: how much
   *  of the exit save the old page got done before it died. "at once": only what pagehide did synchronously (the
   *  recovery copy in localStorage; its queue row and its request need worker round trips first). "after its work":
   *  every step that did not wait for an answer (the queue row is written and the request is on the wire).
   *  The new page boots as the app does: the local copy's rows with the queued text laid over them, the recovery
   *  panel read from storage, then (online) the queue drained (syncEngine's loop drains before it syncs). */
  async reload(grace: ReloadGrace = "after its work"): Promise<void> {
    const { online, selectedId } = getAppState();
    this.pagehide();
    if (grace === "after its work") await flush();
    this.unsubscribe();
    await reloadPage();
    this.resetKey = ""; this.remoteKey = ""; effectsDue = null;
    // syncEngine.runBoot's order: what the old page left unqueued goes into the queue, then the copy is shown
    // (the test "the boot order is syncEngine's" below pins it).
    await page.writeQueue.takeInLeftWrites();
    resetAppState({ data: { ...ownerData, nodes: world.bootRows() }, online, selectedId });
    this.unsubscribe = subscribeApp(() => { effectsDue = () => this.effects(); });
    window.addEventListener("pagehide", this.onHide);
    document.addEventListener("visibilitychange", this.onVisibility);
    await refreshRecoveryWrites();
    this.effects();
    if (online) void flushPendingWrites();
  }

  switchNote(): void { setAppState({ selectedId: this.open === "a" ? "b" : "a" }); }

  async tick(): Promise<void> { await vi.advanceTimersByTimeAsync(1500); }

  pagehide(): void {
    window.dispatchEvent(new Event("pagehide"));
    this.checkExitProtection("pagehide");
  }

  background(): void {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    this.checkExitProtection("background");
  }

  /** Invariant 5, read synchronously right after the page was told to go. */
  private checkExitProtection(how: string): void {
    const draft = readOverviewDraft(this.open);
    if (!draft) return;
    const server = world.server.get(this.open)!;
    const bodies = [
      ...world.requests.filter((r) => r.nodeId === this.open && r.state === "applied" || r.state === "lost" || r.state === "inflight").map((r) => r.body),
      ...world.pending.map((w) => parseBody(w.body)),
      ...getRecoveryWrites().map((w) => parseBody(w.body)),
    ];
    const unprotected = tokensIn(draft.markdown).filter((t) => this.userTokens.has(t) && !server.markdown.includes(t) && !bodies.some((b) => b.markdown?.includes(t)));
    if (unprotected.length) this.exitProblems.push(`#5 ${how}: newest typing ${unprotected.join(",")} is neither sent nor in a recovery copy`);
    if (world.userTitles.has(draft.title) && draft.title !== server.title && !bodies.some((b) => b.title === draft.title)) {
      this.exitProblems.push(`#5 ${how}: the new title "${draft.title}" is neither sent nor in a recovery copy`);
    }
  }

  remoteBody(noteId: string, op: LineOp): void {
    const adds = op.kind !== "delete";
    const token = adds ? world.nextToken(noteId) : "";
    world.remoteBody(noteId, (body) => editLines(body, op, token));
  }
  remoteRename(noteId: string): void { world.remoteRename(noteId, `Remote${++this.titleSeq}-${noteId}`); }

  /** A sync delta asked and delivered now: the same road as every answer (syncAnswer: the page's door, then this
   *  world's copy as the worker does, then the store, where a field an edit of this device still owns is kept). */
  sync(): void {
    this.syncStarts();
    this.syncAnswer(this.unanswered - 1);
  }

  /** The device asks the server now: the answer is the rows as the server holds them at this moment, and it
   *  reaches the device only with `syncAnswer`. */
  syncStarts(): void { this.asked.push({ rows: world.rows(), head: world.head, request: askedNow(), delivered: false }); }

  get unanswered(): number { return this.asked.filter((a) => !a.delivered).length; }

  /** A captured answer reaches the device now, however much happened since. It takes the road a /api/sync
   *  delta takes in syncEngine.applyAndShow: the queued writes of this device are laid over its notes
   *  (the worker's projectPendingNoteText), then the store applies the rows (applySyncDelta, whole-row
   *  replaces, no version check). The editor effect then offers the row to applyRemoteNode. */
  syncAnswer(index: number): void {
    const open = this.asked.filter((a) => !a.delivered);
    const answer = open.length ? open[index % open.length] : undefined;
    if (!answer) return;
    answer.delivered = true;
    const wire = {
      last_event_id: 0, head_event_id: String(answer.head), server_id: SERVER_ID, nodes: { upsert: answer.rows, delete: [] }, edges: { upsert: [], delete: [] },
      tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
    };
    // The app's one door (lib/data/writePositions.ts takeAnswer): the page's watermark decides, then this world's local
    // copy judges and stores it as the worker does (helpers/saveWorld.ts localDb.applySync: the same isCurrentAnswer and
    // the queued text laid over it), the model localDbSharedStorage and answerPositions run on the real worker.
    void takeAnswer({
      head: wire.head_event_id, serverId: wire.server_id, asked: answer.request,
      toCopy: async () => {
        const stored = await world.localDb.applySync(wire);
        return { value: stored as unknown as AppliedSyncDelta, stale: "stale" in stored, copy: stored as never };
      },
      toStore: (delta) => setData((data) => applySyncDelta(data, delta)),
    }).then(() => this.checkCurrentAnswerTaken(answer.rows));
  }

  /** S5: an answer that is the server's CURRENT state (nothing changed after it was captured) is taken by the store
   *  for every note the device has nothing of its own waiting on. Time is the wrong yardstick for "older": when the
   *  server's clock steps back, or two changes get the same millisecond, a real newer change can carry an equal or
   *  earlier updated_at than the row held, and it must still arrive. */
  private checkCurrentAnswerTaken(rows: ContentNode[]): void {
    if (world.inflight.length || world.pending.length) return;
    const current = world.rows();
    for (const row of current) {
      const asked = rows.find((r) => r.id === row.id);
      if (!asked || asked.markdown !== row.markdown || asked.title !== row.title) return; // not a current answer
    }
    for (const row of current) {
      if (this.vanished.has(row.id) || world.rejectedNotes.has(row.id)) continue;
      if (pendingFields(`node:${row.id}`).size) continue;
      if (this.lastTyped.has(row.id) && this.lastTyped.get(row.id) !== world.lastAcked.get(row.id)) continue; // typed, not saved yet
      const held = getAppState().data.nodes.find((n) => n.id === row.id);
      if (!held || nodeNeedsBody(held)) continue;
      if (held.markdown !== row.markdown || held.title !== row.title) this.stepProblems.add(`#S5 a current answer left note ${row.id} showing ${JSON.stringify(held.markdown)}/${JSON.stringify(held.title)} while the server holds ${JSON.stringify(row.markdown)}/${JSON.stringify(row.title)}`);
    }
  }

  /** S2, read after every command: the editor never shows a text this device had already replaced by an
   *  acknowledged save (unless somebody wrote that text again). */
  checkStepBack(): void {
    const open = this.open;
    if (this.vanished.has(open)) return;
    const shown = getAppState().overviewDraft;
    if (shown !== this.lastTyped.get(open) && world.retired.get(open)?.has(shown)) this.stepProblems.add(`#S2 the editor of note ${open} went back to ${JSON.stringify(shown)}, a text this device had already replaced by an acknowledged save`);
  }

  /** syncEngine.adoptBody's LRU eviction does not spare the open note (review #15). */
  evictOpenBody(): void {
    const server = world.server.get(this.open)!;
    setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === this.open ? { ...n, markdown: "", body_len: server.markdown.length } : n) }));
  }

  /** Only a request the server ... decided; the oldest first when `index` is omitted. */
  request(index: number): WorldRequest | undefined {
    const open = world.inflight;
    return open.length ? open[index % open.length] : undefined;
  }

  setOnline(online: boolean): void {
    setAppState({ online });
    if (online) void flushPendingWrites();
  }

  /** Online, every request delivered, drained, synced; false if it never calmed down. */
  async settle(): Promise<boolean> {
    for (let round = 0; round < 40; round++) {
      setAppState({ online: true });
      void flushPendingWrites();
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      for (let guard = 0; world.inflight.length && guard < 50; guard++) { world.deliver(world.inflight[0]!); await flush(); }
      while (this.unanswered) { this.syncAnswer(0); await flush(); }
      this.sync();
      await flush();
      // Each round above is the retry: the queue's own backoff timer is not a wait this settling is for.
      stopWriteRetry();
      if (!world.inflight.length && !world.pending.length && vi.getTimerCount() === 0) return true;
    }
    return false;
  }
}

const parseBody = (raw: string | null): { title?: string; markdown?: string } => {
  try { return JSON.parse(raw ?? "{}") as { title?: string; markdown?: string }; } catch { return {}; }
};

// ── invariants ──────────────────────────────────────────────────────────────

function invariants(editor: Editor, settled: boolean): string[] {
  const problems = [...editor.exitProblems, ...editor.stepProblems, ...world.violations.map((v) => `#${v.invariant} ${v.text}`)];
  if (!settled) problems.push("never settled: a request, queued write or timer is still waiting");
  const recovery = getRecoveryWrites().map((w) => ({ id: /\/api\/nodes\/([^/]+)$/.exec(w.path)?.[1], md: parseBody(w.body).markdown ?? "" }));
  for (const [token, home] of world.typed) {
    // A note deleted elsewhere keeps only what was typed here (in recovery); the other device's lines went with it.
    if (editor.vanished.has(home) && !editor.userTokens.has(token)) continue;
    const text = world.server.get(home)!.markdown;
    const count = text.split(token).length - 1;
    if (world.deleted.has(token)) {
      // Both writers changed the same lines: the merge keeps the sender's side
      // and files the other in BODY_CONFLICT, so a line the other side removed
      // may stay — by design, and recorded.
      const inConflict = world.conflicts.some((c) => c.nodeId === home && (c.base + c.incoming + c.current).includes(token));
      if (count && !inConflict && !world.rejectedNotes.has(home)) problems.push(`#2 ${token} was deleted on purpose but is back in note ${home}`);
      continue;
    }
    if (count > 1) problems.push(`#2 ${token} is in note ${home} ${count} times`);
    if (count) continue;
    const inConflict = world.conflicts.some((c) => c.nodeId === home && (c.base + c.incoming + c.current).includes(token));
    const inRecovery = recovery.some((w) => w.id === home && w.md.includes(token));
    if (!inConflict && !inRecovery) problems.push(`#1 ${token} (${editor.userTokens.has(token) ? "typed here" : "other device"}) is gone from note ${home}: not in its body, a conflict or a recovery copy`);
  }
  if (world.remoteWrites === 0 && world.merges.length) problems.push(`#S4 the server merged ${world.merges.length} save(s) of this device (request ${world.merges.map((m) => m.requestId).join(",")}) although no other device wrote`);
  const open = editor.open;
  if (!world.rejectedNotes.has(open)) {
    const draft = getAppState();
    const server = world.server.get(open)!;
    if (draft.overviewDraft !== server.markdown) problems.push(`#4 the editor shows ${JSON.stringify(draft.overviewDraft)} but the server holds ${JSON.stringify(server.markdown)}`);
    if (draft.overviewTitleDraft !== server.title) problems.push(`#4 the editor title is "${draft.overviewTitleDraft}" but the server holds "${server.title}"`);
  }
  const seen = new Map<string, number>();
  for (const row of world.rejected) {
    const id = /\/api\/nodes\/([^/]+)$/.exec(row.path)?.[1] ?? "";
    const key = bodyKey(id, parseBody(row.body));
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) if (n > 1) problems.push(`#6 the refused save ${key.slice(0, 60)} is in recovery ${n} times`);
  return problems;
}

// ── commands ────────────────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<Record<string, never>, Editor, false>;
const cmd = (name: string, run: (e: Editor) => void | Promise<void>, check: () => boolean = () => true): Cmd => ({
  check,
  run: async (_model, editor) => { await run(editor); await flush(); },
  toString: () => name,
});
const hasRequest = () => world.inflight.length > 0;
const fmt = (op: LineOp) => `${op.kind}(${op.k})`;

const C = {
  type: (op: LineOp) => cmd(`type ${fmt(op)}`, (e) => e.type(op)),
  rename: () => cmd("rename", (e) => e.rename()),
  typeRefused: (op: LineOp, unsendable: "\u0000" | "\ud83d") => cmd(`type ${fmt(op)} with ${unsendable === "\u0000" ? "a NUL" : "half a surrogate pair"}`, (e) => e.type(op, unsendable)),
  /** A body over the 2,000,000-character cap: the app refuses the save itself, like the long title. */
  typeTooLong: (op: LineOp) => cmd(`type ${fmt(op)} into a body over the length cap`, (e) => e.type(op, "y".repeat(2_000_001))),
  longTitle: () => cmd("paste a 501-character title", (e) => e.pasteLongTitle()),
  vanish: () => cmd("the open note is deleted on another device", (e) => e.vanish()),
  reload: (grace: ReloadGrace = "after its work") => cmd(grace === "at once" ? "reload the page (it dies at once)" : "reload the page", (e) => e.reload(grace)),
  switchNote: () => cmd("switch note", (e) => e.switchNote()),
  tick: () => cmd("autosave tick", (e) => e.tick()),
  pagehide: () => cmd("pagehide (keepalive flush)", (e) => e.pagehide()),
  background: () => cmd("app to background (keepalive flush)", (e) => e.background()),
  remoteBody: (note: string, op: LineOp) => cmd(`other device edits ${note}: ${fmt(op)}`, (e) => e.remoteBody(note, op)),
  remoteRename: (note: string) => cmd(`other device renames ${note}`, (e) => e.remoteRename(note)),
  sync: () => cmd("sync delta arrives", (e) => e.sync()),
  /** The device asks the server now; the answer is captured as of this moment and not delivered. */
  syncStarts: () => cmd("sync starts (answer captured, not delivered)", (e) => e.syncStarts()),
  syncAnswer: (i = 0) => cmd(`captured sync answer #${i} delivered`, (e) => e.syncAnswer(i), () => editor.unanswered > 0),
  /** The server's clock is set back by `ms` (a time correction, a restore from an older backup). */
  serverClockStepsBack: (ms: number) => cmd(`the server's clock steps back ${ms / 1000} s`, () => world.serverClockStepsBack(ms)),
  /** Changes made while the clock holds carry the same updated_at (the same millisecond). */
  serverClockFreezes: () => cmd("the server's clock stops (changes get the same millisecond)", () => world.serverClockFreezes()),
  serverClockRuns: () => cmd("the server's clock runs again", () => world.serverClockRuns()),
  evict: () => cmd("open note's body evicted from memory", (e) => e.evictOpenBody()),
  deliver: (i = 0) => cmd(`request #${i} delivered`, (e) => { const r = e.request(i); if (r) world.deliver(r); }, hasRequest),
  failRetry: (kind: "503" | "network", i = 0) => cmd(`request #${i} fails (${kind}, not applied)`, (e) => { const r = e.request(i); if (r) world.failRetryably(r, kind); }, hasRequest),
  failPermanent: (i = 0) => cmd(`request #${i} refused (422)`, (e) => { const r = e.request(i); if (r) world.failPermanently(r); }, hasRequest),
  lose: (i = 0) => cmd(`request #${i} applied, response lost`, (e) => { const r = e.request(i); if (r) world.loseResponse(r); }, hasRequest),
  offline: () => cmd("go offline", (e) => e.setOnline(false)),
  online: () => cmd("go online", (e) => e.setOnline(true)),
  drain: () => cmd("queue drain retry", () => { void flushPendingWrites(); }),
  /** Nothing answers for longer than a send may take (writeQueue WRITE_ATTEMPT_DEADLINE_MS): the save is given up on
   *  and queued under its key; the server may still get the first attempt (the world decides it later). */
  timeout: () => cmd("no answer for 26 s (the send deadline passes)", async () => { await vi.advanceTimersByTimeAsync(26_000); }),
};

const lineOp = fc.record({ kind: fc.constantFrom<LineKind>("append", "prepend", "insert", "delete", "replace", "extend"), k: fc.nat(4) });
const noteId = fc.constantFrom("a", "b");
const index = fc.nat(2);
const commandKinds: Array<[kind: string, weight: number, arb: fc.Arbitrary<Cmd>]> = [
  ["type", 4, lineOp.map(C.type)],
  ["rename", 2, fc.constant(C.rename())],
  ["typeRefused", 1, fc.tuple(lineOp, fc.constantFrom<"\u0000" | "\ud83d">("\u0000", "\ud83d")).map(([op, bad]) => C.typeRefused(op, bad))],
  ["typeTooLong", 1, lineOp.map((op) => C.typeTooLong(op))],
  ["longTitle", 1, fc.constant(C.longTitle())],
  ["vanish", 1, fc.constant(C.vanish())],
  ["reload", 1, fc.constantFrom<ReloadGrace>("after its work", "at once").map(C.reload)],
  ["switch", 2, fc.constant(C.switchNote())],
  ["tick", 3, fc.constant(C.tick())],
  ["pagehide", 1, fc.constant(C.pagehide())],
  ["background", 1, fc.constant(C.background())],
  ["remoteBody", 2, fc.tuple(noteId, lineOp).map(([n, op]) => C.remoteBody(n, op))],
  ["remoteRename", 1, noteId.map(C.remoteRename)],
  ["sync", 2, fc.constant(C.sync())],
  ["syncStarts", 2, fc.constant(C.syncStarts())],
  ["syncAnswer", 3, index.map(C.syncAnswer)],
  ["serverClockStepsBack", 1, fc.constantFrom(1, 1000, 60_000, 3_600_000).map(C.serverClockStepsBack)],
  ["serverClockFreezes", 1, fc.constant(C.serverClockFreezes())],
  ["serverClockRuns", 1, fc.constant(C.serverClockRuns())],
  ["evict", 1, fc.constant(C.evict())],
  ["deliver", 4, index.map(C.deliver)],
  ["failRetry", 1, fc.tuple(fc.constantFrom<"503" | "network">("503", "network"), index).map(([k, i]) => C.failRetry(k, i))],
  ["failPermanent", 1, index.map(C.failPermanent)],
  ["lose", 1, index.map(C.lose)],
  ["offline", 1, fc.constant(C.offline())],
  ["online", 1, fc.constant(C.online())],
  ["drain", 1, fc.constant(C.drain())],
  ["timeout", 1, fc.constant(C.timeout())],
];
/** PROPS_WITHOUT=rename,evict leaves those commands out (kinds are the names
 *  above), to look past a known bug the same way PROPS_SKIP does. */
const WITHOUT = (process.env.PROPS_WITHOUT ?? "").split(",").filter(Boolean);
const commandArbs = commandKinds
  .filter(([kind]) => !WITHOUT.includes(kind))
  .flatMap(([, weight, arb]) => Array.from({ length: weight }, () => arb));

const editor = new Editor();

async function runSequence(commands: Iterable<Cmd>): Promise<string[]> {
  await editor.setup();
  try {
    for (const command of commands) {
      if (command.check({})) await command.run({}, editor);
      if (process.env.DBG) console.log("[dbg]", command.toString(), JSON.stringify({ rec: getRecoveryWrites().map((w) => [w.rejection ? "R" : "U", w.body]), rej: world.rejected.map((w) => w.body), pend: world.pending.map((w) => w.body), req: world.requests.map((r) => [r.id, r.state, r.orphan ? "orphan" : "", JSON.stringify(r.body)]), srv: world.server.get("a")!.markdown }));
      editor.checkStepBack();
    }
    const settled = await editor.settle();
    if (process.env.DBG) console.log("[dbg] settled", JSON.stringify({ rec: getRecoveryWrites().map((w) => [w.rejection ? "R" : "U", w.body]), rej: world.rejected.map((w) => w.body), pend: world.pending.map((w) => w.body), req: world.requests.map((r) => [r.id, r.state, r.orphan ? "orphan" : "", JSON.stringify(r.body)]), srv: world.server.get("a")!.markdown }));
    return invariants(editor, settled).filter((p) => !SKIP.some((prefix) => p.startsWith(prefix)));
  } finally { editor.teardown(); }
}

describe("save path under random timing", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the fake server's merge guard is the backend's (nodeUpdate.ts)", () => {
    const source = readFileSync(resolve(__dirname, "../../../../backend/src/services/nodeUpdate.ts"), "utf8");
    expect(source).toContain("oldBody !== baseMarkdown && oldBody !== newBody\n");
    expect(mergeGuard("x", "y", "z")).toBe(true);
    expect(mergeGuard("x", "x", "z")).toBe(false);
    expect(mergeGuard("x", "y", "y")).toBe(true);
  });

  // The reload above boots the way the app does; if syncEngine.runBoot changes its order, this world must follow.
  it("the boot order is syncEngine's (left writes queued before the copy is shown)", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/data/syncEngine.ts"), "utf8");
    const boot = source.slice(source.indexOf("async function runBoot("));
    expect(boot.indexOf("await takeInLeftWrites();")).toBeGreaterThan(0);
    expect(boot.indexOf("await takeInLeftWrites();")).toBeLessThan(boot.indexOf("await loadBootstrapList()"));
  });

  // The review cases (fix/a1-save-path) and every case pinned since run as ordinary tests. `known` is for what is still
  // open (pass `stillOpen`, or call it directly); SAVE_TIMING_FLIP=1 runs those as ordinary tests to read the failures.
  const known = process.env.SAVE_TIMING_FLIP ? it : it.fails;
  const regression = (name: string, commands: Cmd[], expected: RegExp, stillOpen = false) =>
    (stillOpen ? known : it)(name, async () => {
      const problems = await runSequence(commands);
      // Pin the failure to the invariant the review item predicts.
      expect(problems.filter((p) => expected.test(p)), problems.join("\n")).toEqual([]);
    }, 20_000);

  // Nightly 2026-11-15, PROPS_SEED=765832 PROPS_RUNS=5000 (found at run 1292). Invariant: text typed in the editor is in the body, a conflict or a recovery copy.
  // Cause (fixed, #1737): the text was kept, but the second refusal (title only) was folded over the first in the recovery panel and hid it.
  regression("nightly 2026-11-15: a refused long title after a reload keeps the text typed before the reload (seed 765832)", [
    C.longTitle(), C.type({ kind: "append", k: 0 }), C.reload(), C.longTitle(),
  ], /gone from note/);

  // Review #1: save in flight, type more, switch away and back — the draft is
  // rebuilt from the first save's text and the next save deletes the second.
  regression("review #1: switching away and back during a save, then typing", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }),
    C.switchNote(), C.switchNote(), C.deliver(), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(),
  ], /#4|#1|#2/);

  // Review #2: pagehide while the previous save is still in flight.
  regression("review #2: pagehide with a save in flight protects nothing", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.pagehide(),
  ], /#5/);
  regression("review #2: going to the background with a save in flight", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.background(),
  ], /#5/);

  // Review #3: a rename sends the old body, the server's guard skips the merge.
  regression("review #3: renaming overwrites the other device's body edit", [
    C.remoteBody("a", { kind: "append", k: 0 }), C.rename(), C.tick(), C.deliver(),
  ], /#1/);

  // Review #11: a body save carries the title draft over a newer remote rename.
  regression("review #11: typing overwrites the other device's rename", [
    C.remoteRename("a"), C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#3/);

  // Review #12: a refused save is sent again on the next switch.
  regression("review #12: a refused save is re-sent when switching notes", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.failPermanent(), C.switchNote(), C.deliver(),
  ], /#6|#3/);

  // Review #3, second half: the body changed back to the original text counts
  // as "unchanged" to the same guard.
  regression("review #3: typing a line and deleting it again overwrites the other device's edit", [
    C.type({ kind: "append", k: 0 }), C.type({ kind: "delete", k: 2 }),
    C.remoteBody("a", { kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#1/);

  // Review #15: the open note's body is evicted from memory (syncEngine.adoptBody
  // spares only the note being received), the editor reseeds, the save of the
  // text typed before is refused and its snapshot is sent again against the
  // base the reseed took from the other device's newer text: their line goes.
  regression("review #15: eviction of the open note's body, a refused save, then the other device edits", [
    C.type({ kind: "append", k: 0 }), C.evict(), C.failPermanent(),
    C.remoteBody("a", { kind: "append", k: 0 }),
  ], /#1/);

  // Not in the review: after a refused save of note A the editor holds note B,
  // but `isDirty` / `pendingSave` still describe A, so applyRemoteNode ignores
  // every newer row of B (the editor shows B's old text until it is typed in).
  regression("not in review: a refused save of the previous note blocks remote updates of the open note", [
    C.type({ kind: "append", k: 0 }), C.remoteBody("b", { kind: "append", k: 0 }),
    C.switchNote(), C.failPermanent(),
  ], /#4/);

  // Not in the review, found by running this file against fix/a1-save-path:
  // the other device renames the note while the user has unsaved typing. The
  // sync delta reaches the store while the draft is dirty (applyRemoteNode
  // returns), the save then settles and the row already holds the new title,
  // so nothing re-applies it and the editor keeps the old one. On main the
  // stale title is also sent back (#11), so it fails as #3 there.
  regression("not in review: a rename from the other device arriving during typing never reaches the editor", [
    C.type({ kind: "append", k: 0 }), C.remoteRename("a"), C.sync(),
  ], /#3|#4/);

  // Found by the random property after fix/a1-save-path (seeds 1 and 3): a
  // keepalive flush after a rename leaves the newest typing unprotected.
  regression("rename, switch, type, autosave, background leaves the newest typing unprotected", [
    C.rename(), C.switchNote(), C.type({ kind: "append", k: 0 }), C.tick(), C.background(),
  ], /#5/);
  regression("rename, background, type, autosave, pagehide leaves the newest typing unprotected", [
    C.rename(), C.background(), C.type({ kind: "append", k: 0 }), C.tick(), C.pagehide(), C.online(),
  ], /#5/);

  // Found by the random property with PROPS_WITHOUT=rename,remoteRename (seeds
  // 184107404, 315258335, 756975589, 984733764): no rename is needed. Typing
  // after an earlier save that is still in flight was neither sent nor in a
  // recovery copy when the page went away.
  regression("#5 without rename: background, type, autosave, pagehide (seed 184107404)", [
    C.type({ kind: "append", k: 0 }), C.background(), C.type({ kind: "append", k: 0 }), C.tick(), C.pagehide(),
  ], /#5/);
  regression("#5 without rename: switch, type, body evicted, background (seed 315258335)", [
    C.type({ kind: "append", k: 0 }), C.switchNote(), C.type({ kind: "append", k: 0 }), C.evict(), C.background(),
  ], /#5/);
  regression("#5 without rename: switch away and back twice, background (seed 756975589)", [
    C.type({ kind: "append", k: 0 }), C.switchNote(), C.type({ kind: "append", k: 0 }),
    C.switchNote(), C.switchNote(), C.background(),
  ], /#5/);
  regression("#5 without rename: two autosaves, pagehide, other device edits (seed 984733764)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.tick(), C.pagehide(),
    C.remoteBody("a", { kind: "append", k: 0 }),
  ], /#5/);

  // Seeds 837257824 and 364135549: after the server refused a save, typing
  // again made a new snapshot whose save was sent although the refused text
  // was still part of it (a refused save must be in recovery once, not sent again).
  regression("#6 a refused autosave is not sent again by later typing (seed 837257824)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.failPermanent(),
    C.type({ kind: "prepend", k: 0 }), C.type({ kind: "delete", k: 0 }), C.tick(),
  ], /#6/);
  regression("#6 a refused keepalive save is not sent again by later typing (seed 364135549)", [
    C.type({ kind: "append", k: 0 }), C.pagehide(), C.type({ kind: "prepend", k: 0 }),
    C.failPermanent(), C.type({ kind: "delete", k: 0 }),
  ], /#6/);

  // Seed 555555: the refusal of the first autosave arrives while the second is
  // already queued; deleting the newer line brings the text back to exactly the
  // refused one, and that must not be sent either.
  regression("#6 typing back to the refused text is not sent (seed 555555)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.tick(),
    C.failPermanent(), C.type({ kind: "delete", k: 3 }), C.deliver(),
  ], /#6/);

  // Nightly 2026-11-13, seed 49662288. The rename delta arrived while the draft was dirty, the body was
  // evicted and the save (which did not send the untouched title) was still unsettled when the editor was
  // reseeded: the reseed took the save's snapshot title (the old one) over the row's newer title.
  regression("nightly 2026-11-13: rename during typing, body evicted, then the save fails with 503, editor keeps the old title (seed 49662288)", [
    C.remoteRename("a"), C.type({ kind: "append", k: 0 }), C.sync(), C.evict(), C.failRetry("503", 0),
  ], /#4/);

  // Same family, found while checking other seeds: the rename reaches the editor only after the save
  // settled, and the reseed after the eviction had bumped the revision that gated the second look.
  regression("rename during typing, body evicted and loaded again, autosave settles later (seeds 444, 555)", [
    C.type({ kind: "append", k: 0 }), C.remoteRename("a"), C.evict(), C.sync(), C.tick(),
  ], /#4/);
  // Nightly 2026-11-19, PROPS_SEED=111421 PROPS_RUNS=2000 (found at run 133). Invariant #4: the editor shows what the server holds.
  // Fixed on main by one of #1794, #1888, #1900 (not bisected): found on e90947b, passes after merging 8bd52cd; kept as an ordinary regression.
  regression("nightly 2026-11-19: other device edits, typing, body evicted, rename, pagehide: editor misses the merged line (seed 111421)", [
    C.remoteBody("a", { kind: "append", k: 0 }), C.type({ kind: "append", k: 0 }), C.evict(), C.rename(), C.pagehide(),
  ], /#4/);
  // Same family (seeds 111, 222, 333): a page-exit save never looked at the row again.
  regression("rename during typing, pagehide flush, the page stays (seeds 111, 222)", [
    C.remoteRename("a"), C.type({ kind: "append", k: 0 }), C.sync(), C.pagehide(), C.deliver(),
  ], /#4/);
  // Nightly 2026-11-15 (seed 765832): a long title pasted, body typed, reload, the long title pasted again. The second
  // refusal carries less text than the first; it used to hide the first one behind itself in the recovery panel.
  // Seed 7 (found while checking the fix above; the same on main). Real: it fails the same way since reload() is a real
  // reload (a new module load; see loadPage). The new page shows the queued text (the keepalive save's row, laid over
  // the copy) and the editor takes it as its base. The server refuses that save (the old page's request and the new
  // page's resend, one key); the rename after it then carried the refused text as body AND base, the server kept no
  // body change, and the app counted the text as saved and dropped the refused copy (settleRefusedNoteText): gone.
  // Fixed by one rule (note-writes.md "沒有被收下的文字不算數"): a refused text is never a base (writeRecovery
  // withoutRefusedBase, where every save leaves), and a refused copy goes only on the server's own answer.
  regression("seed 7: reload with a keepalive save in flight, rename, then that save is refused", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.rename(), C.failPermanent(0),
  ], /#1|#S4/);
  regression("nightly 2026-11-15: long title, typing, reload, long title again keeps the typing in recovery (seed 765832)", [
    C.longTitle(), C.type({ kind: "append", k: 0 }), C.reload(), C.longTitle(),
  ], /#1/);

  // Owner report 2026-11-16 (one person, one tablet, typing alone): two saves of the same note two seconds
  // apart carried the SAME base and the server merged the second "with another writer". A sync answer asked
  // before save 1 was acknowledged reaches the device after it; its row is older than the text just saved.
  // What went wrong (S2: the editor shows a text an acknowledged save replaced; S3: the next save's base is that
  // old text; S4: the server merges although nobody else wrote): the answer's row replaced the saved one in the
  // store, whole, and applyRemoteNode took it for a newer remote text. Fixed where the answer enters (lib/rowAge.ts:
  // a copy of a row from before the one held is not taken, in the store and in the local copy alike).
  regression("report 2026-11-16: S2/S3/S4 a sync answer asked before a save and delivered after its acknowledgement", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncStarts(), C.deliver(), C.syncAnswer(0),
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#S[234]/);
  regression("report 2026-11-16: S2/S3/S4 the stale answer arrives between two acknowledged saves", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncStarts(), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncAnswer(0), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#S[234]/);

  // Time is the wrong yardstick (S5). The fixed rule for a late answer must not decide "older" by the server's clock: a REAL change
  // made after the clock stepped back (a correction, a restore from an older backup) has an earlier updated_at than the row held.
  // On main these pass (no rule yet); a rule that compares updated_at (PR #1753's isOlderCopy) fails the first one:
  // the other device's text is dropped on the answer and shows only after the note changes again.
  regression("clock steps back: this device saves (acknowledged), the clock steps back 60 s, another device edits the note, the next answer must bring its text (S5)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
    C.serverClockStepsBack(60_000), C.remoteBody("a", { kind: "append", k: 0 }), C.syncStarts(), C.syncAnswer(0),
  ], /#S5|#4/);
  regression("same millisecond: this device's save and another device's edit of the note carry the same updated_at; the next answer must bring its text (S5)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.serverClockFreezes(), C.deliver(),
    C.remoteBody("a", { kind: "append", k: 0 }), C.syncStarts(), C.syncAnswer(0),
  ], /#S5|#4/);
  regression("clock steps back: another device renames the note after the step back; the next answer must bring the title (S5)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
    C.serverClockStepsBack(60_000), C.remoteRename("a"), C.syncStarts(), C.syncAnswer(0),
  ], /#S5|#4/);
  // Owner report 2026-11-19 (phone, typing alone): the newest characters went away and came back, the caret before
  // them. A sync answer asked AFTER save 1 was acknowledged carries save 1's text with save 1's time, the same time the
  // store row still had while save 2 was on its way (an unanswered save does not move the row's time), so the age rule
  // took it: the row went back to save 1's text. Save 2's answer left that text alone (it only settles a field still
  // holding what it sent) and gave the row save 2's time; once save 2 had settled, applyRemoteNode read the row as a
  // newer remote text and put it in the editor. The next answer brought save 2's text back.
  regression("report 2026-11-19: an answer asked after save 1 was acknowledged, delivered while save 2 is in flight", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(), C.syncStarts(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncAnswer(0), C.deliver(),
  ], /#S[234]/);
  // The same, and the person types in the gap (the editor shows save 1's text): is anything lost on the server?
  regression("report 2026-11-19: typing while the older text is shown loses nothing on the server", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(), C.syncStarts(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncAnswer(0), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(), C.sync(),
  ], /gone from note|#S[234]|#2 /);
  // Item 5 of the 2026-11-19 report, asked plainly: in the gap where the older text was shown, can a keystroke be
  // saved over it and lose characters on the server? Every line typed here must be in the server's body itself (not
  // only in a conflict copy), once, whatever kind of edit is made in the gap.
  for (const kind of ["append", "prepend", "insert", "extend"] as const) {
    it(`report 2026-11-19: a line typed (${kind}) while the older text is shown is in the server's body, once`, async () => {
      await editor.setup();
      try {
        for (const command of [
          C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(), C.syncStarts(),
          C.type({ kind: kind === "extend" ? "extend" : "append", k: 0 }), C.tick(), C.syncAnswer(0), C.deliver(),
          C.type({ kind, k: 1 }), C.tick(), C.deliver(),
        ]) if (command.check({})) await command.run({}, editor);
        expect(await editor.settle()).toBe(true);
        const body = world.server.get("a")!.markdown;
        const typed = [...world.typed].filter(([token, home]) => home === "a" && editor.userTokens.has(token)).map(([token]) => token);
        expect(typed.length).toBeGreaterThanOrEqual(3);
        for (const token of typed) expect(body.split(token).length - 1, `${token} in ${JSON.stringify(body)}`).toBe(1);
        expect(world.conflicts.filter((c) => c.nodeId === "a")).toEqual([]);
      } finally { editor.teardown(); }
    }, 20_000);
  }
  // The answer read while save 2 is in flight carries another device's NEWER line: it must still reach the editor.
  regression("report 2026-11-19: another device's newer line in an answer held under an unanswered save still arrives", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.remoteBody("a", { kind: "prepend", k: 0 }), C.syncStarts(), C.syncAnswer(0), C.deliver(),
  ], /#4|gone from note|#S[234]/);

  // Found by the random property (PROPS_RUNS=5000, seeds 2 and 3 below). They were found with the old simulated reload
  // (it kept the in-memory store); they also pass with the real reload (fix/save-in-flight-across-reload). A late answer asked before the
  // typing overwrites the optimistic row while the keepalive save is in flight; the reseed then reads that row.
  // Fixed with the 2026-11-19 report (same cause): a server copy no longer replaces a field whose edit has no answer
  // yet (storeOps.serverCopyOver), so these run as ordinary tests.
  regression("late sync answer (seed 2): rename, answer asked before the save and delivered after it started, reload: the editor shows the old title", [
    C.rename(), C.syncStarts(), C.tick(), C.syncAnswer(0), C.reload(),
  ], /#4/);
  // Nightly 2026-11-17 on main (PR #1866, PROPS_SEED=20261117 PROPS_RUNS=5000, run 1950): the same family. The answer is read
  // before the keepalive rename is applied, and no acknowledgement has arrived when it is delivered, so no watermark can
  // refuse it: the position rule (lib/answerPositions.ts) covers answers read before an ACKNOWLEDGED write only.
  regression("nightly 2026-11-17 (#1866): rename, reload, an answer asked, delivered, request #0 fails (503): the editor shows the old title", [
    C.rename(), C.reload(), C.syncStarts(), C.syncAnswer(0), C.failRetry("503", 0),
  ], /#4/); // fixed with the 2026-11-19 report: the answer no longer replaces a title whose rename has no answer yet
  regression("late sync answer (seed 21): typing, reload, answer, switch away and back: the editor shows the text from before", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.syncStarts(), C.syncAnswer(0), C.switchNote(), C.switchNote(),
  ], /#4/);
  // These two and seed 3 below also pass since every save is recorded in the queue before it is sent (writeQueue.recordWrite):
  // the late answer lands with the queued text projected over it (pendingNoteProjection), like any answer that meets a queued write.

  // Seed 3 with S2–S4 and #4 skipped (PROPS_SKIP=S2,S3,S4,4): the same family, now with a body save that carries the old title.
  regression("late sync answer (seed 3): rename, reload, answer, typing, a failed save, background: a save carries the old title over the rename", [
    C.rename(), C.reload(), C.syncStarts(), C.syncAnswer(0), C.type({ kind: "append", k: 0 }),
    C.failRetry("503", 0), C.background(), C.type({ kind: "append", k: 0 }),
  ], /#3/);

  // PROPS_RUNS=5000 on main, three seeds (2026-11-16, with the clock commands in the generator). None of the three involves
  // the clock; they are the same open families as above (found with the old simulated reload; a refused save left as a base).
  regression("5000 runs, seed 222: an answer asked before typing, reload, the answer delivered, pagehide: the editor shows the text from before (#4)", [
    C.syncStarts(), C.type({ kind: "append", k: 0 }), C.reload(), C.syncAnswer(0), C.pagehide(),
  ], /#4/); // fixed with the 2026-11-19 report (storeOps.serverCopyOver keeps a field whose edit has no answer yet)
  regression("5000 runs, seed 3333: typing, reload, an answer, rename, body evicted: a save carries a base already replaced (S3)", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.syncStarts(), C.syncAnswer(0), C.rename(), C.evict(),
  ], /#S3/); // fixed with the 2026-11-19 report (the same)
  // Only the old simulated reload failed this (it kept the old page's store and its unanswered saves); with a real reload it
  // passes on main as well, so it is an ordinary test now.
  regression("5000 runs, seed 11 (no sync, no clock): rename, a NUL typed, reload, rename again: the next save carries a base already replaced (S3)", [
    C.rename(), C.tick(), C.typeRefused({ kind: "delete", k: 0 }, "\u0000"), C.reload(), C.rename(), C.deliver(0), C.switchNote(),
  ], /#S3/);

  // Seed 3: no sync involved. The keepalive save of the first typing is refused after the person typed something
  // the client itself refuses (NUL); the next save still carried the refused text as its base, the server had moved
  // not at all and the save was merged. Invariant S4 only: nobody else wrote. Real (fails the same with a real reload);
  // fixed by the same rule as seed 7.
  regression("S4 (seed 3): typing, reload, a NUL typed, the first save refused, typing again is merged with no other writer", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.typeRefused({ kind: "delete", k: 0 }, "\u0000"),
    C.failPermanent(0), C.type({ kind: "append", k: 0 }),
  ], /#S4/);

  // Red on main 48f861028 and after, every time (the task of fix/save-in-flight-across-reload): one person typing, and the
  // next save was sent on top of the text the server had refused, so the server merged it "with another writer". Real.
  regression("type, reload, type, request #0 refused (422): #S4", [C.type({ kind: "append", k: 0 }), C.reload(), C.type({ kind: "append", k: 0 }), C.failPermanent(0)], /#S4/);

  // Found by fresh seeds once reload() was a real reload (PROPS_RUNS=2000, seeds 630136798 and 86745993; 1835455566).
  // The old page dies before its worker answers (the likely case on a real reload: the worker's reply is a task the
  // unloading page no longer runs), so its exit save is only the recovery copy in localStorage. The new page showed
  // the local copy (the text from before) and took the copy into the queue only on its first drain: the person typed
  // on the old text and that save was merged over the adopted one (S3, S4), or the editor went back to the text from
  // before after the server had it (S2). Fixed: the boot takes it into the queue before the first paint
  // (writeQueue.takeInLeftWrites in syncEngine.runBoot), so the first paint lays it over the copy.
  regression("reload at once (seed 630136798): type, the page dies before its worker answers, type again: no merge", [
    C.type({ kind: "append", k: 0 }), C.reload("at once"), C.type({ kind: "append", k: 0 }),
  ], /#S[234]|gone from note/);
  regression("reload at once (seed 1835455566): type, the page dies before its worker answers, the save delivered: the editor keeps the text", [
    C.type({ kind: "append", k: 0 }), C.reload("at once"), C.deliver(0), C.serverClockFreezes(),
  ], /#S[234]|#4|gone from note/);

  // Found by a fresh seed (PROPS_SEED=432211385 PROPS_RUNS=2000), NOT fixed here (another kind of problem: nothing is lost).
  // A save refused before a reload; after the reload the person makes the same edit again and the app sends the very
  // text the server already refused (#6). Which texts were refused lives in draftActions' memory (refusedText) and goes
  // with the page; the recovery panel still holds it, but the editor does not read it from there. Same on main with
  // the old simulated reload (it cleared that memory too). Kept as a literal expected failure.
  known("open (seed 432211385): refused, reload, the same edit typed again is sent again (#6)", async () => {
    const problems = await runSequence([
      C.type({ kind: "delete", k: 0 }), C.background(), C.failPermanent(0), C.reload(), C.type({ kind: "delete", k: 0 }),
      C.switchNote(), C.typeTooLong({ kind: "append", k: 0 }),
    ]);
    expect(problems.filter((p) => /#6 /.test(p)), problems.join("\n")).toEqual([]);
  }, 20_000);

  // Found by a fresh seed after the fix (PROPS_SEED=609062751 PROPS_RUNS=5000), NOT fixed here (nothing is lost: the
  // text is in recovery twice). A title the app itself refuses (over 500 characters) on a note deleted on another
  // device, a reload, the same title pasted again: the page-exit save keeps a second copy of the same refusal (#6,
  // "in recovery once"). The app's own refusals get a fresh key each time and the copy that says "already kept" is
  // looked up only among durable rows written by this page. Fails the same without this branch's product change.
  known("open (seed 609062751): a refusal of the app's own, reload, the same refusal again is kept twice (#6)", async () => {
    const problems = await runSequence([C.longTitle(), C.vanish(), C.reload(), C.longTitle(), C.background()]);
    expect(problems.filter((p) => /#6 /.test(p)), problems.join("\n")).toEqual([]);
  }, 20_000);

  // Public run 44646109326 on main 037892ea1 (owner note 2026-11-20, PROPS_SEED=1082554938 PROPS_RUNS=100): the same family
  // without a reload. The keepalive save at pagehide is built on the autosave still in flight (its text as base); the
  // autosave is refused, and the keepalive save went out with the refused text as its base, so the server merged it
  // although nobody else wrote. withoutRefusedBase covers it: the refusal is in recovery before the next save leaves.
  regression("seed 1082554938: autosave in flight, type, pagehide, the autosave refused: no merge (S4)", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.pagehide(), C.failPermanent(0),
  ], /#S4|gone from note/);

  // The typed text is somewhere it can be found (the server, the queue or recovery) whatever happens to the save on its
  // way: one case per way (fix/save-in-flight-across-reload). Invariant #1 (lost), and S4 (merged with nobody).
  const typedTextKept = /gone from note|#S4|#2 /;
  regression("in flight across: a refusal (4xx), then typing again", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.failPermanent(0), C.type({ kind: "append", k: 0 }), C.tick(),
  ], typedTextKept);
  regression("in flight across: no answer past the send deadline, then a refusal of the first attempt", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.timeout(), C.type({ kind: "append", k: 0 }), C.tick(), C.failPermanent(0),
  ], typedTextKept);
  regression("in flight across: the page is closed with a save on its way (it dies at once), opened again, the save refused", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.type({ kind: "append", k: 0 }), C.reload("at once"), C.failPermanent(0), C.type({ kind: "append", k: 0 }),
  ], typedTextKept);
  regression("in flight across: a reload with the save on its way, the save refused, typing again", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.reload(), C.failPermanent(0), C.type({ kind: "append", k: 0 }), C.tick(),
  ], typedTextKept);
  regression("in flight across: a reload, the save refused, then a rename", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.failPermanent(0), C.rename(), C.tick(),
  ], typedTextKept);
  regression("in flight across: a reload, the save refused, another note opened and back, typing again", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.switchNote(), C.failPermanent(0), C.switchNote(), C.type({ kind: "append", k: 0 }),
  ], typedTextKept);

  // A save the app itself refuses before sending (lib/data/noteWriter.ts) keeps the typed text in the same
  // recovery store as a server refusal: it survives opening another note and a reload (the durable row).
  // Each case: type, let the autosave be refused, open the other note, then look at recovery.
  const keptInRecovery = (noteId: string, text: string) => {
    const held = getRecoveryWrites().filter((w) => w.path === `/api/nodes/${noteId}` && w.noteText?.markdown === text);
    const durable = world.rejected.filter((w) => w.path === `/api/nodes/${noteId}` && parseBody(w.body).markdown === text);
    return { held: held.length, durable: durable.length };
  };
  const refusedBeforeSending = (name: string, run: (open: string) => Promise<void>) =>
    it(`refused before sending: ${name}`, async () => {
      await editor.setup();
      try {
        const open = editor.open;
        await run(open);
        editor.switchNote();
        await flush();
        await editor.tick();
        await flush();
        expect(world.requests.filter((r) => r.nodeId === open), "nothing was sent").toEqual([]);
      } finally { editor.teardown(); }
    }, 20_000);

  refusedBeforeSending("a title over the length cap, then ten minutes of typing in the body", async (open) => {
    typeIntoDraft(open, { title: "x".repeat(501) });
    await editor.tick();
    typeIntoDraft(open, { markdown: "ten minutes of typing" });
    await editor.tick();
    await flush();
    expect(keptInRecovery(open, "ten minutes of typing")).toEqual({ held: 1, durable: 1 });
    editor.switchNote();
    await flush();
    expect(keptInRecovery(open, "ten minutes of typing")).toEqual({ held: 1, durable: 1 });
    editor.switchNote();
  });

  refusedBeforeSending("a NUL character in the body", async (open) => {
    typeIntoDraft(open, { markdown: "before\u0000after" });
    await editor.tick();
    await flush();
    expect(keptInRecovery(open, "before\u0000after")).toEqual({ held: 1, durable: 1 });
  });

  refusedBeforeSending("half a surrogate pair in the body", async (open) => {
    typeIntoDraft(open, { markdown: "half \ud83d pair" });
    await editor.tick();
    await flush();
    expect(keptInRecovery(open, "half \ud83d pair")).toEqual({ held: 1, durable: 1 });
  });

  refusedBeforeSending("the note was deleted on another device while typing", async (open) => {
    typeIntoDraft(open, { markdown: "typed while it was deleted" });
    setData((data) => ({ ...data, nodes: data.nodes.filter((n) => n.id !== open) }));
    await flush();
    await editor.tick();
    await flush();
    expect(keptInRecovery(open, "typed while it was deleted")).toEqual({ held: 1, durable: 1 });
  });

  // The four refusals are one code path (noteWriter.change): each is also still in the recovery panel after a
  // reload, goes away when the person discards it, and (the typed text being what the person fixed) clears once
  // the same text is saved.
  const refusals: Array<[name: string, text: string, refuse: (open: string) => Promise<void>]> = [
    ["title over the cap", "body typed beside a long title", async (open) => {
      typeIntoDraft(open, { title: "x".repeat(501) }); await editor.tick();
      typeIntoDraft(open, { markdown: "body typed beside a long title" }); await editor.tick();
    }],
    ["NUL in the body", "has\u0000nul", async (open) => { typeIntoDraft(open, { markdown: "has\u0000nul" }); await editor.tick(); }],
    ["half a surrogate pair", "half \ud83d pair", async (open) => { typeIntoDraft(open, { markdown: "half \ud83d pair" }); await editor.tick(); }],
    ["body over the cap", "y".repeat(2_000_001), async (open) => { typeIntoDraft(open, { markdown: "y".repeat(2_000_001) }); await editor.tick(); }],
    ["note deleted elsewhere", "typed while it was deleted", async (open) => {
      typeIntoDraft(open, { markdown: "typed while it was deleted" });
      setData((data) => ({ ...data, nodes: data.nodes.filter((n) => n.id !== open) }));
      await flush(); await editor.tick();
    }],
  ];
  for (const [name, text, refuse] of refusals) {
    it(`refused before sending (${name}): still in recovery after a reload, gone once discarded`, async () => {
      await editor.setup();
      try {
        const open = editor.open;
        await refuse(open); await flush();
        editor.switchNote(); await flush();
        await editor.reload(); await flush();
        expect(keptInRecovery(open, text), "after switching note and reloading").toEqual({ held: 1, durable: 1 });
        const entry = getRecoveryWrites().find((w) => w.noteText?.markdown === text)!;
        await removeRecoveryWrite(entry.id);
        await editor.reload(); await flush();
        expect(keptInRecovery(open, text), "after discarding and reloading").toEqual({ held: 0, durable: 0 });
        expect(world.requests.filter((r) => r.nodeId === open), "nothing was sent").toEqual([]);
      } finally { editor.teardown(); }
    }, 20_000);
  }

  it("refused before sending: shortening the title saves the typed text and clears its recovery entry", async () => {
    await editor.setup();
    try {
      const open = editor.open;
      typeIntoDraft(open, { title: "x".repeat(501) }); await editor.tick();
      typeIntoDraft(open, { markdown: "typed beside a long title" }); await editor.tick(); await flush();
      expect(keptInRecovery(open, "typed beside a long title")).toEqual({ held: 1, durable: 1 });
      typeIntoDraft(open, { title: "A short title" }); await editor.tick(); await flush();
      world.deliver(world.inflight[0]!); await flush();
      expect(world.server.get(open)!.markdown).toBe("typed beside a long title");
      expect(keptInRecovery(open, "typed beside a long title"), "saved text is not also left in recovery").toEqual({ held: 0, durable: 0 });
    } finally { editor.teardown(); }
  }, 20_000);

  // A save is in flight, the person opens another note and comes back: when the save succeeds the status
  // must leave "saving" without another keystroke.
  it("status leaves 'saving' when a save finishes after switching away and back", async () => {
    await editor.setup();
    try {
      const open = editor.open;
      typeIntoDraft(open, { markdown: "typed before the switch" });
      await editor.tick();
      expect(getAppState().saveStatus).toBe("saving");
      editor.switchNote();
      await flush();
      editor.switchNote();
      await flush();
      expect(getAppState().saveStatus).toBe("saving");
      world.deliver(world.inflight[0]!);
      await flush();
      expect(getAppState().saveStatus).toBe("saved");
    } finally { editor.teardown(); }
  }, 20_000);

  it("random interleavings keep every invariant", async () => {
    try {
      await fc.assert(
        fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 20 }), async (commands) => {
          const problems = await runSequence(commands);
          if (problems.length) throw new Error(problems.join("\n"));
        }),
        { seed: SEED, numRuns: RUNS, endOnFailure: false },
      );
    } catch (error) {
      console.error(`saveTiming failed — replay with PROPS_SEED=${SEED} PROPS_RUNS=${RUNS}`);
      throw error;
    }
  }, 120_000);
});
