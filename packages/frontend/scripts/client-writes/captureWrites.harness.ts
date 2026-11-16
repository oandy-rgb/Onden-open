// Capture harness: what the frontend's real writers send to the server.
//
// This file is NOT a test of the tree it lives in. `npm run capture:client-writes`
// (scripts/client-writes/capture.mjs) copies it into a checkout of one release as
// src/test/__captureClientWrites.test.ts and runs it with that release's own
// vitest, so the requests recorded are the ones THAT release's writers build:
//   method, path, the headers a writer chooses (Idempotency-Key), JSON body.
// The same file is used for every release, so it may only rely on what every
// kept release has: a scenario whose writer is missing or throws is recorded as
// skipped, never fatal. Add new scenarios freely; add a new writer API only
// behind `load()` + a try/catch so older releases still capture the rest.
//
// The transport is faked at `api()` (lib/api.ts), the one function every write
// path ends in, and the offline queue's `addPendingWrite` is recorded too, so a
// scenario yields both the online request and the entry an offline client would
// have stored and replayed after the next deploy.
//
// Ids are deterministic (see ID below) so the backend replay can seed a
// workspace with the same ids; each scenario names what it means to achieve
// (`expect`), in terms the replay judges against database rows.

import { afterAll, beforeEach, describe, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rec = vi.hoisted(() => ({
  offline: false,
  counter: 0,
  requests: [] as Array<{ via: "api" | "queue"; method: string; path: string; headers: Record<string, string>; body: unknown }>,
}));

/** `00000000-0000-4000-8000-<n as 12 hex>`: a valid v4 shape, readable in a diff. */
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

vi.mock("../lib/uuid", async (original) => ({
  ...await original<typeof import("../lib/uuid")>(),
  randomUUID: () => uuid(0x10000 + rec.counter++),
}));
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: async (path: string, init: RequestInit = {}) => fakeServer(path, init),
}));
// The local DB worker does not exist under test. Every export is a no-op that
// resolves undefined, except the few the write path reads results from; the
// Proxy keeps this file working for releases that export more or fewer names.
vi.mock("../lib/localDb", () => {
  const defined: Record<string, unknown> = {
    getPendingWrites: async () => [],
    addPendingWrite: async (method: string, path: string, body: string | null, idemKey: string | null) => {
      rec.requests.push({ via: "queue", method, path, headers: idemKey ? { "Idempotency-Key": idemKey } : {}, body: body === null ? null : parseBody(body) });
    },
    storeRejectedWrite: async (request: object, rejection: string) => ({ ...request, id: 1, attempts: 0, rejection }),
    getNodeAttributeRecord: async () => null,
    loadCanvas: async () => null,
    loadCanvases: async () => [],
  };
  return new Proxy(defined, {
    has: () => true,
    get: (target, key) => {
      if (typeof key !== "string" || key === "then" || key === "__esModule") return undefined;
      return key in target ? target[key] : async () => undefined;
    },
  });
});

function parseBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") return `<${typeof body}>`;
  try { return JSON.parse(body); } catch { return body; }
}

/** What a server would answer, closely enough for writers to reconcile. */
function fakeServer(path: string, init: RequestInit): unknown {
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET") return {};
  if (rec.offline) throw new TypeError("Failed to fetch");
  const headers = Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries());
  rec.requests.push({ via: "api", method, path, headers, body: parseBody(init.body) });
  const body = parseBody(init.body);
  const fromPath = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?!.*[0-9a-f]{8}-[0-9a-f]{4}-)/.exec(path)?.[1];
  const base = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  return { id: fromPath, ...base, ...(typeof base.id === "string" ? { id: base.id } : {}), modules: [], extends: [], behaviour: {}, ok: true };
}

// ── Seeded workspace: ids the backend replay recreates ────────────────────────
export const ID = {
  alpha: uuid(0x101), beta: uuid(0x102), parent: uuid(0x103), child: uuid(0x104), gone: uuid(0x105), trashed: uuid(0x106),
  tag: uuid(0x201), tag2: uuid(0x202), moduleTag: uuid(0x203),
  task: uuid(0x301), edge: uuid(0x401), board: uuid(0x501),
  space: uuid(0x601), person: uuid(0x701), agent: uuid(0x702), view: uuid(0x801), token: uuid(0x901),
  event: 9001,
} as const;
export const SEED_MARKDOWN = { alpha: "line one\nline two\nline three\n" } as const;

