// A switched-off library module leaves no trace on the server (業主規則 2026-11-01).
// The frontend twin is frontend/src/test/moduleOffNoTrace.test.ts. No database:
// the workspace's module state is stubbed, so a module added to MODULES is
// checked here with no new test (`describe.each` over the shipped registry).
//
//   • routes: a write under each of its route prefixes answers 409 module_not_imported
//     (reads stay open: removing a module keeps its data);
//   • MCP / api tool lists: its agent tools are not offered, and calling one refuses;
//   • node hooks do not fire; the retrieval source returns nothing;
//   • on: the same gates let everything through (so "off" cannot pass vacuously).
// Background loops and SQL-level gates need a database: see the integration
// files named in docs/architecture/core-vs-modules.md.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One switch for the whole file: which module ids the stubbed workspace has on.
let on: (id: string) => boolean = () => false;
vi.mock("../services/workspaceModules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspaceModules.js")>();
  return { ...actual, workspaceHasModule: async (_workspaceId: string, id: string) => on(id) };
});

import { MODULES, moduleWriteGate, registerModuleEffects, type ModuleDefinition } from "../modules/index.js";
import { getTool, toolsAllowedFor } from "../services/agentTools/index.js";
import { moduleRetrievalHits } from "../services/retrievalSources.js";
import { nodeAttributeCommitted, nodeContentCommitted } from "../services/nodeCommits.js";
import { ModuleNotImportedError } from "../services/workspaceModules.js";
import type { ActorCtx } from "../types.js";

const WS = "00000000-0000-4000-8000-000000000001";
const actor = { id: "a1", name: "Owner", role: "admin", type: "human" } as ActorCtx;
const LIBRARY = MODULES.filter((m) => m.library);
const here = dirname(fileURLToPath(import.meta.url));

/** Library modules whose routes are not behind `routePrefixes`, and why (each is
 *  gated another way, tested elsewhere). A new module is NOT added here to make
 *  this test pass: declare `routePrefixes`, or gate the routes and say where. */
const ROUTES_GATED_ELSEWHERE: Record<string, string> = {
  canvas: "always on (library.alwaysOn): no switch",
  table: "view layout, always on", kanban: "view layout, always on", calendar: "view layout, always on", gallery: "view layout, always on",
  slides: "no routes of its own: the player is frontend only",
  website: "routes share the /api prefix with core and public pages: moduleImportGate / website tests",
};

beforeEach(() => { on = () => false; });

