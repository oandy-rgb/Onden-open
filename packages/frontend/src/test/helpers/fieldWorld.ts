// A fake server, transport and local database for the writes that are not a note's text: an attribute, a task, a
// tag on a note, a tag's hidden flag, a tag's fields, the workspace's home page, a hand-placed graph position. The REAL writers
// (propertyWriter, taskWriter, tagWriter, tagSchemaWriter, workspaceWriter, graphPositionWriter) send through the real write lifecycle
// and queue; the answers that carry rows come back through the real sync engine (POST /api/sync → applyAndShow →
// storeOps), the ?nodes=none refresh and the whole bootstrap (takeBootstrap), and single note reads (GET
// /api/nodes/:id). Test: test/gateHoldsEveryUnansweredEdit.test.ts.
//
// Every write stays in flight until the test delivers it (the server applies it then, one event per write, and the
// response carries its position the way the backend's X-Onden-Event-Position does). A sync or bootstrap answer is read
// when it is asked for (the server's rows and head then) and can be held and delivered later.
//
// This file imports no app module on purpose (only types): the test mocks lib/api and lib/localDb with it.

import type { Bootstrap, ContentNode, NodeTask, Tag, GraphPosition } from "../../lib/api";
import { EVENT_POSITION_HEADER, READ_HEAD_HEADER, READ_SERVER_HEADER } from "@onden/markdown/contract";

export const FIELD_SERVER_ID = "server-1";
export const WORKSPACE = { id: "w", name: "W", slug: "w", home_node_id: null as string | null };
/** A note, a plain tag and a class tag. */
export const NOTE_ID = "00000000-0000-4000-8000-000000000001";
export const TAG_ID = "00000000-0000-4000-8000-000000000002";
export const TASK_ID = "00000000-0000-4000-8000-000000000003";

type ServerNote = { id: string; title: string; node_type: string; attrs: Record<string, string>; tags: string[]; hidden: boolean; fields?: unknown[] };
export type FieldRequest = { id: number; method: string; path: string; body: unknown; state: "inflight" | "applied" | "rejected"; resolve(value: unknown): void; reject(error: unknown): void };
type HeldAnswer = { path: string; value: unknown; read(): unknown; resolve(value: unknown): void };

export class FieldWorld {
  makeApiError: (status: number) => Error = (status) => new Error(`HTTP ${status}`);
  /** lib/data/writePositions' recorder (installed through the mocked setWriteResponseListener). */
  onResponse: (path: string, init: RequestInit, response: { ok: boolean; headers: Headers }) => void = () => {};

  head = 0;
  notes = new Map<string, ServerNote>();
  tasks = new Map<string, NodeTask>();
  home: string | null = null;
  positions = new Map<string, { x: number; y: number }>();
  requests: FieldRequest[] = [];
  /** Answers asked for while `holdAnswers` is on: read then, delivered by `answer()`. */
  held: HeldAnswer[] = [];
  holdAnswers = false;
  /** Every request path, in order (reads included), for "was it read again". */
  log: string[] = [];
  private seq = 0;

  reset(): void {
    this.head = 10; this.requests = []; this.unanswered = []; this.held = []; this.holdAnswers = false; this.log = []; this.seq = 0;
    this.notes = new Map<string, ServerNote>([
      [NOTE_ID, { id: NOTE_ID, title: "A note", node_type: "content", attrs: { status: "start" }, tags: [], hidden: false }],
      [TAG_ID, { id: TAG_ID, title: "toread", node_type: "tag", attrs: {}, tags: [], hidden: false, fields: [] }],
    ]);
    this.tasks = new Map([[TASK_ID, { id: TASK_ID, node_id: NOTE_ID, title: "Do it", status: "todo" } as NodeTask]]);
    this.home = null;
    this.positions = new Map();
    this.pending = []; this.rowSeq = 0; this.lastEventId = 10;
  }

