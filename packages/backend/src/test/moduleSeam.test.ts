// The module seam (src/modules) — pins the convention, not any one module:
//   • mountModules mounts every module's routes onto the app;
//   • optional agentTools flow into the EXISTING registry (agent registry =
//     the agent permission boundary);
//   • duplicate module ids are a startup error, not a silent shadow;
//   • the review module is registered and answers on /api/review/*.
// No DB — route handlers that would touch Postgres aren't invoked here.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { mountModules, MODULES, type ModuleDefinition, type ModuleApp } from "../modules/index.js";
import { getTool } from "../services/agentTools/index.js";
import type { ActorCtx } from "../types.js";
import { apiOnError } from "../httpError.js";

// The production error boundary: a module route that throws a validation
// error answers 400 through it, exactly as in src/index.ts.
const mkApp = () => {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  return app;
};

const fakeModule: ModuleDefinition = {
  id: "fake",
  registerRoutes: (app: ModuleApp) => {
    const r = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    r.get("/ping", (c) => c.json({ pong: true }));
    app.route("/api/fake", r);
  },
  agentTools: [{
    name: "fakeModuleTool",
    access: "read",
    description: "seam test fixture",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  }],
};

describe("module seam", () => {
  it("mounts a module's routes through the single seam", async () => {
    const app = mkApp();
    mountModules(app, [fakeModule]);
    const res = await app.request("/api/fake/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("feeds module agentTools into the agent tool registry (the permission boundary)", () => {
    mountModules(mkApp(), [fakeModule]);
    expect(getTool("fakeModuleTool")).toBeTruthy();
  });

  it("mounts the skills catalogue through its module, behind the module's write gate", () => {
    const app = mkApp();
    mountModules(app, MODULES.filter((m) => m.id === "skills"), { moduleImported: async () => true });
    const paths = app.routes.map((r) => r.path);
    expect(paths).toContain("/api/skills");
    expect(paths).toContain("/api/skills/:id/skill.md");
    expect(MODULES.find((m) => m.id === "skills")?.routePrefixes).toEqual(["/api/skills"]);
  });

  it("rejects duplicate module ids at startup", () => {
    expect(() => mountModules(mkApp(), [
      { id: "dup", registerRoutes: () => {} },
      { id: "dup", registerRoutes: () => {} },
    ])).toThrow(/duplicate module id/);
  });

  it("the review module is registered and routes under /api/review", async () => {
    expect(MODULES.some((m) => m.id === "review")).toBe(true);
    const app = mkApp();
    mountModules(app, MODULES, { moduleImported: async () => true });
    // Assert via a real handler response: the grade route validates the body
    // BEFORE touching the DB, so a malformed rating answers 400 from the
    // module's own code — proof the router is mounted, without Postgres.
    const res = await app.request("/api/review/00000000-0000-4000-8000-000000000001/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 9 }),
    });
    expect(res.status).toBe(400); // the module's validator answered — it's live
  });

  it("review ships exactly one read-only agent tool (reviewQueue; humans grade)", () => {
    const review = MODULES.find((m) => m.id === "review")!;
    expect((review.agentTools ?? []).map((t) => t.name)).toEqual(["reviewQueue"]);
    // mounting the live MODULES feeds it into the registry = the permission boundary
    mountModules(mkApp(), MODULES);
    expect(getTool("reviewQueue")).toBeTruthy();
    // no GRADE tool: the agent assists, the human grades (schedule = human memory)
    expect((review.agentTools ?? []).some((t) => /grade/i.test(t.name))).toBe(false);
  });

  it("the rss module is registered and routes under /api/rss", async () => {
    expect(MODULES.some((m) => m.id === "rss")).toBe(true);
    const app = mkApp();
    mountModules(app, MODULES, { moduleImported: async () => true });
    // The subscribe route validates the body BEFORE touching the DB, so a
    // malformed payload answers 400 from the module's own zod schema (via the
    // error boundary) — proof
    // the router is mounted, without Postgres.
    const res = await app.request("/api/rss/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("a write under a removed module's routes answers 409 before its handler runs", async () => {
    const app = mkApp();
    mountModules(app, MODULES, { moduleImported: async () => false });
    const res = await app.request("/api/rss/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "module_not_imported", module: "rss" });
  });

  it("rss deliberately ships NO agent tools (the feed actor is internal, not an MCP grant)", () => {
    const rss = MODULES.find((m) => m.id === "rss")!;
    expect(rss.agentTools ?? []).toHaveLength(0);
  });

  it("startModuleBackground is a registry concern, not a mount side effect", async () => {
    // mountModules must NOT start timers (vitest would leak intervals); the
    // background seam is the separate startModuleBackground() call the server
    // bootstrap owns.
    let started = 0;
    const mod: ModuleDefinition = {
      id: "bg-probe",
      registerRoutes: () => {},
      startBackground: () => { started++; },
    };
    mountModules(mkApp(), [mod]);
    expect(started).toBe(0);
    const { startModuleBackground } = await import("../modules/index.js");
    startModuleBackground([mod]);
    expect(started).toBe(1);
  });
});
