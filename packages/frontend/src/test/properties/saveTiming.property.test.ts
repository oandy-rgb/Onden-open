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
//   S1–S4 (a late sync answer, the owner report 2026-11-16; commands `syncStarts` / `syncAnswer`):
//   S1 once a save of this device is acknowledged, the editor's base is never older than that save
//      (the base is private to draftActions, so it is read where it is used: S3)
//   S2 the editor never shows a text an acknowledged save of this device already replaced (unless somebody typed or wrote it again)
//   S3 a save request never carries a base this device already replaced by an acknowledged save
//   S4 with no other device writing, the server never merges a save of this device
//   (1 also covers saves the CLIENT refuses before sending: a title over 500 characters, a body over the cap, NUL, half a surrogate
//    pair, the note gone from the store; the generator types them, deletes the open note elsewhere, and reloads)
//
// STATUS (fix/save-keepalive-resend; seed 7 below is open): #1–#3, #5, #6 hold on 20 extra seeds x 5000
// runs; the only open one is #4 (a rename from the other device that arrives
// while the user types never reaches the editor; fixed, see the nightly 2026-11-13 cases).
// Older note: these failed on main (review 2026-10-24 data-integrity #1 #2 #3 #11
// #12 #15; fixes in PR fix/a1-save-path). The named cases and the random
// property are `it.fails`. After fix/a1-save-path merges, flip them (see FLIP).
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npm run test:props
//          (fast-check prints seed, path and the shrunk command list.)

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: vi.fn(async (path: string, init?: unknown) => {
    const { world } = await import("../helpers/saveWorld");
    return world.transport(path, init as never);
  }),
}));
vi.mock("../../lib/localDb", async () => {
  const { world } = await import("../helpers/saveWorld");
  return { ...world.localDb };
});

import { ApiError, nodeNeedsBody } from "../../lib/api";
import { ownerData } from "../ownerData";
import { getAppState, resetAppState, selectOverviewSelectedNode, setAppState, setData, subscribeApp } from "../../lib/appStore";
import {
  __resetDraftStateForTests, applyRemoteNode, flushPendingSave, readOverviewDraft, resetDraftForNode, typeIntoDraft,
} from "../../lib/data/draftActions";
import { pendingFields } from "../../lib/data/optimisticFields";
import { applySyncDelta } from "../../lib/data/storeOps";
import { projectPendingNoteText } from "../../lib/pendingNoteProjection";
import type { ContentNode } from "../../lib/api";
import type { AppliedSyncDelta } from "../../lib/localDb";
import { flushPendingWrites, stopWriteRetry } from "../../lib/data/writeQueue";
import { getRecoveryWrites, refreshRecoveryWrites, removeRecoveryWrite } from "../../lib/data/writeRecovery";
import { setPending } from "../../lib/data/syncStatus";
import { bindAccountStorage } from "../../lib/accountStorage";
import { bodyKey, mergeGuard, tokensIn, world, type WorldRequest } from "../helpers/saveWorld";

bindAccountStorage("u", "");
world.makeApiError = (status) => new ApiError(status, JSON.stringify({ error: "x" }));

/** PROPS_SKIP=3,6 ignores those invariants: once one bug is known, the shrinker
 *  would report it first every time and hide the others. */
const SKIP = (process.env.PROPS_SKIP ?? "").split(",").filter(Boolean).map((n) => `#${n} `);
const RUNS = Number(process.env.PROPS_RUNS ?? 100);
const SEED = Number(process.env.PROPS_SEED ?? 20261024);

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

type LineKind = "append" | "prepend" | "insert" | "delete" | "replace";
type LineOp = { kind: LineKind; k: number };

function editLines(text: string, op: LineOp, token: string): string {
  const lines = text === "" ? [] : text.split("\n");
  const at = lines.length ? op.k % lines.length : 0;
  switch (op.kind) {
    case "prepend": return [token, ...lines].join("\n");
    case "insert": lines.splice(at + 1, 0, token); return lines.join("\n");
    case "delete": if (!lines.length) return token; lines.splice(at, 1); return lines.join("\n");
    case "replace": if (!lines.length) return token; lines[at] = token; return lines.join("\n");
    default: return [...lines, token].join("\n");
  }
}

class Editor {
  userTokens = new Set<string>();
  /** Notes removed from the store (deleted on another device): their typed text can only live in recovery. */
  vanished = new Set<string>();
  exitProblems: string[] = [];
  /** Answers the device asked the server for (`syncStarts`) and has not been given yet, as the server held them then. */
  asked: Array<{ rows: ContentNode[]; delivered: boolean }> = [];
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

