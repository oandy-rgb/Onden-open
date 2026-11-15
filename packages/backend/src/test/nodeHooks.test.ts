// Node commit hooks: core reports a content or attribute change, modules
// decide what follows. A failing attribute hook must not fail the user's write.
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerNodeHooks, spaceAudienceCommitted } from "../spine/nodeHooks.js";
import { nodeContentCommitted, nodeAttributeCommitted } from "../services/nodeCommits.js";
import { mountModules, MODULES, type ModuleApp, type ModuleDefinition } from "../modules/index.js";
import type { ActorCtx } from "../types.js";

const actor: ActorCtx = { id: "a", name: "A", role: "admin", type: "human" };

describe("node commit hooks", () => {
  it("runs every registered content hook with the change", async () => {
    const seen = vi.fn(async () => {});
    registerNodeHooks(`probe-${Math.random()}`, { contentCommitted: seen });
    await nodeContentCommitted({ workspaceId: "w", nodeId: "n", text: "T\n\nbody", triggeredByEventId: "7" });
    expect(seen).toHaveBeenCalledWith({ workspaceId: "w", nodeId: "n", text: "T\n\nbody", triggeredByEventId: "7" });
  });

  it("a failing attribute hook is contained; later hooks still run", async () => {
    const later = vi.fn(async () => {});
    registerNodeHooks(`boom-${Math.random()}`, { attributeCommitted: async () => { throw new Error("deploy down"); } });
    registerNodeHooks(`later-${Math.random()}`, { attributeCommitted: later });
    await expect(nodeAttributeCommitted({ workspaceId: "w", nodeId: "n", key: "_published", value: "true", actor })).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("a failing space-audience hook is contained; later hooks still run", async () => {
    const later = vi.fn(async () => {});
    registerNodeHooks(`boom-space-${Math.random()}`, { spaceAudienceCommitted: async () => { throw new Error("deploy down"); } });
    registerNodeHooks(`later-space-${Math.random()}`, { spaceAudienceCommitted: later });
    await expect(spaceAudienceCommitted({ workspaceId: "w", actor })).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledWith({ workspaceId: "w", actor });
  });

  it("a module's hooks are registered by mountModules; a second, different set under its id is refused", async () => {
    const hook = vi.fn(async () => {});
    const id = `mod-${Math.random()}`;
    const mod: ModuleDefinition = { id, registerRoutes: () => {}, nodeHooks: { contentCommitted: hook } };
    mountModules(new Hono() as unknown as ModuleApp, [mod]);
    await nodeContentCommitted({ workspaceId: "w", nodeId: "n", text: "x" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(() => registerNodeHooks(id, { contentCommitted: hook })).toThrow(/already registered/);
  });

  it("embedding and site re-deploy are modules, not core", () => {
    expect(MODULES.find((m) => m.id === "semantic")?.nodeHooks?.contentCommitted).toBeTypeOf("function");
    expect(MODULES.find((m) => m.id === "website")?.nodeHooks?.attributeCommitted).toBeTypeOf("function");
    expect(MODULES.find((m) => m.id === "website")?.nodeHooks?.spaceAudienceCommitted).toBeTypeOf("function");
  });
});