type Expectation =
  | { node: string; fields: Record<string, unknown> }
  | { node: string; contains: string[] }
  | { node: string; deleted: boolean }
  | { attribute: { node: string; key: string }; value: string | null }
  | { tagged: { node: string; tag: string }; present: boolean }
  | { edge: string; fields: Record<string, unknown> | null }
  | { task: string; fields: Record<string, unknown> | null }
  | { space: string; fields: Record<string, unknown> }
  | { member: { space: string; actor: string }; permission: string | null }
  | { workspaceHome: string | null }
  | { position: { node: string; x: number; y: number } }
  | { board: string; cards: Array<{ nodeId: string; x: number; y: number }> }
  | { tagSchemaFields: { tag: string; names: string[] } }
  | { extendsTags: { tag: string; targets: string[] } }
  | { tagPath: string[] }
  | { spaceByName: string }
  | { view: { owner: string; id: string; fields: Record<string, unknown> | null } }
  | { viewNamed: { owner: string; name: string } };

type Scenario = {
  name: string;
  /** What the person meant, judged on database rows after replay. */
  expect: Expectation[];
  /** Server-side changes made after the client's last read, before it saves. */
  serverFirst?: Array<{ node: string; markdown: string }>;
  /** The space member's level before the write (default: edit). */
  personPermission?: "view" | "edit";
  /** Needs the connection (a decision the server must accept): not run offline. */
  onlineOnly?: boolean;
  run: (h: Harness) => Promise<unknown>;
};

type Harness = {
  ctx: import("../lib/data/types").DataCtx;
  load: <T = Record<string, (...args: never[]) => unknown>>(module: string) => Promise<T>;
};

const scenarios: Scenario[] = [];
const scenario = (name: string, expect: Expectation[], run: Scenario["run"], extra: Partial<Scenario> = {}) =>
  scenarios.push({ name, expect, run, ...extra });

// One path through each writer, written as the UI calls it.
scenario("note.create: quick capture (client id, parent)", [
  { node: uuid(0xc01), fields: { title: "Captured thought", markdown: "remember this\n", parent_id: ID.parent } },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  // components/QuickCapture.tsx: noteWriter.create({ id, title, markdown, parent_id }).
  return (makeNoteWriter as (c: unknown) => any)(ctx).create({ id: uuid(0xc01), title: "Captured thought", markdown: "remember this\n", parent_id: ID.parent });
});

scenario("note.create: plain (the writer mints the id)", [
  { node: uuid(0x10000), fields: { title: "Fresh note", markdown: "" } },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).create({ title: "Fresh note" });
});

scenario("note.create: with tags and starting attributes in one request", [
  { node: uuid(0xc02), fields: { title: "Book" } },
  { tagged: { node: uuid(0xc02), tag: ID.tag }, present: true },
  { attribute: { node: uuid(0xc02), key: "author" }, value: "Ursula" },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).create({
    id: uuid(0xc02), title: "Book", tagIds: [ID.tag],
    attributes: [{ key: "author", value: "Ursula", value_type: "text", is_inheritable: false }],
  });
});

scenario("note.create: a saved AI answer (source_type ai)", [
  { node: uuid(0xc03), fields: { title: "Saved answer", source_type: "ai" } },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).create({ id: uuid(0xc03), title: "Saved answer", markdown: "answer\n", source_type: "ai" });
});

scenario("note.rename (title only)", [{ node: ID.alpha, fields: { title: "Alpha renamed" } }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).renameNode(ID.alpha, "Alpha renamed");
});

scenario("note.save body with base_markdown and cursor (editor autosave)", [
  { node: ID.alpha, fields: { markdown: "line one\nline two edited\nline three\n" } },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).patch(ID.alpha, { markdown: "line one\nline two edited\nline three\n" },
    { baseMarkdown: SEED_MARKDOWN.alpha, cursorState: { anchor: 14, head: 14 } });
});

