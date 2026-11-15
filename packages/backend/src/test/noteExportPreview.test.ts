import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const calls = vi.hoisted(() => ({ canRead: vi.fn(), query: vi.fn(), theme: vi.fn(), event: vi.fn() }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), pool: { query: calls.query }, q: calls.query, getWorkspaceId: async () => "workspace", event: calls.event }));
vi.mock("../services/readPolicy.js", async original => ({ ...await original<typeof import("../services/readPolicy.js")>(), canReadNode: calls.canRead }));
vi.mock("../modules/website/publishing/publishedSet.js", async original => ({ ...await original<typeof import("../modules/website/publishing/publishedSet.js")>(), overlaySiteConfig: calls.theme }));
import nodes from "../routes/nodes.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
registerShippedModules();
const actor = { actorId: "reader", actorType: "human", role: "viewer" } as unknown as ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/nodes", nodes);
const noteId = "a8eb1029-74b6-4a4a-ad7b-97edd847a9a9";
const request = (body: unknown) => app.request(`/api/nodes/${noteId}/export-preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// The only database read is the served site, which the export's [[links]]
// point at (D42); a workspace never published serves no pages.
// rowCount: the typed query builder (takenDown.ts) reads it
beforeEach(() => { vi.clearAllMocks(); calls.canRead.mockResolvedValue(true); calls.theme.mockResolvedValue({ tokens: {} }); calls.query.mockResolvedValue({ rows: [], rowCount: 0 }); });
const onlyReads = () => calls.query.mock.calls.every(([sql]) => /^\s*SELECT\b/i.test(String(sql)));

it("renders supplied text with existing theme/sanitization without updating the note or events", async () => {
  const res = await request({ title: "中文 <script>x</script>", markdown: "## 當下草稿\n\n**文字**\n\n<script>alert(1)</script><img src=x onerror=alert(1)>" });
  expect(res.status).toBe(200); expect(res.headers.get("Cache-Control")).toBe("no-store");
  const { html } = await res.json();
  expect(html).toContain("當下草稿"); expect(html).toContain("<strong>文字</strong>");
  expect(html).toContain("script-src 'none'"); expect(html).not.toContain("<script>"); expect(html).not.toMatch(/<img[^>]*onerror/);
  // Exports follow the site (W38c): a note's inline HTML stays visible text.
  expect(html).toContain("&#x3C;img src=x onerror=alert(1)>");
  expect(calls.canRead).toHaveBeenCalledWith(actor, noteId);
  expect(onlyReads()).toBe(true); expect(calls.event).not.toHaveBeenCalled();
});

it("keeps an empty body empty and accepts an untitled draft", async () => {
  const res = await request({ title: "", markdown: "" });
  expect(res.status).toBe(200); expect((await res.json()).html).toContain("Untitled");
});

it("refuses denied reads before loading theme or processing text", async () => {
  calls.canRead.mockResolvedValue(false);
  const res = await request({ title: "draft", markdown: "text" });
  expect(res.status).toBe(404); expect(calls.theme).not.toHaveBeenCalled(); expect(calls.query).not.toHaveBeenCalled();
});

it.each([{ title: "missing body" }, { title: 7, markdown: "x" }, { title: "x", markdown: "x", published: true }, { title: "x", markdown: "x", format: "pdf" }])("rejects invalid input via the shared HTTP boundary", async input => {
  expect((await request(input)).status).toBe(400); expect(calls.theme).not.toHaveBeenCalled();
});

it("rejects a malformed node ID without reaching a UUID database lookup", async () => {
  const res = await app.request("/api/nodes/not-a-uuid/export-preview", { method: "POST", body: "{}" });
  expect(res.status).toBe(400); expect(calls.canRead).not.toHaveBeenCalled(); expect(calls.theme).not.toHaveBeenCalled();
});

it("answers a trashed or missing note's Markdown file as not found", async () => {
  calls.query.mockResolvedValue({ rows: [], rowCount: 0 }); // rowCount: the typed query builder (takenDown.ts) reads it
  const res = await request({ title: "draft", markdown: "text", format: "markdown" });
  expect(res.status).toBe(404); expect(calls.theme).not.toHaveBeenCalled();
});
