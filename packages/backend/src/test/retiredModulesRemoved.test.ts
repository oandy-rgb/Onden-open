// Read-later (migration 192) and citations (193) were removed: no module, no route, and nothing may bring their markers back.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { MODULES, mountModules } from "../modules/index.js";
import type { ModuleApp } from "../modules/types.js";
import { withoutRetiredModules } from "../services/tagWrites.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

describe("read-later is gone", () => {
  it("is not a shipped module and its routes answer 404", async () => {
    expect(MODULES.map((m) => m.id)).not.toContain("read_later");
    const app = new Hono() as unknown as ModuleApp;
    mountModules(app, MODULES);
    expect((await app.request("/api/read-later/done")).status).toBe(404);
    expect((await app.request("/api/read-later/00000000-0000-4000-8000-000000000000/done", { method: "PUT" })).status).toBe(404);
  });

  it("citations, retired by migration 193, is dropped the same way", () => {
    const old = { name: "x", module: "citations", behaviour: { modules: { citations: { enabled: true }, review: { enabled: true } } } };
    expect(withoutRetiredModules(old)).toEqual({ name: "x", behaviour: { modules: { review: { enabled: true } } } });
  });

  it("the view module marks, removed by migration 196, are dropped the same way", () => {
    registerShippedModules();
    for (const layout of ["table", "kanban", "calendar", "gallery"]) {
      const old = { name: "x", module: layout, behaviour: { modules: { [layout]: { enabled: true }, review: { enabled: true } } } };
      expect(withoutRetiredModules(old), layout).toEqual({ name: "x", behaviour: { modules: { review: { enabled: true } } } });
    }
  });

  it("a schema from an old backup or pack loses the read-later marker and switch, and nothing else", () => {
    const old = { name: "x", module: "read_later", behaviour: { review: { new_per_day: 3 }, modules: { read_later: { enabled: true }, review: { enabled: true } } } };
    expect(withoutRetiredModules(old)).toEqual({ name: "x", behaviour: { review: { new_per_day: 3 }, modules: { review: { enabled: true } } } });
    const current = { name: "y", module: "review" };
    expect(withoutRetiredModules(current)).toBe(current);
  });
});