scenario("note.save body when the server text moved on (three-way merge by base_markdown)", [
  { node: ID.alpha, contains: ["line one", "client edit", "server edit"] },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).patch(ID.alpha, { markdown: "line one\nline two\nline three\nclient edit\n" },
    { baseMarkdown: SEED_MARKDOWN.alpha });
}, { serverFirst: [{ node: ID.alpha, markdown: "server edit\nline one\nline two\nline three\n" }] });

scenario("note.save title and body together", [
  { node: ID.alpha, fields: { title: "Alpha 2", markdown: "new\n" } },
], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).patch(ID.alpha, { title: "Alpha 2", markdown: "new\n" }, { baseMarkdown: SEED_MARKDOWN.alpha });
});

scenario("note.move under a parent (assignToGroup)", [{ node: ID.beta, fields: { parent_id: ID.parent } }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).assignToGroup(ID.beta, ID.parent);
});

scenario("note.move to top level", [{ node: ID.child, fields: { parent_id: null } }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).assignToGroup(ID.child, null);
});

scenario("note.patch order_key", [{ node: ID.beta, fields: { order_key: "a5" } }], async ({ ctx, load }) => {
  const { makeNoteWriter } = await load("data/noteWriter");
  return (makeNoteWriter as any)(ctx).patch(ID.beta, { order_key: "a5" });
});

scenario("note.promote (show a hidden note again)", [{ node: ID.gone, fields: { hidden: false } }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).promoteNode(ID.gone, "Hidden");
});

scenario("note.duplicate", [{ node: uuid(0x10000), fields: { title: "Alpha (Copy)", markdown: SEED_MARKDOWN.alpha } }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).duplicateNode(ctx.data.nodes.find((n) => n.id === ID.alpha));
});

scenario("note.delete", [{ node: ID.beta, deleted: true }], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).deleteNode(ID.beta, "Beta");
});

scenario("note.undelete (the Undo toast)", [{ node: ID.trashed, deleted: false }], async ({ ctx, load }) => {
  const { makeNoteHistoryWriter } = await load("data/noteHistoryWriter");
  return (makeNoteHistoryWriter as any)(ctx).undelete(ID.trashed);
}, { onlineOnly: true });

scenario("tag.create", [{ node: uuid(0x10000), fields: { title: "inbox", node_type: "class_tag" } }], async ({ ctx, load }) => {
  const { makeTagWriter } = await load("data/tagWriter");
  const created = await (makeTagWriter as any)(ctx).create("inbox");
  return created;
});

scenario("tag.hide", [{ node: ID.tag2, fields: { hidden: true } }], async ({ ctx, load }) => {
  const { makeTagWriter } = await load("data/tagWriter");
  return (makeTagWriter as any)(ctx).setHidden(ID.tag2, true);
});

scenario("tag.apply to a note", [{ tagged: { node: ID.alpha, tag: ID.tag }, present: true }], async ({ ctx, load }) => {
  const { makeTagWriter } = await load("data/tagWriter");
  return (makeTagWriter as any)(ctx).apply(ID.alpha, ID.tag);
});

scenario("tag.remove from a note", [{ tagged: { node: ID.beta, tag: ID.tag2 }, present: false }], async ({ ctx, load }) => {
  const { makeTagWriter } = await load("data/tagWriter");
  return (makeTagWriter as any)(ctx).remove(ID.beta, ID.tag2);
});

scenario("tag.extract note from selection (create then tag)", [
  { node: uuid(0x10000), fields: { title: "Extracted" } },
  { tagged: { node: uuid(0x10000), tag: ID.tag }, present: true },
], async ({ ctx, load }) => {
  const { makeNodeMutations } = await load("data/nodeMutations");
  return (makeNodeMutations as any)(ctx).extractToEntity("Extracted", ID.tag);
});

scenario("property.set text", [{ attribute: { node: ID.alpha, key: "status" }, value: "reading" }], async ({ ctx, load }) => {
  const { makePropertyWriter } = await load("data/propertyWriter");
  return (makePropertyWriter as any)(ctx).set(ID.alpha, "status", "reading");
});

scenario("property.set number inheritable", [{ attribute: { node: ID.alpha, key: "rating" }, value: "4" }], async ({ ctx, load }) => {
  const { makePropertyWriter } = await load("data/propertyWriter");
  return (makePropertyWriter as any)(ctx).set(ID.alpha, "rating", "4", { value_type: "number", is_inheritable: true });
});

