// A fake server, transport and local database for driving the REAL note save
// path (draftActions → noteWriter → writeLifecycle → writeQueue) through
// interleavings chosen by a test (test/properties/saveTiming.property.test.ts).
//
// This file imports no app module on purpose (only types): the test mocks
// lib/api and lib/localDb with this world, and a value import of either here
// would be circular inside the mock factory.
//
// What it controls, per request: it stays in flight until the test decides —
// delivered (the server applies it), failed retryably (never applied), failed
// permanently (a 4xx, never applied) or applied with its response lost. The
// server applies a body with the backend's own threeWayMergeBody, behind the
// same guard as backend/src/services/nodeUpdate.ts (see nodeUpdate parity
// test in the property file).

import type { ContentNode } from "../../lib/api";
import { EVENT_POSITION_HEADER, READ_HEAD_HEADER, READ_SERVER_HEADER } from "@onden/markdown/contract";
import { higherPosition, isCurrentAnswer } from "../../lib/answerPositions";
import { projectPendingNoteText } from "../../lib/pendingNoteProjection";
import { threeWayMergeBody } from "../../../../backend/src/services/eventLog/bodyMerge";

type PatchBody = { title?: string; markdown?: string; base_markdown?: string };
export type RequestState = "inflight" | "applied" | "failed" | "rejected" | "lost";
export type WorldRequest = {
  id: number; nodeId: string; idemKey: string | null; keepalive: boolean; body: PatchBody;
  state: RequestState;
  /** Nobody will hear its answer: sent by a page that has died since (a reload), or given up on by the page (the send
   *  deadline aborted it). The server still decides it. */
  orphan?: true;
  resolve(value: unknown): void; reject(error: unknown): void;
};
export type RecordedConflict = { nodeId: string; base: string; incoming: string; current: string };
/** `at`: the server's own time of the note's last change (updated_at), one tick per change. */
type ServerNote = { id: string; title: string; markdown: string; at: number };

const TOKEN = /T\d+x/g;
export const tokensIn = (text: string): string[] => text.match(TOKEN) ?? [];

/** The same guard as nodeUpdate.ts: the merge only runs when the server moved
 *  since the writer's base AND the writer changed the body. */
export function mergeGuard(oldBody: string, baseMarkdown: string, newBody: string): boolean {
  return oldBody !== baseMarkdown && oldBody !== newBody;
}

export class SaveWorld {
  /** Builds an ApiError (the test supplies it: this file cannot import lib/api). */
  makeApiError: (status: number) => Error = (status) => new Error(`HTTP ${status}`);

  server = new Map<string, ServerNote>();
  requests: WorldRequest[] = [];
  conflicts: RecordedConflict[] = [];
  /** Violations the fake server saw while applying (stale title, re-sent refusal). */
  violations: Array<{ invariant: 3 | 6 | "S3"; text: string }> = [];
  /** Every time the server merged a save onto a body that moved since the save's base (the toast "merged with
   *  another writer"). With no other device writing, there is no one to merge with (invariant S4). */
  merges: Array<{ nodeId: string; requestId: number }> = [];
  /** Writes of the OTHER device in this run (bodies and renames). */
  remoteWrites = 0;
  /** Per note: texts this device already replaced by an acknowledged save. A base or a shown text that goes back
   *  to one of them is a step back, unless somebody wrote that text again afterwards (`wrote`). */
  retired = new Map<string, Set<string>>();
  /** Per note: the text of this device's newest acknowledged save (what the server answered with). */
  lastAcked = new Map<string, string>();
  /** lib/data/writePositions noteWriteResponse (the test supplies it: this file cannot import the app). */
  onResponse: (path: string, init: RequestInit, response: { ok: boolean; headers: Headers }) => void = () => {};
  /** The server's event log head: one event per change (this device's saves and the other device's writes). */
  head = 0;
  private idem = new Map<string, ServerNote & { position: number | null }>();
  private counter = 0;
  private requestSeq = 0;

  /** Every token ever written, and the note it lives in. A token is a whole
   *  line "T<n>x": unique, so "is this typing still here" is a substring test. */
  typed = new Map<string, string>();
  /** Tokens an actor removed on purpose (user or the other device). */
  deleted = new Set<string>();
  userTitles = new Set<string>();
  private appliedTitles = new Set<string>();
  rejectedBodies = new Set<string>();
  rejectedNotes = new Set<string>();

