// A write that breaks migration 215's anchor checks (SQLSTATE OD215: anchor_hash_not_body / anchor_unit_not_rows) is a fault of the writer and stays a 500; one log
// line names the note (the error's DETAIL) and the route, so it can be found (review of PR #1853, round 5, point 2). No database: the error is the one pg raises.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOnError } from "../httpError.js";

afterEach(() => { vi.restoreAllMocks(); });

const NOTE = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const pgError = (code: string, hint: string) => Object.assign(new Error("an anchor of note … was written with the hash of another body than the note's"), { code, hint, detail: NOTE });

describe("an OD215 fault on a route", () => {
  it("answers 500 and logs one line with the check, the note and the route", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const app = new Hono();
    app.onError(apiOnError);
    app.post("/api/agent-sessions/:id", () => { throw pgError("OD215", "anchor_hash_not_body"); });
    const res = await app.request("/api/agent-sessions/abc", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    const named = lines.filter((l) => l.includes("anchor_hash_not_body"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(NOTE);
    expect(named[0]).toContain("POST /api/agent-sessions/:id");
  });

  it("another database error is not named as an anchors fault", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const app = new Hono();
    app.onError(apiOnError);
    app.get("/x", () => { throw pgError("23514", "anchor_hash_not_body"); });
    expect((await app.request("/x")).status).toBe(500);
    expect(lines.filter((l) => l.includes("[anchors]") || l.includes("\"anchors\""))).toEqual([]);
  });
});