scenario("property.remove", [{ attribute: { node: ID.beta, key: "status" }, value: null }], async ({ ctx, load }) => {
  const { makePropertyWriter } = await load("data/propertyWriter");
  return (makePropertyWriter as any)(ctx).remove(ID.beta, "status");
});

scenario("relation.connect", [{ edge: uuid(0x10000), fields: { source_node_id: ID.alpha, target_node_id: ID.parent, edge_type: "related" } }], async ({ ctx, load }) => {
  const { makeRelationWriter } = await load("data/relationWriter");
  return (makeRelationWriter as any)(ctx).connect(ID.alpha, ID.parent, "related");
});

scenario("relation.remove", [{ edge: ID.edge, fields: null }], async ({ ctx, load }) => {
  const { makeRelationWriter } = await load("data/relationWriter");
  return (makeRelationWriter as any)(ctx).remove(ID.edge);
});

scenario("task.create with due date", [{ task: uuid(0x10000), fields: { title: "Write report", due_date: "2026-11-01" } }], async ({ ctx, load }) => {
  const { makeTaskWriter } = await load("data/taskWriter");
  return (makeTaskWriter as any)(ctx).create(ID.alpha, "Write report", { due: "2026-11-01" });
});

scenario("task.complete", [{ task: ID.task, fields: { status: "done" } }], async ({ ctx, load }) => {
  const { makeTaskWriter } = await load("data/taskWriter");
  return (makeTaskWriter as any)(ctx).patch(ID.task, { status: "done" });
});

scenario("task.edit title, due date, recurrence", [{ task: ID.task, fields: { title: "Renamed task", due_date: "2026-12-24", recur: "1w" } }], async ({ ctx, load }) => {
  const { makeTaskWriter } = await load("data/taskWriter");
  return (makeTaskWriter as any)(ctx).patch(ID.task, { title: "Renamed task", due_date: "2026-12-24", recur: "1w" });
});

scenario("canvas.create", [{ node: uuid(0x10000), fields: { title: "New board", node_type: "canvas" } }], async ({ ctx, load }) => {
  const { makeCanvasWriter } = await load("data/canvasWriter");
  let active: unknown = null;
  const canvasCtx = { ...ctx, get data() { return ctx.data; }, get online() { return ctx.online; }, activeCanvas: null, setActiveCanvas: (u: unknown) => { active = typeof u === "function" ? (u as any)(active) : u; } };
  return (makeCanvasWriter as any)(canvasCtx).create("New board");
});

scenario("canvas.place a note and move a card", [{ board: ID.board, cards: [{ nodeId: ID.alpha, x: 100, y: 120 }] }], async ({ ctx, load }) => {
  const { makeCanvasWriter } = await load("data/canvasWriter");
  let active: any = { id: ID.board, title: "Board", created_at: "t0", updated_at: "t0", data: { nodes: [] } };
  const canvasCtx = { get data() { return ctx.data; }, setData: ctx.setData, get online() { return ctx.online; }, addToast: ctx.addToast,
    get activeCanvas() { return active; }, setActiveCanvas: (u: unknown) => { active = typeof u === "function" ? (u as any)(active) : u; } };
  const writer = (makeCanvasWriter as any)(canvasCtx);
  await writer.place(ID.board, ID.alpha, { x: 40, y: 60, width: 280 });
  return writer.save(ID.board, { nodes: [{ nodeId: ID.alpha, x: 100, y: 120, width: 280 }] });
});

scenario("graph.position drag", [{ position: { node: ID.alpha, x: 120, y: 80 } }], async ({ ctx, load }) => {
  const { makeGraphPositionWriter } = await load("data/graphPositionWriter");
  return (makeGraphPositionWriter as any)(ctx).place(ID.alpha, 120, 80);
});

scenario("workspace.home page", [{ workspaceHome: ID.alpha }], async ({ ctx, load }) => {
  const { makeWorkspaceWriter } = await load("data/workspaceWriter");
  return (makeWorkspaceWriter as any)(ctx).setHome(ID.alpha);
});

scenario("tag.schema patch (fields)", [{ tagSchemaFields: { tag: ID.tag, names: ["status"] } }], async ({ ctx, load }) => {
  const { makeTagSchemaWriter } = await load("data/tagSchemaWriter");
  return (makeTagSchemaWriter as any)(ctx).update(ID.tag, { fields: [{ name: "status", type: "text" }] });
});

