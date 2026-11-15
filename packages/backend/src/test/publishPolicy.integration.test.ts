// The public-site gate is the SPACE (docs/architecture/spaces.md): a note is
// publishable iff its space's `publish` switch is on (plus its own _published
// opt-in), never a tag or schema. CHOKEPOINT: readPolicy.publiclyReadableNodeIds
// derives it, so every public surface — snapshot builder, serve-time allowlist,
// draft fallback — applies the SAME rule. This pins it end to end, including a
// published CHILD of a note in a publish-off space (the child shares its
// parent's space).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
// The native System actor has no personal space and may sit in several
// spaces, so a top-level note names its space (services/spaces.ts newNoteSpace).
async function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json: rawJson, ...rest } = init;
  const json = path === "/api/nodes" && rest.method === "POST" && rawJson && typeof rawJson === "object"
    && !("space_id" in rawJson)
    ? { ...rawJson, space_id: (await q<{ id: string }>(
        `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [await getWorkspaceId()])).rows[0]!.id }
    : rawJson;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

async function siteHas(id: string): Promise<boolean> {
  const site = (await (await req("/api/site")).json()) as { payload?: { nodes?: Array<{ id: string }> } };
  return (site.payload?.nodes ?? []).some((n) => n.id === id);
}

describe.skipIf(!isTestDb)("publish gate = space publish switch", () => {
  const stamp = Date.now();
  let reviewish = "", locked = "", privateSpace = "", publicSpace = "";
  // A published note carrying a fresh tag.
  const mk = async (title: string, tagJson: Record<string, unknown>) => {
    const tag = (await (await req("/api/tags/import", { method: "POST", json: tagJson })).json()) as { id: string };
    const node = (await (await req("/api/nodes", { method: "POST", json: { title, markdown: "body" } })).json()) as { id: string };
    await req(`/api/nodes/${node.id}/tags/${tag.id}`, { method: "PUT", json: {} });
    await req(`/api/nodes/${node.id}/attributes/_published`, { method: "PUT", json: { value: "true", value_type: "bool" } });
    // A space of its own that publishes: the shared workspace's default space does not (migration 186).
    await putInSpace(node.id, publicSpace);
    return node.id;
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const ws = await getWorkspaceId();
    await turnModuleOn(ws, "website"); // publishing is refused while the website is off (modules/website/index.ts)
    // A shared space whose publish switch is off (the makeSpace default), and one whose switch is on.
    privateSpace = await makeSpace(ws, `pb private ${stamp}`, []);
    publicSpace = await makeSpace(ws, `pb public ${stamp}`, [], { publish: true, external_ai: true, backup: true });
    reviewish = await mk(`pb review ${stamp}`, { name: `pbrev${stamp}`, fields: [{ name: "interval", type: "number" }] });
    locked = await mk(`pb locked ${stamp}`, { name: `pblock${stamp}`, fields: [] });
    await putInSpace(locked, privateSpace);
    expect((await publishWithPreview((p, b) => req(p, { method: "POST", json: b }))).status).toBe(201);
  });

  it("a schema tag does not block publishing; a publish-off space stays private (snapshot + serve)", async () => {
    expect(await siteHas(reviewish), "schema-only tag must NOT block publishing").toBe(true);
    expect(await siteHas(locked), "a publish-off space keeps the node off the public site").toBe(false);
  });

  it("moving a published node into a publish-off space pulls it on the next read", async () => {
    // Its own note: the first test expects reviewish on the site.
    const moved = await mk(`pb moved ${stamp}`, { name: `pbmove${stamp}`, fields: [{ name: "interval", type: "number" }] });
    expect((await publishWithPreview((p, b) => req(p, { method: "POST", json: b }))).status).toBe(201);
    expect(await siteHas(moved)).toBe(true);
    await putInSpace(moved, privateSpace);
    expect(await siteHas(moved), "serve-time allowlist re-evaluates").toBe(false);
  });

  // A _published CHILD shares its parent's space, so a parent in a
  // publish-off space keeps the child off the site.
  it("a _published CHILD of a note in a publish-off space is ABSENT from /api/site", async () => {
    const parent = (await (await req("/api/nodes", { method: "POST", json: { title: `pb parent ${stamp}`, markdown: "parent" } })).json()) as { id: string };
    const child = (await (await req("/api/nodes", { method: "POST", json: { title: `pb child ${stamp}`, markdown: "child body", parent_id: parent.id } })).json()) as { id: string };
    await req(`/api/nodes/${child.id}/attributes/_published`, { method: "PUT", json: { value: "true", value_type: "bool" } });
    await putInSpace(parent.id, privateSpace);
    expect((await publishWithPreview((p, b) => req(p, { method: "POST", json: b }))).status).toBe(201);
    expect(await siteHas(child.id), "child lives in its parent's publish-off space — must not be public").toBe(false);
  });
});