  // ── local database fake (lib/localDb) ──
  pending: Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }> = [];
  rejected: Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number; rejection: string }> = [];
  /** Per note: the text the local copy holds (upsertNode; a test that models the worker's applySync writes it too). */
  localText = new Map<string, string>();
  /** Per note: the title the local copy holds (written with localText). */
  localTitle = new Map<string, string>();
  /** Which page load is alive. A reload (pageDied) ends one: its modules are loaded afresh by the test
   *  (vi.resetModules), and what the dead one still had going reaches nothing: requests it has not sent are never
   *  sent, worker calls it has not made are never made, answers to requests it sent go nowhere. Never reset: a page's
   *  mocks keep the life they were made in. */
  life = 0;
  /** Idempotency keys the server refused: the same request is refused again (one key, one decision; a 4xx is about
   *  the request, and the backend's claim is rolled back with it, so a resend is judged the same way). */
  private refusedKeys = new Set<string>();
  private rowSeq = 0;
  /** A device with no local copy (IndexedDB blocked, a private window): answers pass through untouched, no queued text
   *  is laid over them, nothing is judged there (the page's door, takeAnswer, still is). Off at every reset. */
  copyless = false;

  reset(): void {
    this.server.clear(); this.requests = []; this.conflicts = []; this.violations = [];
    this.merges = []; this.remoteWrites = 0; this.retired.clear(); this.lastAcked.clear();
    this.idem.clear(); this.counter = 0; this.requestSeq = 0; this.head = 0;
    this.typed.clear(); this.deleted.clear(); this.userTitles.clear(); this.appliedTitles.clear();
    this.rejectedBodies.clear(); this.rejectedNotes.clear();
    this.serverClock = 0; this.clockFrozen = false;
    this.pending = []; this.rejected = []; this.rowSeq = 0; this.localText.clear(); this.localTitle.clear(); this.refusedKeys.clear(); this.reads = []; this.copyWatermark = null; this.copyless = false;
    for (const id of ["a", "b"]) {
      const lines = [this.nextToken(id), this.nextToken(id)];
      this.server.set(id, { id, title: `Note ${id.toUpperCase()}`, markdown: lines.join("\n"), at: this.tickClock() });
    }
  }

  nextToken(home: string): string {
    const token = `T${this.counter++}x`;
    this.typed.set(token, home);
    return token;
  }

  /** What an actor's edit removed: those tokens were deleted on purpose. */
  recordEdit(before: string, after: string): void {
    const kept = new Set(tokensIn(after));
    for (const token of tokensIn(before)) if (!kept.has(token)) this.deleted.add(token);
  }

  private serverClock = 0;
  /** While frozen the server's clock does not move: changes made meanwhile carry the SAME updated_at (the same millisecond). */
  private clockFrozen = false;
  private tickClock(): number { return this.clockFrozen ? this.serverClock : ++this.serverClock; }
  /** The server's clock is set back (a time correction, a restore from an older backup): changes from now on carry an
   *  EARLIER updated_at than rows this device already holds. */
  serverClockStepsBack(ms: number): void { this.serverClock -= ms / 1000; }
  serverClockFreezes(): void { this.clockFrozen = true; }
  serverClockRuns(): void { this.clockFrozen = false; }
  rows(): ContentNode[] {
    return [...this.server.values()].map((n) => this.row(n));
  }
  row(n: ServerNote): ContentNode {
    return { id: n.id, title: n.title, slug: n.id, markdown: n.markdown, node_type: "content", source_type: "manual", updated_at: new Date(Date.UTC(2026, 0, 1) + n.at * 1000).toISOString() };
  }

  // ── transport (lib/api `api`) ──
  get inflight(): WorldRequest[] { return this.requests.filter((r) => r.state === "inflight"); }

  /** GET /api/nodes/:id reads (syncEngine.hydrateNode): the row is read when the request arrives, at the server's head
   *  then (READ_HEAD_HEADER, told through the caller's onHeaders as the real server does); the answer waits until the
   *  test delivers it (`answerRead`). */
  reads: Array<{ row: ContentNode; head: number; onHeaders?: (headers: Headers) => void; resolve: (row: ContentNode) => void }> = [];
  answerRead(index = 0): void {
    const [read] = this.reads.splice(index % Math.max(this.reads.length, 1), 1);
    read?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: String(read.head), [READ_SERVER_HEADER]: SERVER_ID }));
    read?.resolve(read.row);
  }

  transport(path: string, init: { method?: string; body?: unknown; headers?: unknown; keepalive?: boolean; onHeaders?: (headers: Headers) => void } = {}, life = this.life): Promise<unknown> {
    // A dead page sends nothing more.
    if (life !== this.life) return new Promise(() => {});
    const match = /^\/api\/nodes\/([^/?]+)$/.exec(path);
    if (match && (init.method ?? "GET") === "GET") {
      const row = this.row(this.server.get(match[1]!)!);
      return new Promise((resolve) => { this.reads.push({ row, head: this.head, ...(init.onHeaders ? { onHeaders: init.onHeaders } : {}), resolve }); });
    }
    if (!match || init.method !== "PATCH") throw new Error(`saveWorld: unexpected request ${init.method} ${path}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init.body)) as PatchBody;
    const request = {
      id: this.requestSeq++, nodeId: match[1]!, idemKey: headers["Idempotency-Key"] ?? null,
      keepalive: !!init.keepalive, body, state: "inflight" as RequestState,
    };
    const key = bodyKey(request.nodeId, body);
    if (this.rejectedBodies.has(key)) {
      this.violations.push({ invariant: 6, text: `a save the server refused was sent again (note ${request.nodeId}, request ${request.id})` });
    }
    const base = body.base_markdown;
    // A resend under the key of an earlier request is that same save (the server answers it from its record), not a
    // new one built on an old base: a save given up on at the send deadline is queued and sent again under its key.
    const resend = request.idemKey !== null && this.requests.some((r) => r.idemKey === request.idemKey);
    if (base !== undefined && !resend && this.retired.get(request.nodeId)?.has(base)) {
      this.violations.push({ invariant: "S3", text: `a save of note ${request.nodeId} (request ${request.id}) carries a base this device had already replaced by an acknowledged save` });
    }
    return new Promise((resolve, reject) => {
      const sent: WorldRequest = { ...request, resolve, reject };
      this.requests.push(sent);
      // Given up on (writeQueue's send deadline aborts it): like fetch, the page hears an AbortError now and nothing
      // after; the server may still get it and decide it, which nobody hears either.
      const signal = (init as { signal?: AbortSignal }).signal;
      signal?.addEventListener("abort", () => {
        if (sent.state !== "inflight") return;
        sent.orphan = true;
        sent.resolve = () => {}; sent.reject = () => {};
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  }

  /** The position of the last change `apply` made (null: it changed nothing, so the server committed no event). */
  private applied: number | null = null;
  private apply(request: WorldRequest): ContentNode {
    const cached = request.idemKey ? this.idem.get(request.idemKey) : undefined;
    // A replay answers with the ORIGINAL position, not the head the server has moved on to.
    if (cached) { this.applied = cached.position; return this.row(cached); }
    const note = this.server.get(request.nodeId)!;
    const before = { title: note.title, markdown: note.markdown };
    const { body } = request;
    if (body.markdown !== undefined) {
      let next = body.markdown;
      if (body.base_markdown !== undefined && mergeGuard(note.markdown, body.base_markdown, next)) {
        this.merges.push({ nodeId: note.id, requestId: request.id });
        const { merged, conflicts } = threeWayMergeBody(body.base_markdown, next, note.markdown);
        next = merged;
        for (const c of conflicts) this.conflicts.push({ nodeId: note.id, base: c.base, incoming: c.incoming, current: c.current });
      }
      if (next !== note.markdown) note.at = this.tickClock();
      note.markdown = next;
    }
    if (body.title !== undefined) {
      const title = body.title;
      const freshRename = this.userTitles.has(title) && !this.appliedTitles.has(title);
      if (title !== note.title && !freshRename) {
        this.violations.push({ invariant: 3, text: `a save carried an old title "${title}" over the newer "${note.title}" (note ${note.id}, request ${request.id})` });
      }
      if (this.userTitles.has(title)) this.appliedTitles.add(title);
      if (title !== note.title) note.at = this.tickClock();
      note.title = title;
    }
    // One event per save that changed the note; a save that changed nothing commits none (no position).
    this.applied = before.title !== note.title || before.markdown !== note.markdown ? ++this.head : null;
    if (request.idemKey) this.idem.set(request.idemKey, { ...note, position: this.applied });
    return this.row(note);
  }

  deliver(request: WorldRequest): void {
    if (request.idemKey && this.refusedKeys.has(request.idemKey)) { this.failPermanently(request); return; }
    request.state = "applied";
    const row = this.apply(request);
    // A dead page was told nothing: what it held before is not behind it (S1–S3 are about what this device was told).
    if (request.orphan) { request.resolve(row); return; }
    this.acknowledge(request.nodeId, request.body.markdown, row.markdown ?? "");
    // The response's headers arrive before its body: lib/api.ts hands them to the position recorder first.
    const headers = new Headers(this.applied === null ? {} : { [EVENT_POSITION_HEADER]: String(this.applied) });
    this.onResponse(`/api/nodes/${request.nodeId}`, { method: "PATCH", body: JSON.stringify(request.body) }, { ok: true, headers });
    request.resolve(row);
  }

  /** This device was told its save is in. Whatever text it held before that is now behind it. */
  private acknowledge(nodeId: string, sent: string | undefined, answered: string): void {
    if (sent === undefined) return;
    const retired = this.retired.get(nodeId) ?? new Set<string>();
    for (const behind of [this.lastAcked.get(nodeId), this.requestBase(nodeId, sent)]) if (behind !== undefined) retired.add(behind);
    retired.delete(answered); retired.delete(sent);
    this.retired.set(nodeId, retired);
    this.lastAcked.set(nodeId, answered);
  }
  private requestBase(nodeId: string, sent: string): string | undefined {
    return this.requests.findLast((r) => r.nodeId === nodeId && r.state === "applied" && r.body.markdown === sent)?.body.base_markdown;
  }
  /** Somebody (the person typing, or the other device) wrote this text: it is current again, not a step back. */
  wrote(nodeId: string, text: string): void { this.retired.get(nodeId)?.delete(text); }
  failRetryably(request: WorldRequest, kind: "503" | "network"): void {
    request.state = "failed";
    request.reject(kind === "503" ? this.makeApiError(503) : new TypeError("Failed to fetch"));
  }
  failPermanently(request: WorldRequest): void {
    // The key was committed already (an earlier copy of the same request): the server answers it from its record.
    if (request.idemKey && this.idem.has(request.idemKey)) { this.deliver(request); return; }
    request.state = "rejected";
    if (request.idemKey) this.refusedKeys.add(request.idemKey);
    // Only a refusal some live page heard is one this device knows (#6: not sent again; #4: the editor may keep it).
    if (!request.orphan) {
      this.rejectedBodies.add(bodyKey(request.nodeId, request.body));
      this.rejectedNotes.add(request.nodeId);
    }
    request.reject(this.makeApiError(422));
  }
  /** The server applied it; the answer never arrived. */
  loseResponse(request: WorldRequest): void {
    // Refused (this key is refused for good), and the refusal never arrived: the server holds nothing of it.
    if (request.idemKey && this.refusedKeys.has(request.idemKey)) { request.state = "failed"; request.reject(new TypeError("Failed to fetch")); return; }
    this.apply(request);
    request.state = "lost";
    request.reject(new TypeError("Failed to fetch"));
  }

  /** The page that was alive dies (a reload). What it had on the wire stays with the server, which still decides it;
   *  the answer reaches nobody. Its unanswered reads die with it. */
  pageDied(): void {
    this.life++;
    for (const request of this.requests) {
      if (request.state !== "inflight") continue;
      request.orphan = true;
      request.resolve = () => {};
      request.reject = () => {};
    }
    this.reads = [];
  }

  /** What a new page shows before the server answers: the local copy's rows (the server's rows where it holds none),
   *  with the queued text laid over them, as the worker's loadBootstrap does (pendingNoteProjection). */
  bootRows(): ContentNode[] {
    const copy = this.rows().map((row) => ({
      ...row,
      markdown: this.localText.get(row.id) ?? row.markdown,
      title: this.localTitle.get(row.id) ?? row.title,
    }));
    return this.copyless ? this.rows() : projectPendingNoteText(copy as never, this.pending as never) as unknown as ContentNode[];
  }

  // ── the other device ──
  remoteBody(noteId: string, edit: (body: string) => string): void {
    const note = this.server.get(noteId)!;
    const next = edit(note.markdown);
    this.recordEdit(note.markdown, next);
    note.markdown = next; note.at = this.tickClock(); this.head++;
    this.remoteWrites++; this.wrote(noteId, next);
  }
  remoteRename(noteId: string, title: string): void { const note = this.server.get(noteId)!; note.title = title; note.at = this.tickClock(); this.head++; this.remoteWrites++; }

  // ── lib/localDb fake ──
  /** The local copy's watermark (lib/answerPositions.ts), as the worker keeps it. */
  copyWatermark: string | null = null;
  readonly localDb = {
    addPendingWrite: async (method: string, path: string, body: string | null, idemKey?: string | null) => {
      this.pending.push({ id: ++this.rowSeq, method, path, body, idem_key: idemKey ?? null, attempts: 0 });
    },
    getPendingWrites: async () => this.pending.map((w) => ({ ...w })),
    clearPendingWrite: async (id: number) => { this.pending = this.pending.filter((w) => w.id !== id); },
    bumpPendingWriteAttempt: async (id: number) => {
      const row = this.pending.find((w) => w.id === id);
      return row ? ++row.attempts : 0;
    },
    rejectPendingWrite: async (write: { id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }, rejection: string) => {
      this.pending = this.pending.filter((w) => w.id !== write.id);
      const row = { ...write, rejection };
      this.rejected.push(row);
      return row;
    },
    storeRejectedWrite: async (request: { method: string; path: string; body: string | null; idem_key: string }, rejection: string) => {
      const row = { id: ++this.rowSeq, ...request, attempts: 0, rejection };
      this.rejected.push(row);
      return row;
    },
    getRejectedWrites: async () => this.rejected.map((w) => ({ ...w })),
    dismissRejectedWrite: async (write: { id: number }) => { this.rejected = this.rejected.filter((w) => w.id !== write.id); },
    /** The local copy's text of each note, as the writer's mirror leaves it (noteWriter `mirror`: the store row). */
    upsertNode: async (node: { id: string; markdown?: string | null; title?: string | null }) => {
      this.localText.set(node.id, node.markdown ?? "");
      if (typeof node.title === "string") this.localTitle.set(node.id, node.title);
    },
    // syncEngine.hydrateNode: no body stored on this device; the server's row is kept as it came.
    getStoredBody: async () => null,
    // A single read, judged by where it was read as the worker does (localDbWorker persistRemoteNode).
    persistRemoteNode: async <T extends { id: string; markdown?: string | null }>(node: T, head?: string) => {
      if (this.copyless) return node;
      if (head !== undefined && !isCurrentAnswer(head, this.copyWatermark)) return { ...node, answer_stale: true as const, answer_watermark: this.copyWatermark, answer_server: SERVER_ID };
      // The queued text laid over it, as the worker does (pendingNoteProjection).
      const [projected] = projectPendingNoteText([node] as never, this.pending as never) as unknown as T[];
      this.localText.set(node.id, projected!.markdown ?? "");
      const title = (projected as { title?: unknown }).title;
      if (typeof title === "string") this.localTitle.set(node.id, title);
      if (head !== undefined) this.copyWatermark = higherPosition(this.copyWatermark, head);
      return projected!;
    },
    /** A sync answer, judged and stored as the worker does (localDbWorker applySync: the same isCurrentAnswer, the
     *  queued text laid over it), so this world and the real-worker tests (answerPositions, localDbSharedStorage) are
     *  one model of the copy. */
    applySync: async <D extends { head_event_id?: string; nodes: { upsert: Array<{ id: string; markdown?: string | null }> } }>(delta: D) => {
      if (this.copyless) return delta;
      if (!isCurrentAnswer(delta.head_event_id, this.copyWatermark)) return { ...delta, nodes: { ...delta.nodes, upsert: [] }, stale: true as const, answer_watermark: this.copyWatermark, answer_server: SERVER_ID };
      const upsert = projectPendingNoteText(delta.nodes.upsert as never, this.pending as never) as typeof delta.nodes.upsert;
      for (const row of upsert) {
        this.localText.set(row.id, row.markdown ?? "");
        const title = (row as { title?: unknown }).title;
        if (typeof title === "string") this.localTitle.set(row.id, title);
      }
      if (delta.head_event_id !== undefined) this.copyWatermark = higherPosition(this.copyWatermark, delta.head_event_id);
      return { ...delta, nodes: { ...delta.nodes, upsert } };
    },
    removeNode: async () => {},
    upsertAttribute: async () => {},
    flushLocalDbSync: async () => {},
    // The local copy's watermark (localDbWorker raiseWatermark / getWatermark).
    raiseWatermark: async (position: string) => { this.copyWatermark = higherPosition(this.copyWatermark, position); },
    getWatermark: async () => ({ position: this.copyWatermark, server: SERVER_ID, rebuildOwed: false }),
    rewindCursor: async () => {},
  };

  /** The local database as the page of `life` reaches it: once that page is dead, its calls are never made (its
   *  worker died with it) and never answer. */
  localDbFor(life: number): typeof this.localDb {
    const calls = this.localDb as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    return Object.fromEntries(Object.entries(calls).map(([name, call]) => [name,
      (...args: unknown[]) => life === this.life ? call(...args) : new Promise(() => {})])) as unknown as typeof this.localDb;
  }
}

export function bodyKey(nodeId: string, body: PatchBody): string {
  return JSON.stringify([nodeId, body.title ?? null, body.markdown ?? null]);
}

/** The one server identity this world's answers come from. */
export const SERVER_ID = "server-1";

export const world = new SaveWorld();
