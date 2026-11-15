// A library module only acts in workspaces that imported it (modules/index.ts).
//
//   • Its agent tools refuse with module_not_imported; imported, they run.
//   • Its node hooks don't fire; imported, they do.
//   • Writes under its route prefixes answer 409; reads stay open.
//   • NULL modules (a pre-library workspace) counts as everything imported.
//   • A module without `library` (infrastructure) always acts.
//
// Uses throwaway modules and its own workspace, so no shipped behaviour (site
// deploys, embeddings) runs and other files' workspaces are untouched.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// Only this file's MCP request resolves to the test's own workspace.
let appWorkspace: string | null = null;
vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  return { ...actual, getWorkspaceId: async () => appWorkspace ?? actual.getWorkspaceId() };
});
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Hono } from "hono";
import { q } from "../db.js";
import { MODULES, moduleWriteGate, registerModuleEffects, type ModuleDefinition } from "../modules/index.js";
import { callTool } from "../services/agentTools/index.js";
import { nodeAttributeCommitted } from "../services/nodeCommits.js";
import { ModuleNotImportedError, isModuleImported, workspaceModules } from "../services/workspaceModules.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import mcpRouter from "../routes/mcp.js";
import { apiOnError } from "../httpError.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("module import gate (DB)", () => {
  const stamp = randomUUID().slice(0, 8);
  const calls: string[] = [];
  const libraryModule: ModuleDefinition = {
    id: `gate-lib-${stamp}`,
    registerRoutes: () => {},
    library: {},
    agentTools: [{
      name: `gateLibTool_${stamp}`,
      access: "read",
      description: "test",
      inputSchema: z.object({}),
      handler: async () => { calls.push("tool"); return { ok: true }; },
    }],
    nodeHooks: { attributeCommitted: async () => { calls.push("hook"); } },
  };
  const infraModule: ModuleDefinition = {
    id: `gate-infra-${stamp}`,
    registerRoutes: () => {},
    nodeHooks: { attributeCommitted: async () => { calls.push("infra-hook"); } },
  };
  let WS = "";
  let actor: ActorCtx = { id: `gate-owner-${stamp}`, name: "Owner", role: "admin", type: "human" };

  const setModules = (modules: string[] | null) =>
    setModulesOn(WS, modules);
  const fire = () => nodeAttributeCommitted({ workspaceId: WS, nodeId: randomUUID(), key: "x", value: null, actor });

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Gate', $1) RETURNING id`, [`gate-${stamp}`])).rows[0]!.id;
    actor = await persistActor(WS, actor);
    registerModuleEffects(libraryModule);
    registerModuleEffects(libraryModule); // a repeat registration is a no-op
    registerModuleEffects(infraModule);
  });

  it("refuses the tool and skips the hook while the module is not imported", async () => {
    await setModules([]);
    calls.length = 0;
    await expect(callTool(`gateLibTool_${stamp}`, {}, { actor, workspaceId: WS })).rejects.toBeInstanceOf(ModuleNotImportedError);
    await fire();
    expect(calls).toEqual(["infra-hook"]);
  });

  it("an agent calling the tool over MCP gets 409 module_not_imported", async () => {
    await setModules([]);
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    app.route("/api/mcp", mcpRouter);
    appWorkspace = WS; // the MCP route resolves the app's workspace: point it at ours
    try {
      const res = await app.request(`/api/mcp/tools/gateLibTool_${stamp}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "module_not_imported", module: libraryModule.id });
    } finally {
      appWorkspace = null;
    }
  });

  it("runs both once the module is imported", async () => {
    await setModules([libraryModule.id]);
    calls.length = 0;
    await expect(callTool(`gateLibTool_${stamp}`, {}, { actor, workspaceId: WS })).resolves.toEqual({ ok: true });
    await fire();
    expect(calls.sort()).toEqual(["hook", "infra-hook", "tool"]);
  });

  it("treats a pre-library workspace (NULL) as having everything imported", async () => {
    await setModules(null);
    calls.length = 0;
    await fire();
    expect(calls.sort()).toEqual(["hook", "infra-hook"]);
  });

  it("refuses writes under the module's routes while it is not imported; reads stay open", async () => {
    const app = new Hono();
    const gate = moduleWriteGate(libraryModule, async (mod) => isModuleImported(await workspaceModules(WS), mod.id));
    app.use("/api/gate", gate).use("/api/gate/*", gate);
    app.get("/api/gate/items", (c) => c.json({ items: [] }));
    app.post("/api/gate", (c) => c.json({ created: true }));
    app.delete("/api/gate/items/1", (c) => c.json({ deleted: true }));

    await setModules([]);
    expect((await app.request("/api/gate/items")).status).toBe(200);
    const refused = await app.request("/api/gate", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "module_not_imported", module: libraryModule.id });
    expect((await app.request("/api/gate/items/1", { method: "DELETE" })).status).toBe(409);

    await setModules([libraryModule.id]);
    expect((await app.request("/api/gate", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/gate/items/1", { method: "DELETE" })).status).toBe(200);
  });
});

describe("shipped library modules declare their route prefixes", () => {
  // Exempt: the website (routes shared with public pages at /api) and skills
  // (no routes of its own — skills are used through MCP prompts, and the harness
  // ignores #技能 notes while the module isn't imported), and slides
  // (browser-only: slides from a note, outlines are an MCP prompt), and the view
  // modules table, calendar, kanban and gallery (layouts of a tag's saved views, gated
  // in services/tagViews.ts).
  it("every library module with routes of its own has routePrefixes", () => {
    const exempt = new Set(["website", "skills", "slides", "table", "calendar", "kanban", "gallery"]);
    const missing = MODULES.filter((m) => m.library && !exempt.has(m.id) && !m.routePrefixes?.length).map((m) => m.id);
    expect(missing).toEqual([]);
  });
});
