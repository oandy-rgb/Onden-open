// Cookie-authenticated writes and the MCP endpoint refuse a foreign Origin;
// bearer-token and Origin-less requests, and reads, are unaffected.

import { describe, it, expect, vi } from "vitest";

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

const ALLOWED = "http://localhost:4321"; // CORS_ORIGIN default under test
const send = async (path: string, init: { method?: string; origin?: string; bearer?: string; host?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.origin) headers.origin = init.origin;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.host) headers.host = init.host;
  const res = await app.request(path, { method: init.method ?? "POST", headers, body: init.method === "GET" ? undefined : "{}" });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
};
const refused = (r: { status: number; body: Record<string, unknown> }) => r.status === 403 && r.body.error === "origin_not_allowed";

describe("origin guard", () => {
  it("refuses a cookie write from a foreign origin", async () => {
    expect(refused(await send("/api/nodes", { origin: "https://evil.example" }))).toBe(true);
    expect(refused(await send("/api/nodes", { method: "DELETE", origin: "https://evil.example" }))).toBe(true);
  });

  it("refuses the MCP endpoint from a foreign origin, even for a read method", async () => {
    expect(refused(await send("/api/mcp/protocol", { origin: "https://evil.example" }))).toBe(true);
    expect(refused(await send("/api/mcp/protocol", { method: "GET", origin: "https://evil.example" }))).toBe(true);
  });

  it("lets the listed origin and this server's own host through", async () => {
    expect(refused(await send("/api/nodes", { origin: ALLOWED }))).toBe(false);
    expect(refused(await send("/api/nodes", { origin: "https://notes.example", host: "notes.example" }))).toBe(false);
  });

  it("leaves bearer-token requests, Origin-less requests and reads alone", async () => {
    expect(refused(await send("/api/mcp/protocol", { origin: "https://evil.example", bearer: "ondt_whatever" }))).toBe(false);
    expect(refused(await send("/api/nodes"))).toBe(false);
    expect(refused(await send("/api/nodes", { method: "GET", origin: "https://evil.example" }))).toBe(false);
  });

  it("does not take a lookalike host for the server's own", async () => {
    expect(refused(await send("/api/nodes", { origin: "https://notes.example.evil.example", host: "notes.example" }))).toBe(true);
  });
});
