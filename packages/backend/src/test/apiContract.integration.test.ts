// API contract, backend side: boots the real assembled app (src/index.ts), seeds
// a small workspace through the real routes and records the SHAPE (keys, types,
// nullability; no values) of what the server sends into
// packages/markdown/contract/api-shapes.json. The frontend side
// (frontend src/test/apiContract.test.ts) checks that file against the types the
// app reads. Neither side tests its own idea of the shape any more: this test
// fails when the server's shape moved and the file was not regenerated, and the
// frontend test fails when the file no longer carries what the app reads.
//
//   regenerate after an intended API change:
//     UPDATE_CONTRACT=1 npm test -- src/test/apiContract.integration.test.ts
//   then commit packages/markdown/contract/api-shapes.json, and run the
//   frontend suite (it tells you which frontend reader the change breaks).
//
// What is recorded:
//   - every mounted GET route (introspected from app.routes, so a new one is
//     picked up and fails this test until recorded), for the owner and for a
//     plain member, with the bootstrap in each of its four forms;
//   - the sync delta and its companions, and the responses of the write
//     routes the seed uses (POST/PATCH/PUT of notes, tags, edges, canvases,
//     tasks, attributes, spaces).
// Not recorded, listed in the file's "unexercised" with the reason: routes that
// need pgroonga/vector (SKIPPED_NEEDS_EXTENSION), non-JSON bodies, routes
// the seed does not reach (a 4xx/5xx answer is an error shape, not the contract).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createMemberModuleTag } from "../services/workspaceModules.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import { shapeOf, type WireShape } from "./helpers/wireShape.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

registerShippedModules();

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: sessionExternalId, email: `${sessionExternalId}@contract.test` } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const CONTRACT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../markdown/contract/api-shapes.json");

type Who = "owner" | "member";
type Recorded = { status: number; shape: WireShape };
type ContractFile = {
  /** Where the shapes come from; regenerate with UPDATE_CONTRACT=1. */
  note: string;
  routes: Record<string, Recorded>;
  unexercised: Record<string, string>;
};

// Routes that cannot run in an environment without these extensions (the CI
// image has them; a bare Postgres does not). Skipped everywhere, so the file
// is the same in both.
const SKIPPED_NEEDS_EXTENSION: Record<string, string> = {
  "GET /api/nodes/search": "pgroonga full-text search",
};

// Answers that are not JSON, or that never end.
const SKIPPED_NOT_JSON: Record<string, string> = {
  "GET /api/events/stream": "server-sent events, never ends",
  "GET /api/backup/full.zip": "zip download",
  "GET /api/export-static": "zip download",
  "GET /api/export/markdown.zip": "zip download",
  "GET /api/nodes/:id/export.html": "html download",
  "GET /api/media/:filename": "binary file",
  "GET /api/skills/:id/skill.md": "markdown download",
  "GET /api/rss/opml": "xml download",
  "GET /api/snapshot": "lines of JSON, one message a line (owner only; services/stampedSnapshotStream.ts)",
  "GET /api/git/diff/:hash": "git backup only",
  "GET /api/auth/*": "better-auth, mocked here",
  "GET /api/auth/providers": "better-auth, mocked here",
};

const shapes: Record<string, Recorded> = {};
const samples: Record<string, { status: number; bodies: unknown[] }> = {};

/** Merge another response into the shape recorded under `key`. */
function record(key: string, status: number, body: unknown): void {
  const slot = (samples[key] ??= { status, bodies: [] });
  slot.bodies.push(body);
}

const WHO_HEADERS: Record<Who, string> = { owner: "contract-owner", member: "contract-member" };

