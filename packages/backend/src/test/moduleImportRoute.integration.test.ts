// Who may import a module, at the HTTP boundary (PATCH /api/workspace/modules).
// The app now offers importing where a module is used — a tag page's 「加功能」
// and the editor's # menu, after a confirmation — besides Settings › Modules
// (docs/architecture/module-library.md, 「用到才匯入」). Every one of those
// sends this same request, so this route is the one gate: only the workspace
// owner (principal admin) imports or removes; an editor, an admin who is not
// the owner and the owner's own agent token are refused with 403, and nothing
// is written (no list change, no MODULE_IMPORTED event).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: the tests set its owner and its module list, which
// in the shared default workspace other tests also read and change.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import workspaceRouter from "../routes/workspace.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { workspaceModules } from "../services/workspaceModules.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/workspace", workspaceRouter);

const importModule = (actor: ActorCtx, module: string, imported = true) => {
  currentActor = actor;
  return app.request("/api/workspace/modules", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ module, imported, tag_name: "複習" }),
  });
};

describe.skipIf(!isTestDb)("module import authority at the route (DB)", () => {
  let WS = "";
  let owner: ActorCtx;
  let otherAdmin: ActorCtx;
  let editor: ActorCtx;
  let ownerToken: ActorCtx;

  const VIEWS = ["canvas", "slides", "table", "calendar", "kanban", "gallery"]; // always on (the whiteboard, slides and the view modules): listed whatever was imported
  const modules = () => workspaceModules(WS);
  const importEvents = async () => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND event_type IN ('MODULE_IMPORTED', 'MODULE_REMOVED')`, [WS],
  )).rows[0]!.n);

  beforeAll(async () => {
    registerShippedModules();
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Module import', $1) RETURNING id::text`, [`modimp-${randomUUID()}`])).rows[0]!.id;
    WS = await getWorkspaceId();
    otherAdmin = await persistActor(WS, { id: "", name: "Other admin", type: "human", role: "admin" });
    editor = await persistActor(WS, { id: "", name: "Editor", type: "human", role: "editor" });
    owner = await persistActor(WS, { id: "", name: "Owner", type: "human", role: "admin" }); // last human admin: the owner
    ownerToken = await persistActor(WS, { id: "", name: "Owner token", type: "agent", role: "admin",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    await setWorkspaceOwner(WS, owner.id);
  });

  // Each test starts with no module imported (the owner's import test leaves
  // review in the list).
  beforeEach(async () => {
    await setModulesOn(WS, []);
  });

  it("refuses everyone but the owner, and writes nothing", async () => {
    const before = await importEvents();
    for (const actor of [editor, otherAdmin, ownerToken]) {
      const response = await importModule(actor, "review");
      expect(response.status, actor.name).toBe(403);
    }
    expect(await modules()).toEqual(VIEWS);
    expect(await importEvents()).toBe(before);
    // Removing is the same decision.
    await setModulesOn(WS, ["rss"]);
    expect((await importModule(editor, "rss", false)).status).toBe(403);
    expect(await modules()).toEqual(["rss", ...VIEWS]);
    await setModulesOn(WS, []);
  });

  it("the owner imports, and the module's tag comes with it", async () => {
    await setModulesOn(WS, ["ai"]); // skills needs ai
    const response = await importModule(owner, "skills");
    expect(response.status).toBe(200);
    const body = await response.json() as { modules: string[]; module_tag_id?: string };
    expect(body.modules).toEqual(expect.arrayContaining(["skills", ...VIEWS]));
    expect(body.module_tag_id).toBeTruthy();
    expect(await modules()).toEqual(expect.arrayContaining(["skills", ...VIEWS]));
  });
});