describe.each(LIBRARY.map((m) => [m.id, m] as const))("%s (library module), switched off", (id, mod) => {
  it("refuses writes under each route prefix, and serves them when on", async () => {
    if (!mod.routePrefixes?.length) {
      expect(ROUTES_GATED_ELSEWHERE, `${id} has no routePrefixes: gate its routes or list why`).toHaveProperty(id);
      return;
    }
    const gate = moduleWriteGate(mod, async () => on(id));
    for (const prefix of mod.routePrefixes) {
      const app = new Hono();
      app.use("*", gate);
      app.all("*", (c) => c.json({ reached: true }));
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await app.request(prefix.replace(/:\w+/g, "x"), { method });
        expect(res.status, `${method} ${prefix}`).toBe(409);
        expect(await res.json()).toEqual({ error: "module_not_imported", module: id });
      }
      expect((await app.request(prefix.replace(/:\w+/g, "x"), { method: "GET" })).status, `GET ${prefix} stays open`).toBe(200);
      on = (m) => m === id;
      expect((await app.request(prefix.replace(/:\w+/g, "x"), { method: "POST" })).status, `POST ${prefix} when on`).toBe(200);
      on = () => false;
    }
  });

  it("offers none of its agent tools (MCP tools/list, api runtime) and refuses a call", async () => {
    registerModuleEffects(mod);
    for (const declared of mod.agentTools ?? []) {
      expect(getTool(declared.name), declared.name).toBeTruthy();
      expect((await toolsAllowedFor(null, WS)).map((t) => t.name), `${declared.name} listed while off`).not.toContain(declared.name);
      // The registered handler is the gate (callTool adds the audit trail, which needs a database).
      await expect(getTool(declared.name)!.handler({}, { actor, workspaceId: WS }), declared.name).rejects.toBeInstanceOf(ModuleNotImportedError);
      on = (m) => m === id;
      expect((await toolsAllowedFor(null, WS)).map((t) => t.name), `${declared.name} listed while on`).toContain(declared.name);
      on = () => false;
    }
  });

  it("fires no node hook and adds nothing to retrieval", async () => {
    if (mod.nodeHooks) {
      // A clone under its own id with spying hooks, registered through the same seam.
      const calls: string[] = [];
      const spies = Object.fromEntries(Object.keys(mod.nodeHooks).map((kind) => [kind, async () => { calls.push(kind); }]));
      // Its own id, so the gate asks about the probe (off) and the real module is untouched.
      const probe: ModuleDefinition = { ...mod, id: `probe-${mod.id}`, nodeHooks: spies, agentTools: [], outboxEffects: [], retrievalSource: undefined, viewLayout: undefined, publicSite: undefined, personalTables: [], tagFunction: false, tagFunctions: [] };
      registerModuleEffects(probe);
      await nodeContentCommitted({ workspaceId: WS, nodeId: "n1", text: "x" });
      await nodeAttributeCommitted({ workspaceId: WS, nodeId: "n1", key: "k", value: null, actor });
      // A module that declares nodeHooksWhenOff keeps its hooks (only ones that remove, never add): the website's takedown re-push.
      const expected = mod.nodeHooksWhenOff ? (["contentCommitted", "attributeCommitted"] as const).filter((kind) => kind in spies) : [];
      expect(calls.sort()).toEqual([...expected].sort());
    }
    if (mod.retrievalSource) {
      registerModuleEffects(mod);
      expect(await moduleRetrievalHits(WS, "anything", { limit: 5 })).toEqual([]);
    }
  });
});

describe("the registry and the module folders agree", () => {
  const folders = readdirSync(join(here, "../modules")).filter((name) => statSync(join(here, "../modules", name)).isDirectory());

  it("every module folder is registered and every registered module has a folder", () => {
    expect([...folders].sort()).toEqual(MODULES.map((m) => m.id).sort());
    for (const id of MODULES.map((m) => m.id)) expect(existsSync(join(here, "../modules", id, "index.ts")), id).toBe(true);
  });

  it("module ids are unique", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a module with a background loop gates its work on the module being on", () => {
    // startBackground loops run once per process for all workspaces; each pass
    // must skip workspaces that have the module off (db tests: rssModule, tasksModule).
    const gatedBy: Record<string, Array<[string, RegExp]>> = {
      external_calendars: [["external_calendars/refresh.ts", /workspaceHasModule\(cal\.workspace_id, MODULE_ID\)/]],
      rss: [["rss/fetch.ts", /workspaceHasModule\(row\.workspace_id, "rss"\)/]],
      semantic: [["semantic/indexing.ts", /workspaceHasModule\(id, SEMANTIC_MODULE\)/]],
      tasks: [["tasks/scheduler.ts", /modules_off \? '\$\{TASKS_MODULE_ID\}'/], ["tasks/pushReminders.ts", /modules_off \? '\$\{TASKS_MODULE_ID\}'/]],
    };
    const withLoops = MODULES.filter((m) => m.startBackground).map((m) => m.id).sort();
    expect(withLoops, "a new startBackground module needs its gate listed here").toEqual(Object.keys(gatedBy).sort());
    for (const [id, files] of Object.entries(gatedBy)) {
      for (const [file, gate] of files) expect(readFileSync(join(here, "../modules", file), "utf8"), `${id}: ${file}`).toMatch(gate);
    }
  });
});