async function call(who: Who | null, method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  sessionExternalId = who ? WHO_HEADERS[who] : null;
  try {
    return await app.request(path, {
      method,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } finally {
    sessionExternalId = null;
  }
}

/** A seed write: must succeed, and its response is recorded under `key`
 *  (default "METHOD pattern"). */
async function write(who: Who, method: string, path: string, pattern: string, json?: unknown, headers?: Record<string, string>): Promise<Record<string, any>> {
  const res = await call(who, method, path, json, headers);
  const text = await res.text();
  expect(res.status, `${method} ${path} → ${text.slice(0, 300)}`).toBeLessThan(300);
  const body = text ? JSON.parse(text) : null;
  record(`${method} ${pattern}`, res.status, body);
  return body ?? {};
}

describe.skipIf(!isTestDb)("API contract: recorded response shapes (real app, DB)", () => {
  const ids = {
    owner: "", member: "", agent: "",
    sharedSpace: "", defaultSpace: "", personalSpace: "",
    note: "", child: "", other: "", tag: "", classTag: "", mergeTarget: "", edge: "", canvas: "", task: "", inboxEvent: "",
    trashed: "", view: "",
  };
  let unexercised: Record<string, string> = {};

  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Contract', $1) RETURNING id::text`, [`contract-${randomUUID()}`])).rows[0]!.id;
    await turnModuleOn(WS, "ai"); // the AI routes are recorded too

    // The first person to sign in to a workspace owns it; the second is a plain
    // member in no shared space (services/actors.ts actorForSession).
    for (const who of ["owner", "member"] as const) {
      expect((await call(who, "GET", "/api/spaces")).status).toBe(200);
      ids[who] = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = $2`, [WS, WHO_HEADERS[who]])).rows[0]!.id;
    }
    await ensureConfigNode(WS); // the settings note exists once the owner has changed a setting; reads never create it
    ids.defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    ids.personalSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [WS, ids.owner])).rows[0]!.id;

    // Spaces: the member edits the default space and may only view a second one.
    ids.sharedSpace = (await write("owner", "POST", "/api/spaces", "/api/spaces", { name: "Reading" })).id;
    await write("owner", "PUT", `/api/spaces/${ids.defaultSpace}/members/${ids.member}`, "/api/spaces/:id/members/:actorId", { permission: "edit" });
    await write("owner", "PUT", `/api/spaces/${ids.sharedSpace}/members/${ids.member}`, "/api/spaces/:id/members/:actorId", { permission: "view" });
    await write("owner", "PATCH", `/api/spaces/${ids.sharedSpace}`, "/api/spaces/:id", { name: "Reading list" });

    // Notes: a plain one with a wikilink, a child, one in the view-only space.
    ids.other = (await write("owner", "POST", "/api/nodes", "/api/nodes", { space_id: ids.defaultSpace, title: "Contract other", markdown: "Linked from the first note." })).id;
    ids.note = (await write("owner", "POST", "/api/nodes", "/api/nodes", {
      space_id: ids.defaultSpace, title: "Contract note", markdown: "# Heading\n\nSee [[Contract other]] and #contract-label.\n\n- [ ] a checklist line\n",
    })).id;
    ids.child = (await write("owner", "POST", "/api/nodes", "/api/nodes", { parent_id: ids.note, title: "Contract child", markdown: "child body" })).id;
    await write("owner", "POST", "/api/nodes", "/api/nodes", { space_id: ids.sharedSpace, title: "Contract shared note", markdown: "view-only for the member" });
    await write("owner", "PATCH", `/api/nodes/${ids.note}`, "/api/nodes/:id", { title: "Contract note (edited)", markdown: "# Heading\n\nSee [[Contract other]].\n" });
    await write("owner", "PUT", `/api/nodes/${ids.note}/attributes/status`, "/api/nodes/:id/attributes/:key", { value: "open", value_type: "text" });

    // Tags: a label tag applied to a note, a class tag with a schema and a note using it.
    ids.tag = (await write("owner", "POST", "/api/tags", "/api/tags", { name: "contract-label" })).id;
    await write("owner", "PUT", `/api/nodes/${ids.note}/tags/${ids.tag}`, "/api/nodes/:id/tags/:tagId", {});
    ids.classTag = (await write("owner", "POST", "/api/tags", "/api/tags", { name: "contract-class" })).id;
    await write("owner", "PATCH", `/api/tags/${ids.classTag}/schema`, "/api/tags/:id/schema", {
      fields: [{ key: "stage", type: "select", options: ["a", "b"] }, { key: "score", type: "number" }],
    });
    await write("owner", "PUT", `/api/nodes/${ids.other}/tags/${ids.classTag}`, "/api/nodes/:id/tags/:tagId", {});

    // Edges, a canvas with a card, tasks.
    ids.edge = (await write("owner", "POST", "/api/edges", "/api/edges", { source_node_id: ids.note, target_node_id: ids.other, edge_type: "related" })).id;
    ids.canvas = (await write("owner", "POST", "/api/canvases", "/api/canvases", { title: "Contract canvas", space_id: ids.defaultSpace })).id;
    await write("owner", "PATCH", `/api/boards/${ids.canvas}`, "/api/boards/:id", { cards: { upsert: [{ nodeId: ids.note, x: 10, y: 20, width: 200, height: 100 }] } });
    // The tasks module's own tag: a first task made it before tasks became function references; the recorded shapes of
    // tags with a module, functions and a private schema come from it, so it is made here the way that first task did.
    await withEventTransaction(WS, () => createMemberModuleTag(
      { id: ids.owner, name: "Owner", role: "admin", type: "human" }, WS, { module: "tasks", names: ["task"], uiContext: "test.contract" }));
    ids.task = (await write("owner", "POST", `/api/nodes/${ids.note}/tasks`, "/api/nodes/:id/tasks", { title: "Dated task", due_date: "2030-01-02" })).id;
    await write("owner", "POST", `/api/nodes/${ids.note}/tasks`, "/api/nodes/:id/tasks", { title: "Undated task" });
    await write("owner", "PATCH", `/api/tasks/${ids.task}`, "/api/tasks/:id", { status: "doing" });

    // A saved view on a note, a second tag to merge into, a deleted note, a preference.
    ids.view = (await write("owner", "POST", `/api/nodes/${ids.note}/views`, "/api/nodes/:id/views", { name: "Contract table" })).id;
    ids.mergeTarget = (await write("owner", "POST", "/api/tags", "/api/tags", { name: "contract-merge-target" })).id;
    ids.trashed = (await write("owner", "POST", "/api/nodes", "/api/nodes", { space_id: ids.defaultSpace, title: "Contract trashed", markdown: "to trash" })).id;
    await write("owner", "DELETE", `/api/nodes/${ids.trashed}`, "/api/nodes/:id");
    await write("owner", "PUT", "/api/me/prefs/nav", "/api/me/prefs/:key", { value: { order: ["notes", "tasks"], phone: 2 } });

    // An inbox item: an agent's note waiting for the owner's review.
    const agent = await persistActor(WS, {
      id: "agent", name: "Contract agent", type: "agent",
      tokenScope: { tokenId: "fixture", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    ids.agent = agent.id;
    await callTool("createNode", { title: "Agent note", space_id: ids.defaultSpace }, { actor: agent, workspaceId: WS, dryRun: false });
    await awaitAllDispatchers();

    // The route inventory the sweep walks.
    unexercised = {};
  }, 120_000);

  /** Routes whose seeded request needs more than path params (a query, a
   *  deleted note, a saved view). */
  function specificPath(pattern: string): string | null {
    switch (pattern) {
      case "/api/me/prefs/:key": return "/api/me/prefs/nav";
      case "/api/spaces/move-preview": return `/api/spaces/move-preview?node=${ids.note}&to=${ids.sharedSpace}`;
      case "/api/tags/:sourceId/merge-preview": return `/api/tags/${ids.tag}/merge-preview?target=${ids.mergeTarget}`;
      case "/api/nodes/:id/views/:viewId/exec": return `/api/nodes/${ids.note}/views/${ids.view}/exec`;
      case "/api/nodes/:id/purge-preview": return `/api/nodes/${ids.trashed}/purge-preview`;
      case "/api/history/at": return `/api/history/at?t=${encodeURIComponent(new Date().toISOString())}`;
      case "/api/history/at/:id": return `/api/history/at/${ids.note}?t=${encodeURIComponent(new Date().toISOString())}`;
      default: return null;
    }
  }

  /** Concrete value for each path param. An unknown param throws: a newly
   *  mounted parameterized GET route must be wired in here on purpose. */
  function fill(path: string): string {
    return path.replace(/:([A-Za-z_]+)/g, (_m, name: string) => {
      switch (name) {
        case "id":
          if (path.startsWith("/api/tags")) return ids.classTag;
          if (path.startsWith("/api/spaces")) return ids.sharedSpace;
          if (path.startsWith("/api/canvases") || path.startsWith("/api/boards")) return ids.canvas;
          if (path.startsWith("/api/actors")) return ids.member;
          return ids.note;
        case "ref": return "nosuchref"; // /api/nodes/:id/block-home/:ref
        case "tagId": case "sourceId": return ids.classTag;
        case "nodeId": return ids.note;
        case "date": return "2030-01-02";
        case "event_id": return ids.inboxEvent || "1";
        case "viewId": case "job": case "blockId": case "hash": case "filename": case "token": case "key":
          return name === "key" ? "nosuchpref" : "00000000-0000-0000-0000-000000000000";
        case "actorId": return ids.member;
        default:
          throw new Error(`apiContract: no substitution for :${name} in ${path} — a new parameterized GET route appeared; extend fill() deliberately`);
      }
    });
  }

  function inventory(): string[] {
    return [...new Set(
      (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
        .filter((r) => r.method === "GET").map((r) => r.path),
    )].sort();
  }

  it("records every GET route and the sync, bootstrap and write shapes", async () => {
    // Bootstrap in its four forms (what the app asks for), as owner and member.
    for (const who of ["owner", "member"] as const) {
      for (const [variant, path, headers] of [
        ["full", "/api/bootstrap", {}],
        ["slim", "/api/bootstrap?bodies=none", {}],
        ["lean", "/api/bootstrap?bodies=none", { "X-Onden-Bootstrap": "lean" }],
        ["lean2 wire", "/api/bootstrap?bodies=none", { "X-Onden-Bootstrap": "lean2" }],
      ] as const) {
        const res = await call(who, "GET", path, undefined, headers);
        expect(res.status, `${who} bootstrap ${variant}`).toBe(200);
        const body = await res.json();
        record(`GET /api/bootstrap [${variant}]`, 200, body);
        if (variant === "lean2 wire") {
          // The app decodes the compact form before using it; the decoded form
          // is what its types describe, so that is recorded too.
          const { decodeBootstrapWire } = await import(/* @vite-ignore */ DECODER_URL) as { decodeBootstrapWire: (data: unknown) => unknown };
          record("GET /api/bootstrap [lean2 decoded]", 200, decodeBootstrapWire(body));
        }
      }
    }

    // Sync: the delta the app pulls, as owner and member, plus its companions.
    for (const who of ["owner", "member"] as const) {
      const delta = await call(who, "POST", "/api/sync", { since: 0 });
      expect(delta.status).toBe(200);
      record("POST /api/sync", 200, await delta.json());
      const bodies = await call(who, "POST", "/api/sync/bodies", { ids: [ids.note] });
      record("POST /api/sync/bodies", bodies.status, await bodies.json());
      const projection = await call(who, "POST", "/api/sync/nodes", { ids: [ids.note, ids.other] });
      record("POST /api/sync/nodes", projection.status, await projection.json());
      const drawings = await call(who, "POST", "/api/sync/drawings", { ids: [ids.note] });
      record("POST /api/sync/drawings", drawings.status, await drawings.json());
    }

    // The inbox event the review routes are keyed by.
    const inbox = await (await call("owner", "GET", "/api/inbox")).json() as { events?: Array<{ id: string }> };
    ids.inboxEvent = inbox.events?.[0]?.id ?? "";

    // Every other GET route.
    for (const path of inventory()) {
      const key = `GET ${path}`;
      if (key === "GET /api/bootstrap") continue; // recorded above, in each of its forms
      const skipped = SKIPPED_NEEDS_EXTENSION[key] ?? SKIPPED_NOT_JSON[key];
      if (skipped) { unexercised[key] = skipped; continue; }
      let got = 0;
      let last = 0;
      for (const who of ["owner", "member"] as const) {
        const res = await call(who, "GET", specificPath(path) ?? fill(path));
        last = res.status;
        const type = res.headers.get("content-type") ?? "";
        if (res.status >= 200 && res.status < 300 && type.includes("json")) {
          record(key, res.status, await res.json());
          got++;
        } else {
          await res.arrayBuffer();
        }
      }
      if (got === 0) unexercised[key] = `answered ${last} for the seeded ids; no success shape recorded`;
    }

    for (const [key, slot] of Object.entries(samples)) {
      shapes[key] = { status: slot.status, shape: shapeOf(...slot.bodies) };
    }
    const current: ContractFile = {
      note: "Generated by packages/backend/src/test/apiContract.integration.test.ts (UPDATE_CONTRACT=1 regenerates). Shapes only, no values; format in README.md.",
      routes: Object.fromEntries(Object.entries(shapes).sort(([a], [b]) => (a < b ? -1 : 1))),
      unexercised: Object.fromEntries(Object.entries(unexercised).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    const text = `${JSON.stringify(current, null, 2)}\n`;

    if (process.env.UPDATE_CONTRACT === "1") {
      mkdirSync(dirname(CONTRACT_FILE), { recursive: true });
      writeFileSync(CONTRACT_FILE, text);
      return;
    }
    let recorded: ContractFile;
    try { recorded = JSON.parse(readFileSync(CONTRACT_FILE, "utf-8")) as ContractFile; }
    catch { throw new Error(`apiContract: ${CONTRACT_FILE} is missing — generate it with UPDATE_CONTRACT=1`); }
    const problems = describeDifferences(recorded, current);
    expect(problems, `The server's response shapes differ from the committed contract (${CONTRACT_FILE}).\n` +
      `If the change is intended, regenerate it with UPDATE_CONTRACT=1 and run the frontend suite.\n\n${problems.join("\n")}\n`).toEqual([]);
  }, 180_000);
});

