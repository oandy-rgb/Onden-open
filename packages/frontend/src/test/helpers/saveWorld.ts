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
import { threeWayMergeBody } from "../../../../backend/src/services/eventLog/bodyMerge";

type PatchBody = { title?: string; markdown?: string; base_markdown?: string };
export type RequestState = "inflight" | "applied" | "failed" | "rejected" | "lost";
export type WorldRequest = {
  id: number; nodeId: string; idemKey: string | null; keepalive: boolean; body: PatchBody;
  state: RequestState;
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
  private idem = new Map<string, ServerNote>();
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
  private rowSeq = 0;

  reset(): void {
    this.server.clear(); this.requests = []; this.conflicts = []; this.violations = [];
    this.merges = []; this.remoteWrites = 0; this.retired.clear(); this.lastAcked.clear();
    this.idem.clear(); this.counter = 0; this.requestSeq = 0;
    this.typed.clear(); this.deleted.clear(); this.userTitles.clear(); this.appliedTitles.clear();
    this.rejectedBodies.clear(); this.rejectedNotes.clear();
    this.pending = []; this.rejected = []; this.rowSeq = 0; this.localText.clear(); this.reads = [];
    for (const id of ["a", "b"]) {
      const lines = [this.nextToken(id), this.nextToken(id)];
      this.server.set(id, { id, title: `Note ${id.toUpperCase()}`, markdown: lines.join("\n"), at: ++this.serverClock });
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
  rows(): ContentNode[] {
    return [...this.server.values()].map((n) => this.row(n));
  }
  row(n: ServerNote): ContentNode {
    return { id: n.id, title: n.title, slug: n.id, markdown: n.markdown, node_type: "content", source_type: "manual", updated_at: new Date(Date.UTC(2026, 0, 1) + n.at * 1000).toISOString() };
  }

  // ── transport (lib/api `api`) ──
  get inflight(): WorldRequest[] { return this.requests.filter((r) => r.state === "inflight"); }

  /** GET /api/nodes/:id reads (syncEngine.hydrateNode): the row is read when the request arrives, the answer waits
   *  until the test delivers it (`answerRead`). */
  reads: Array<{ row: ContentNode; resolve: (row: ContentNode) => void }> = [];
  answerRead(index = 0): void {
    const [read] = this.reads.splice(index % Math.max(this.reads.length, 1), 1);
    read?.resolve(read.row);
  }

  transport(path: string, init: { method?: string; body?: unknown; headers?: unknown; keepalive?: boolean } = {}): Promise<unknown> {
    const match = /^\/api\/nodes\/([^/?]+)$/.exec(path);
    if (match && (init.method ?? "GET") === "GET") {
      const row = this.row(this.server.get(match[1]!)!);
      return new Promise((resolve) => { this.reads.push({ row, resolve }); });
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
    if (base !== undefined && this.retired.get(request.nodeId)?.has(base)) {
      this.violations.push({ invariant: "S3", text: `a save of note ${request.nodeId} (request ${request.id}) carries a base this device had already replaced by an acknowledged save` });
    }
    return new Promise((resolve, reject) => { this.requests.push({ ...request, resolve, reject }); });
  }

  private apply(request: WorldRequest): ContentNode {
    const cached = request.idemKey ? this.idem.get(request.idemKey) : undefined;
    if (cached) return this.row(cached);
    const note = this.server.get(request.nodeId)!;
    const { body } = request;
    if (body.markdown !== undefined) {
      let next = body.markdown;
      if (body.base_markdown !== undefined && mergeGuard(note.markdown, body.base_markdown, next)) {
        this.merges.push({ nodeId: note.id, requestId: request.id });
        const { merged, conflicts } = threeWayMergeBody(body.base_markdown, next, note.markdown);
        next = merged;
        for (const c of conflicts) this.conflicts.push({ nodeId: note.id, base: c.base, incoming: c.incoming, current: c.current });
      }
      if (next !== note.markdown) note.at = ++this.serverClock;
      note.markdown = next;
    }
    if (body.title !== undefined) {
      const title = body.title;
      const freshRename = this.userTitles.has(title) && !this.appliedTitles.has(title);
      if (title !== note.title && !freshRename) {
        this.violations.push({ invariant: 3, text: `a save carried an old title "${title}" over the newer "${note.title}" (note ${note.id}, request ${request.id})` });
      }
      if (this.userTitles.has(title)) this.appliedTitles.add(title);
      if (title !== note.title) note.at = ++this.serverClock;
      note.title = title;
    }
    if (request.idemKey) this.idem.set(request.idemKey, { ...note });
    return this.row(note);
  }

  deliver(request: WorldRequest): void {
    request.state = "applied";
    const row = this.apply(request);
    this.acknowledge(request.nodeId, request.body.markdown, row.markdown ?? "");
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
    request.state = "rejected";
    this.rejectedBodies.add(bodyKey(request.nodeId, request.body));
    this.rejectedNotes.add(request.nodeId);
    request.reject(this.makeApiError(422));
  }
  /** The server applied it; the answer never arrived. */
  loseResponse(request: WorldRequest): void {
    this.apply(request);
    request.state = "lost";
    request.reject(new TypeError("Failed to fetch"));
  }

  // ── the other device ──
  remoteBody(noteId: string, edit: (body: string) => string): void {
    const note = this.server.get(noteId)!;
    const next = edit(note.markdown);
    this.recordEdit(note.markdown, next);
    note.markdown = next; note.at = ++this.serverClock;
    this.remoteWrites++; this.wrote(noteId, next);
  }
  remoteRename(noteId: string, title: string): void { const note = this.server.get(noteId)!; note.title = title; note.at = ++this.serverClock; this.remoteWrites++; }

  // ── lib/localDb fake ──
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
    upsertNode: async (node: { id: string; markdown?: string | null }) => { this.localText.set(node.id, node.markdown ?? ""); },
    // syncEngine.hydrateNode: no body stored on this device; the server's row is kept as it came.
    getStoredBody: async () => null,
    persistRemoteNode: async <T,>(node: T) => node,
    removeNode: async () => {},
    upsertAttribute: async () => {},
    flushLocalDbSync: async () => {},
  };
}

export function bodyKey(nodeId: string, body: PatchBody): string {
  return JSON.stringify([nodeId, body.title ?? null, body.markdown ?? null]);
}

export const world = new SaveWorld();