scenario("tag.extends config", [{ extendsTags: { tag: ID.tag, targets: [ID.moduleTag] } }], async ({ ctx, load }) => {
  const { makeTagConfigWriter } = await load("data/tagConfigWriter");
  return (makeTagConfigWriter as any)(ctx).saveExtends(ID.tag, [ID.moduleTag], true);
}, { onlineOnly: true });

scenario("tag.resolve-path (#a/b in quick capture)", [{ tagPath: ["area", "reading"] }], async ({ load }) => {
  // lib/data/tagPaths.ts: sendWrite("POST", "/api/tags/resolve-path", { path }).
  const { sendWrite } = await load("data/onlineWrite");
  return (sendWrite as any)("POST", "/api/tags/resolve-path", { path: "area/reading" });
}, { onlineOnly: true });

/** The member level as this release's own UI names it. Releases before the
 *  owner/member change (migrations 125–128) call setMember with a space role
 *  ("viewer"/"editor") and send it as `role`; later ones take the permission
 *  ("view"/"edit"). The caller must speak that release's vocabulary. */
function memberLevel(level: "view" | "edit"): string {
  const source = readFileSync(join(process.cwd(), "src/lib/spaces.ts"), "utf8");
  const oldVocabulary = /setMember:[^\n]*\bSpaceRole\b/.test(source);
  return oldVocabulary ? (level === "view" ? "viewer" : "editor") : level;
}

// Space and member writes (Settings › Spaces and members). The member body
// field was renamed by the owner/member change of 2026-10-23 (migrations 125–128).
scenario("space.create", [{ spaceByName: "Study group" }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).create("Study group");
}, { onlineOnly: true });

scenario("space.set member permission (edit)", [{ member: { space: ID.space, actor: ID.person }, permission: "edit" }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).setMember(ID.space, ID.person, memberLevel("edit"));
}, { onlineOnly: true, personPermission: "view" });

scenario("space.set member permission (view)", [{ member: { space: ID.space, actor: ID.person }, permission: "view" }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).setMember(ID.space, ID.person, memberLevel("view"));
}, { onlineOnly: true });

scenario("space.remove member", [{ member: { space: ID.space, actor: ID.person }, permission: null }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).setMember(ID.space, ID.person, null);
}, { onlineOnly: true });

scenario("workspace.home cleared", [{ workspaceHome: null }], async ({ ctx, load }) => {
  const { makeWorkspaceWriter } = await load("data/workspaceWriter");
  return (makeWorkspaceWriter as any)(ctx).setHome(null);
});

// Saved views (docs/architecture/views-as-modules.md).
scenario("view.create on a tag", [{ viewNamed: { owner: ID.tag, name: "Board view" } }], async ({ ctx, load }) => {
  const { makeViewWriter } = await load("data/viewWriter");
  return (makeViewWriter as any)(ctx).create({ kind: "tag", id: ID.tag }, { name: "Board view", layout: "table", visible_fields: ["title"] });
}, { onlineOnly: true });

scenario("view.update (only the keys changed)", [{ view: { owner: ID.tag, id: ID.view, fields: { name: "Renamed view", layout: "table" } } }], async ({ ctx, load }) => {
  const { makeViewWriter } = await load("data/viewWriter");
  return (makeViewWriter as any)(ctx).update({ kind: "tag", id: ID.tag }, ID.view, { name: "Renamed view", layout: "table" });
});

scenario("view.remove", [{ view: { owner: ID.tag, id: ID.view, fields: null } }], async ({ ctx, load }) => {
  const { makeViewWriter } = await load("data/viewWriter");
  return (makeViewWriter as any)(ctx).remove({ kind: "tag", id: ID.tag }, ID.view);
}, { onlineOnly: true });

scenario("space.rename and capabilities", [{ space: ID.space, fields: { name: "Study group 2" } }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).update(ID.space, { name: "Study group 2", capabilities: { external_ai: false } });
}, { onlineOnly: true });

scenario("space.move a note into a space", [{ node: ID.alpha, fields: { space_id: ID.space } }], async ({ load }) => {
  const { spaceApi } = await load("spaces");
  return (spaceApi as any).move(ID.alpha, ID.space, 1);
}, { onlineOnly: true });