  // ── what the server sends ──
  row(id: string): ContentNode {
    const n = this.notes.get(id)!;
    return {
      id: n.id, title: n.title, slug: n.id, markdown: "", node_type: n.node_type, source_type: "manual", hidden: n.hidden,
      attrs: { ...n.attrs }, class_tag_ids: [], label_tag_ids: [...n.tags], updated_at: "2026-01-01T00:00:00.000Z",
    } as ContentNode;
  }
  tagCatalog(): Tag[] {
    return [...this.notes.values()].filter((n) => n.node_type === "tag")
      .map((n) => ({ id: n.id, name: n.title, color: null, schema_id: null, schema_fields: structuredClone(n.fields ?? []), ...(n.hidden ? { hidden: true } : {}) }) as Tag);
  }
  workspace() { return { ...WORKSPACE, home_node_id: this.home }; }
  graphPositions(): GraphPosition[] { return [...this.positions].map(([nodeId, p]) => ({ nodeId, ...p })); }
  /** A sync delta read now: every row, at the head now (a delta may re-send rows it carried before). */
  delta(since: number) {
    const empty = since >= this.head;
    const nodes = empty ? [] : [...this.notes.keys()].map((id) => this.row(id));
    return {
      last_event_id: this.head, head_event_id: String(this.head), server_id: FIELD_SERVER_ID,
      nodes: { upsert: nodes, delete: [] }, edges: { upsert: [], delete: [] },
      tasks: { upsert: empty ? [] : [...this.tasks.values()].map((t) => ({ ...t })), delete: [] },
      attributes: { upsert: empty ? [] : [...this.notes.values()].flatMap((n) => Object.entries(n.attrs).map(([key, value]) => ({ node_id: n.id, key, value, value_type: "text", is_inheritable: false, source: "ui" }))), delete: [] },
      workspace: empty ? null : this.workspace(),
      ...(empty ? {} : { tags: this.tagCatalog() }),
    };
  }
  /** A bootstrap read now (`meta`: the ?nodes=none refresh). */
  bootstrap(meta: boolean): Bootstrap {
    return {
      workspace: this.workspace(), actor_role: "admin", actor_is_owner: true, can_review: true,
      nodes: meta ? [] : [...this.notes.keys()].map((id) => this.row(id)), edges: [], tasks: meta ? [] : [...this.tasks.values()].map((t) => ({ ...t })),
      suggestions: [], events: [], tags: this.tagCatalog(), graph_positions: this.graphPositions(),
      last_event_id: String(this.head), server_id: FIELD_SERVER_ID, ...(meta ? { nodes_omitted: true } : {}),
    } as unknown as Bootstrap;
  }

  // ── transport (lib/api `api`) ──
  get inflight(): FieldRequest[] { return this.requests.filter((r) => r.state === "inflight"); }

