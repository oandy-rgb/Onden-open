import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildHeader } from "../buildHeader.js";

function appWith(id: string | undefined) {
  const app = new Hono();
  const middleware = buildHeader(id);
  if (middleware) app.use("*", middleware);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/boom", () => { throw new Error("boom"); });
  app.onError((_e, c) => c.json({ error: "x" }, 500));
  return app;
}

describe("X-Onden-Build", () => {
  it("is on every response of a server that knows its build, errors included", async () => {
    const app = appWith(" abc123 ");
    expect((await app.request("/ok")).headers.get("X-Onden-Build")).toBe("abc123");
    const failed = await app.request("/boom");
    expect(failed.status).toBe(500);
    expect(failed.headers.get("X-Onden-Build")).toBe("abc123");
  });

  it("is absent when the build is unknown, so no client is told it is old", async () => {
    for (const id of [undefined, "", "  "]) {
      expect((await appWith(id).request("/ok")).headers.get("X-Onden-Build")).toBeNull();
    }
  });
});