// ── Runner ────────────────────────────────────────────────────────────────────
type Captured = { name: string; expect: Expectation[]; serverFirst?: Scenario["serverFirst"]; personPermission?: Scenario["personPermission"]; online: Array<(typeof rec.requests)[number]>; queued: Array<(typeof rec.requests)[number]>; skipped?: string };
const captured: Captured[] = [];

function seededContext(online: boolean): Harness["ctx"] {
  const note = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, slug: title.toLowerCase().replace(/\W+/g, "-"), markdown: "", source_type: "manual", node_type: "content", parent_id: null, ...extra,
  });
  let state = {
    ...(globalThis as any).__fallbackData,
    nodes: [
      note(ID.alpha, "Alpha", { markdown: SEED_MARKDOWN.alpha, attrs: { status: "draft" } }),
      note(ID.beta, "Beta", { attrs: { status: "draft" }, label_tag_ids: [ID.tag2] }),
      note(ID.parent, "Parent"),
      note(ID.child, "Child", { parent_id: ID.parent, class_tag_ids: [ID.tag] }),
      note(ID.gone, "Hidden", { hidden: true }),
      note(ID.board, "Board", { node_type: "canvas", slug: `canvas-${ID.board}` }),
      note(ID.tag, "reading", { node_type: "class_tag", slug: "tag-reading" }),
      note(ID.tag2, "later", { node_type: "class_tag", slug: "tag-later" }),
    ],
    tags: [{ id: ID.tag, name: "reading", color: "#888888", schema_id: null }, { id: ID.tag2, name: "later", color: "#888888", schema_id: null }],
    tasks: [{ id: ID.task, node_id: ID.alpha, title: "Task", status: "todo" }],
    edges: [{ id: ID.edge, source_node_id: ID.alpha, target_node_id: ID.beta, edge_type: "related", status: "active" }],
  };
  return {
    get data() { return state; }, online,
    setData: (update: any) => { state = typeof update === "function" ? update(state) : update; },
    addToast: () => {}, scheduleUserFolderSync: () => {}, refresh: async () => {},
  } as Harness["ctx"];
}

describe("capture client writes", () => {
  beforeEach(() => {
    rec.requests.length = 0; rec.counter = 0; rec.offline = false;
    // client_updated_at and friends: a fixed clock keeps a re-capture's diff to real changes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T00:00:00.000Z"));
  });

  for (const s of scenarios) {
    it(s.name, async () => {
      const { fallbackData } = await import("../lib/api");
      (globalThis as any).__fallbackData = fallbackData;
      const load = (module: string) => import(/* @vite-ignore */ `../lib/${module}`);
      const entry: Captured = { name: s.name, expect: s.expect, ...(s.serverFirst ? { serverFirst: s.serverFirst } : {}), ...(s.personPermission ? { personPermission: s.personPermission } : {}), online: [], queued: [] };
      try {
        await s.run({ ctx: seededContext(true), load });
        entry.online = rec.requests.filter((r) => r.via === "api");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.online = rec.requests.filter((r) => r.via === "api");
        if (!entry.online.length) entry.skipped = `online run produced no request: ${message}`;
      }
      if (!s.onlineOnly) {
        rec.requests.length = 0; rec.counter = 0; rec.offline = true;
        try { await s.run({ ctx: seededContext(false), load }); } catch { /* a refusal still leaves its queue entries */ }
        entry.queued = rec.requests.filter((r) => r.via === "queue");
      }
      captured.push(entry);
    });
  }

  afterAll(async () => {
    const out = process.env.CAPTURE_OUT;
    if (!out) return;
    mkdirSync(out, { recursive: true });
    const ordered = [...captured].sort((a, b) => a.name.localeCompare(b.name));
    // The refusal codes this release's UI has a message for (lib/serverErrors.ts):
    // a refusal outside this list reaches the person as the generic failure text.
    const { SERVER_ERROR_MESSAGES } = await import("../lib/serverErrors");
    writeFileSync(join(out, "writes.json"), `${JSON.stringify({ ids: ID, serverErrorCodes: Object.keys(SERVER_ERROR_MESSAGES).sort(), scenarios: ordered }, null, 2)}\n`);
  });
});
