// The ai module switched off (no database): the built-in agent tools are not offered and refuse,
// a runner polling for work is told there is none, and the modules that need ai go off with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

let on: (id: string) => boolean = () => false;
vi.mock("../../services/workspaceModules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspaceModules.js")>();
  return { ...actual, workspaceHasModule: async (_workspaceId: string, id: string) => on(id) };
});
vi.mock("../../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db.js")>();
  return { ...actual, getWorkspaceId: async () => "00000000-0000-4000-8000-000000000001" };
});

import { MODULES, registerModuleEffects } from "../index.js";
import { aiModule } from "./index.js";
import { callTool, listTools, toolsAllowedFor } from "../../services/agentTools/index.js";
import { ModuleNotImportedError, modulesOn, moduleStateOf } from "../../services/workspaceModules.js";
import type { ActorCtx } from "../../types.js";

const WS = "00000000-0000-4000-8000-000000000001";
const actor = { id: "a1", name: "Owner", role: "admin", type: "human" } as ActorCtx;

beforeEach(() => { on = () => false; registerModuleEffects(aiModule); });

describe("ai module switched off", () => {
  it("offers none of the built-in agent tools and refuses a call", async () => {
    const builtIn = ["searchNodes", "getNode", "updateNode", "createNode", "applyTag"];
    for (const name of builtIn) expect(listTools().map((t) => t.name)).toContain(name);
    expect((await toolsAllowedFor(null, WS)).map((t) => t.name)).not.toContain("getNode");
    await expect(callTool("getNode", {}, { actor, workspaceId: WS })).rejects.toBeInstanceOf(ModuleNotImportedError);
    on = (id) => id === "ai";
    expect((await toolsAllowedFor(null, WS)).map((t) => t.name)).toEqual(expect.arrayContaining(builtIn));
  });

  it("tells a runner polling for work there is none, and lets it through when on", async () => {
    const guarded = new Hono();
    aiModule.registerRoutes(guarded as never);
    const res = await guarded.request("/api/mcp/sessions/pending");
    expect(await res.json()).toEqual({ sessions: [] });
    on = (id) => id === "ai";
    // On, the request reaches the real route (which needs a login, so it is refused there, not answered empty).
    expect(await (await guarded.request("/api/mcp/sessions/pending")).json()).not.toEqual({ sessions: [] });
  });

  it("declares every AI route prefix so a write is refused while off", () => {
    expect(aiModule.routePrefixes).toEqual(expect.arrayContaining(["/api/agent-sessions", "/api/ai-suggestions", "/api/ai", "/api/mcp"]));
    expect(aiModule.library?.confirmOnce).toBe(true);
  });
});

describe("modules that need ai", () => {
  it("skills go off with ai and come back with it, and ai starts off in a new workspace", () => {
    registerModuleEffects(aiModule);
    for (const mod of MODULES) registerModuleEffects(mod);
    const fresh = moduleStateOf({ modules_off: [], modules_confirmed: [] });
    expect(modulesOn(fresh)).not.toContain("ai");
    expect(modulesOn(fresh)).not.toContain("skills");
    const agreed = moduleStateOf({ modules_off: [], modules_confirmed: ["ai"] });
    expect(modulesOn(agreed)).toEqual(expect.arrayContaining(["ai", "skills"]));
    const turnedOff = moduleStateOf({ modules_off: ["ai"], modules_confirmed: ["ai"] });
    expect(modulesOn(turnedOff)).not.toContain("skills");
    // Skills' own choice is kept: only ai going off hides it.
    const skillsOff = moduleStateOf({ modules_off: ["skills"], modules_confirmed: ["ai"] });
    expect(modulesOn(skillsOff)).toContain("ai");
    expect(modulesOn(skillsOff)).not.toContain("skills");
  });
});