  /** Reload the page: pagehide first (the keepalive flush), then every in-memory draft is gone and the recovery
   *  panel is read again from storage. */
  async reload(): Promise<void> {
    this.pagehide();
    __resetDraftStateForTests();
    this.resetKey = ""; this.remoteKey = "";
    await refreshRecoveryWrites();
    this.effects();
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

  /** A sync delta: the server's rows reach the store, except fields an optimistic edit of this device still owns
   *  (lib/data/optimisticFields), and with the device's queued writes laid over them as the worker does
   *  (projectPendingNoteText: without it a delta taken while a save sits in the offline queue shows the older text). */
  sync(): void {
    const rows = projectPendingNoteText(world.rows(), world.pending as never);
    setData((data) => ({
      ...data,
      nodes: data.nodes.map((n) => {
        const s = rows.find((row) => row.id === n.id);
        if (!s) return n;
        const pending = pendingFields(`node:${n.id}`);
        return {
          ...n,
          ...(pending.has("markdown") ? {} : { markdown: s.markdown, ...(n.body_len === undefined ? {} : { body_len: s.markdown!.length }) }),
          ...(pending.has("title") ? {} : { title: s.title }),
        };
      }),
    }));
  }

  /** The device asks the server now: the answer is the rows as the server holds them at this moment, and it
   *  reaches the device only with `syncAnswer`. */
  syncStarts(): void { this.asked.push({ rows: world.rows(), delivered: false }); }

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
    const upsert = projectPendingNoteText(answer.rows, world.pending as never);
    const delta = {
      last_event_id: 0, nodes: { upsert, delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
      attributes: { upsert: [], delete: [] }, workspace: null,
    } as unknown as AppliedSyncDelta;
    setData((data) => applySyncDelta(data, delta));
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
  reload: () => cmd("reload the page", (e) => e.reload()),
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
  evict: () => cmd("open note's body evicted from memory", (e) => e.evictOpenBody()),
  deliver: (i = 0) => cmd(`request #${i} delivered`, (e) => { const r = e.request(i); if (r) world.deliver(r); }, hasRequest),
  failRetry: (kind: "503" | "network", i = 0) => cmd(`request #${i} fails (${kind}, not applied)`, (e) => { const r = e.request(i); if (r) world.failRetryably(r, kind); }, hasRequest),
  failPermanent: (i = 0) => cmd(`request #${i} refused (422)`, (e) => { const r = e.request(i); if (r) world.failPermanently(r); }, hasRequest),
  lose: (i = 0) => cmd(`request #${i} applied, response lost`, (e) => { const r = e.request(i); if (r) world.loseResponse(r); }, hasRequest),
  offline: () => cmd("go offline", (e) => e.setOnline(false)),
  online: () => cmd("go online", (e) => e.setOnline(true)),
  drain: () => cmd("queue drain retry", () => { void flushPendingWrites(); }),
};

const lineOp = fc.record({ kind: fc.constantFrom<LineKind>("append", "prepend", "insert", "delete", "replace"), k: fc.nat(4) });
const noteId = fc.constantFrom("a", "b");
const index = fc.nat(2);
const commandKinds: Array<[kind: string, weight: number, arb: fc.Arbitrary<Cmd>]> = [
  ["type", 4, lineOp.map(C.type)],
  ["rename", 2, fc.constant(C.rename())],
  ["typeRefused", 1, fc.tuple(lineOp, fc.constantFrom<"\u0000" | "\ud83d">("\u0000", "\ud83d")).map(([op, bad]) => C.typeRefused(op, bad))],
  ["typeTooLong", 1, lineOp.map((op) => C.typeTooLong(op))],
  ["longTitle", 1, fc.constant(C.longTitle())],
  ["vanish", 1, fc.constant(C.vanish())],
  ["reload", 1, fc.constant(C.reload())],
  ["switch", 2, fc.constant(C.switchNote())],
  ["tick", 3, fc.constant(C.tick())],
  ["pagehide", 1, fc.constant(C.pagehide())],
  ["background", 1, fc.constant(C.background())],
  ["remoteBody", 2, fc.tuple(noteId, lineOp).map(([n, op]) => C.remoteBody(n, op))],
  ["remoteRename", 1, noteId.map(C.remoteRename)],
  ["sync", 2, fc.constant(C.sync())],
  ["syncStarts", 2, fc.constant(C.syncStarts())],
  ["syncAnswer", 3, index.map(C.syncAnswer)],
  ["evict", 1, fc.constant(C.evict())],
  ["deliver", 4, index.map(C.deliver)],
  ["failRetry", 1, fc.tuple(fc.constantFrom<"503" | "network">("503", "network"), index).map(([k, i]) => C.failRetry(k, i))],
  ["failPermanent", 1, index.map(C.failPermanent)],
  ["lose", 1, index.map(C.lose)],
  ["offline", 1, fc.constant(C.offline())],
  ["online", 1, fc.constant(C.online())],
  ["drain", 1, fc.constant(C.drain())],
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
      editor.checkStepBack();
    }
    const settled = await editor.settle();
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

  // fix/a1-save-path fixed the review cases, so they run as ordinary tests.
  // `known` stays for what is still open after it (pass `stillOpen`): a remote
  // rename arriving during typing never reaches the editor (#4),. The two #5
  // sequences the random property found with other seeds (pinned below) are fixed. The
  // random property runs as an ordinary test on its fixed default seed.
  // SAVE_TIMING_FLIP=1 runs the open ones as ordinary tests to read the failures.
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
  // Same family (seeds 111, 222, 333): a page-exit save never looked at the row again.
  regression("rename during typing, pagehide flush, the page stays (seeds 111, 222)", [
    C.remoteRename("a"), C.type({ kind: "append", k: 0 }), C.sync(), C.pagehide(), C.deliver(),
  ], /#4/);
  // Nightly 2026-11-15 (seed 765832): a long title pasted, body typed, reload, the long title pasted again. The second
  // refusal carries less text than the first; it used to hide the first one behind itself in the recovery panel.
  // Still open (seed 7, found while checking the fix above; the same on main): reload with the keepalive save
  // still in flight, rename, and the server then refuses that first save. The rename carries the first save's
  // text as its body AND as its base, so the server keeps no body change while the client counts the text as
  // saved and drops the refused copy (settleRefusedNoteText). The simulated reload keeps the in-memory store (the
  // optimistic body), which a real reload does not: confirm in a real reload before fixing.
  regression("open (seed 7): reload with a keepalive save in flight, rename, then that save is refused", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.rename(), C.failPermanent(0),
  ], /#1/, true);
  regression("nightly 2026-11-15: long title, typing, reload, long title again keeps the typing in recovery (seed 765832)", [
    C.longTitle(), C.type({ kind: "append", k: 0 }), C.reload(), C.longTitle(),
  ], /#1/);

  // Owner report 2026-11-16 (one person, one tablet, typing alone): two saves of the same note two seconds
  // apart carried the SAME base and the server merged the second "with another writer". A sync answer asked
  // before save 1 was acknowledged reaches the device after it; its row is older than the text just saved.
  // Open on main (S2: the editor shows a text an acknowledged save replaced; S3: the next save's base is that
  // old text; S4: the server merges although nobody else wrote). Likely place (read, not verified by a fix):
  // draftActions.applyRemoteNode, the last branch ("bases.set(...)" + setAppState) takes a row older than the
  // acknowledged text for a newer remote one, because nothing tells it which text the acknowledgement made current.
  regression("report 2026-11-16: S2/S3/S4 a sync answer asked before a save and delivered after its acknowledgement", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncStarts(), C.deliver(), C.syncAnswer(0),
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#S[234]/, true);
  regression("report 2026-11-16: S2/S3/S4 the stale answer arrives between two acknowledged saves", [
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncStarts(), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.syncAnswer(0), C.deliver(),
    C.type({ kind: "append", k: 0 }), C.tick(), C.deliver(),
  ], /#S[234]/, true);

  // Found by the random property (PROPS_RUNS=5000, seeds 2 and 3 below). Both need the simulated reload, which keeps
  // the in-memory store (see "open (seed 7)"): confirm in a real reload before fixing. A late answer asked before the
  // typing overwrites the optimistic row while the keepalive save is in flight; the reseed then reads that row.
  regression("late sync answer (seed 2): rename, answer asked before the save and delivered after it started, reload: the editor shows the old title", [
    C.rename(), C.syncStarts(), C.tick(), C.syncAnswer(0), C.reload(),
  ], /#4/, true);
  regression("late sync answer (seed 21): typing, reload, answer, switch away and back: the editor shows the text from before", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.syncStarts(), C.syncAnswer(0), C.switchNote(), C.switchNote(),
  ], /#4/, true);

  // Seed 3 with S2–S4 and #4 skipped (PROPS_SKIP=S2,S3,S4,4): the same family, now with a body save that carries the old title.
  regression("late sync answer (seed 3): rename, reload, answer, typing, a failed save, background: a save carries the old title over the rename", [
    C.rename(), C.reload(), C.syncStarts(), C.syncAnswer(0), C.type({ kind: "append", k: 0 }),
    C.failRetry("503", 0), C.background(), C.type({ kind: "append", k: 0 }),
  ], /#3/, true);

  // Seed 3: no sync involved. The keepalive save of the first typing is refused after the person typed something
  // the client itself refuses (NUL); the next save still carries the refused text as its base, the server has moved
  // not at all and the save is merged. Invariant S4 only: nobody else wrote.
  regression("S4 (seed 3): typing, reload, a NUL typed, the first save refused, typing again is merged with no other writer", [
    C.type({ kind: "append", k: 0 }), C.reload(), C.typeRefused({ kind: "delete", k: 0 }, "\u0000"),
    C.failPermanent(0), C.type({ kind: "append", k: 0 }),
  ], /#S4/, true);

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