  transport(path: string, init: { method?: string; body?: unknown; onHeaders?: (headers: Headers) => void } = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    this.log.push(`${method} ${path}`);
    if (method === "GET" && /^\/api\/nodes\/[^/?]+$/.test(path)) {
      const id = path.split("/")[3]!;
      init.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: String(this.head), [READ_SERVER_HEADER]: FIELD_SERVER_ID }));
      return Promise.resolve(this.row(id));
    }
    if (path === "/api/sync") { const since = Number(JSON.parse(String(init.body)).since); return this.answerOrHold(path, () => this.delta(since)); }
    if (path === "/api/bootstrap?nodes=none") return this.answerOrHold(path, () => this.bootstrap(true));
    if (path === "/api/bootstrap" || path === "/api/bootstrap?bodies=none") return this.answerOrHold(path, () => this.bootstrap(false));
    if (method === "GET") return Promise.resolve([]); // canvases, anything else a pass reads: nothing
    const body = init.body == null ? null : JSON.parse(String(init.body));
    return new Promise((resolve, reject) => { this.requests.push({ id: this.seq++, method, path, body, state: "inflight", resolve, reject }); });
  }

  private answerOrHold(path: string, read: () => unknown): Promise<unknown> {
    if (!this.holdAnswers) return Promise.resolve(read());
    return new Promise((resolve) => { this.held.push({ path, value: read(), read, resolve }); });
  }

  /** A held answer (the oldest by default) arrives now: read when it was asked for, or (`readNow`) read now — the
   *  server was slow to start on it. */
  answer(index = 0, { readNow = false } = {}): boolean {
    if (!this.held.length) return false;
    const [answer] = this.held.splice(index % this.held.length, 1);
    answer!.resolve(structuredClone(readNow ? answer!.read() : answer!.value));
    return true;
  }

  /** The server applies a write and answers it (headers first, with its position, as lib/api does). */
  deliver(request: FieldRequest | undefined): void { this.applyNow(request)(); }
  /** The server applies a write now; its answer is still on its way until the returned function delivers it. */
  applyNow(request: FieldRequest | undefined): () => void {
    if (!request || request.state !== "inflight") return () => {};
    request.state = "applied";
    const value = this.apply(request);
    const position = ++this.head;
    const respond = () => {
      this.unanswered = this.unanswered.filter((r) => r !== respond);
      const headers = new Headers({ [EVENT_POSITION_HEADER]: String(position) });
      this.onResponse(request.path, { method: request.method, body: JSON.stringify(request.body) }, { ok: true, headers });
      request.resolve(value);
    };
    this.unanswered.push(respond);
    return respond;
  }
  /** Writes the server applied whose answers are still on their way (applyNow). */
  unanswered: Array<() => void> = [];
  /** The server refuses it (a 4xx: never applied). */
  refuse(request: FieldRequest | undefined): void {
    if (!request || request.state !== "inflight") return;
    request.state = "rejected";
    request.reject(this.makeApiError(422));
  }

  private apply(request: FieldRequest): unknown {
    const { method, path } = request;
    const body = (request.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/nodes\/([^/]+)\/attributes\/([^/]+)$/.exec(path))) {
      const note = this.notes.get(m[1]!)!;
      const key = decodeURIComponent(m[2]!);
      if (method === "DELETE") { delete note.attrs[key]; return {}; }
      note.attrs[key] = String(body.value);
      return { node_id: note.id, key, value: note.attrs[key], value_type: "text", is_inheritable: false, source: "ui" };
    }
    if ((m = /^\/api\/nodes\/([^/]+)\/tags\/([^/]+)$/.exec(path))) {
      const note = this.notes.get(m[1]!)!;
      note.tags = note.tags.filter((t) => t !== m![2]);
      if (method === "PUT") note.tags.push(m[2]!);
      return {};
    }
    if ((m = /^\/api\/nodes\/([^/]+)\/position$/.exec(path))) {
      this.positions.set(m[1]!, { x: Number(body.x), y: Number(body.y) });
      return {};
    }
    if ((m = /^\/api\/nodes\/([^/]+)$/.exec(path)) && method === "PATCH") {
      const note = this.notes.get(m[1]!)!;
      if (typeof body.hidden === "boolean") note.hidden = body.hidden;
      return this.row(note.id);
    }
    if ((m = /^\/api\/tasks\/([^/]+)$/.exec(path)) && method === "PATCH") {
      const task = { ...this.tasks.get(m[1]!)!, ...body } as NodeTask;
      this.tasks.set(task.id, task);
      return { ...task };
    }
    if ((m = /^\/api\/tags\/([^/]+)\/schema$/.exec(path)) && method === "PATCH") {
      const tag = this.notes.get(m[1]!)!;
      if (Array.isArray(body.fields)) tag.fields = structuredClone(body.fields);
      return {};
    }
    if (path === "/api/workspace" && method === "PATCH") {
      if (Object.hasOwn(body, "home_node_id")) this.home = body.home_node_id as string | null;
      return this.workspace();
    }
    throw new Error(`fieldWorld: unexpected write ${method} ${path}`);
  }

  // ── the other device ──
  remote(change: (world: this) => void): void { change(this); this.head++; }

  // ── lib/localDb fake ──
  pending: Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }> = [];
  lastEventId = 10;
  private rowSeq = 0;
  readonly localDb = {
    addPendingWrite: async (method: string, path: string, body: string | null, idemKey?: string | null) => {
      this.pending.push({ id: ++this.rowSeq, method, path, body, idem_key: idemKey ?? null, attempts: 0 });
    },
    getPendingWrites: async () => this.pending.map((w) => ({ ...w })),
    clearPendingWrite: async (id: number) => { this.pending = this.pending.filter((w) => w.id !== id); },
    bumpPendingWriteAttempt: async (id: number) => { const row = this.pending.find((w) => w.id === id); return row ? ++row.attempts : 0; },
    rejectPendingWrite: async (write: { id: number }, rejection: string) => { this.pending = this.pending.filter((w) => w.id !== write.id); return { ...write, rejection }; },
    storeRejectedWrite: async (request: object, rejection: string) => ({ id: ++this.rowSeq, ...request, attempts: 0, rejection }),
    getRejectedWrites: async () => [],
    dismissRejectedWrite: async () => {},
    getOldestPendingWriteAt: async () => null,
    catchUpWithOtherTabs: async () => {},
    // The mirror each writer refreshes from the store: nothing to keep here.
    upsertNode: async () => {}, removeNode: async () => {}, upsertAttribute: async () => {}, removeAttribute: async () => {},
    getNodeAttributeRecord: async () => null, upsertTask: async () => {}, removeTask: async () => {}, upsertWorkspace: async () => {},
    putGraphPosition: async () => {},
    // Answers pass through as the server sent them (no queued text in these tests); positions are judged by the page.
    applySync: async <D>(delta: D) => delta,
    persistBootstrap: async <B>(data: B) => data,
    persistRemoteNode: async <N>(node: N) => node,
    getStoredBody: async () => null,
    forgetBody: async () => {},
    getWatermark: async () => ({ position: null, server: FIELD_SERVER_ID, rebuildOwed: false }),
    raiseWatermark: async () => {}, rewindCursor: async () => {}, forgetCopyWatermark: async () => ({ alreadyOwed: false }),
    getLastEventId: async () => this.lastEventId,
    setLastEventId: async (id: number | string) => { this.lastEventId = Number(id); },
    getAllMembershipIds: async () => [] as string[], getMembershipEpoch: async () => 0, setMembershipEpoch: async () => {},
    heldNotesNowSent: async () => [] as string[],
    getLastFullRefresh: async () => Date.now(), setLastFullRefresh: async () => {},
    initLocalDb: async () => null, loadBootstrapList: async () => null,
    loadBootstrapRelations: async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] }),
    loadAttributePage: async () => ({ rows: [], next: null }),
    exportDatabase: async () => null, importDatabase: async () => null, installUnloadFlush: () => () => {}, flushLocalDbSync: async () => {},
    loadCanvases: async () => [], upsertCanvas: async () => {}, removeCanvas: async () => {}, loadCanvas: async () => null,
  };
}

export const fieldWorld = new FieldWorld();