// ── readable differences ─────────────────────────────────────────────────

const DECODER_URL = new URL("../../../frontend/src/lib/data/bootstrapWire.ts", import.meta.url).href;

/** One line per route and field that differs: which route, which field, what
 *  the file says and what the server sends now. */
function describeDifferences(recorded: ContractFile, current: ContractFile): string[] {
  const out: string[] = [];
  for (const key of Object.keys(current.routes)) {
    if (!recorded.routes[key]) out.push(`+ ${key}: new route/variant, not in the file`);
  }
  for (const key of Object.keys(recorded.routes)) {
    const now = current.routes[key];
    if (!now) { out.push(`- ${key}: in the file but no longer answered`); continue; }
    const was = recorded.routes[key]!;
    if (was.status !== now.status) out.push(`~ ${key}: status ${was.status} → ${now.status}`);
    diffShape(key, "", was.shape, now.shape, out);
  }
  for (const [key, why] of Object.entries(current.unexercised)) {
    if (recorded.unexercised[key] !== why) out.push(`~ ${key}: unexercised reason is now "${why}" (file: "${recorded.unexercised[key] ?? "recorded"}")`);
  }
  for (const key of Object.keys(recorded.unexercised)) {
    if (!(key in current.unexercised)) out.push(`~ ${key}: was unexercised, is now recorded`);
  }
  return out;
}

function diffShape(route: string, path: string, was: WireShape | boolean, now: WireShape | boolean, out: string[]): void {
  const at = path || "(body)";
  if (JSON.stringify(was) === JSON.stringify(now)) return;
  const isObj = (v: unknown): v is Record<string, WireShape | boolean> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(was) && Array.isArray(now)) { diffShape(route, `${path}[]`, was[0]!, now[0]!, out); return; }
  if (isObj(was) && isObj(now)) {
    for (const key of Object.keys(was)) {
      if (!(key in now)) out.push(`~ ${route}: ${path ? `${path}.` : ""}${key} no longer sent`);
    }
    for (const key of Object.keys(now)) {
      if (!(key in was)) out.push(`~ ${route}: ${path ? `${path}.` : ""}${key} is new`);
      else diffShape(route, `${path ? `${path}.` : ""}${key}`, was[key]!, now[key]!, out);
    }
    return;
  }
  out.push(`~ ${route}: ${at} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
}
