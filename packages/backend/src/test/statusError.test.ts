// Core maps a module's refusal through the StatusError base, not by naming the
// module's class (importCycles.test.ts keeps core from importing modules/).
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { ReviewError } from "../modules/review/index.js";
import { StatusError } from "../statusError.js";

describe("StatusError at the HTTP boundary", () => {
  const app = new Hono();
  app.onError(apiOnError);
  app.get("/review", () => { throw new ReviewError(409, "nothing to undo"); });
  app.get("/plain", () => { throw new StatusError(404, "not here"); });

  it("ReviewError is a StatusError and answers { error } with its status", async () => {
    expect(new ReviewError(404, "x")).toBeInstanceOf(StatusError);
    const res = await app.request("/review");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nothing to undo" });
  });

  it("a plain StatusError maps the same way", async () => {
    const res = await app.request("/plain");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not here" });
  });
});
