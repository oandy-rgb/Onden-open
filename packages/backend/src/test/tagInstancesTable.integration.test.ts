// Tag-page instances table (Tana supertag-page): opening a #tag must lead with
// WHAT CARRIES IT — a live table of tagged notes with the schema's field columns
// and their values. SchemaLens.instances reads exactly two things off each
// node: `class_tag_ids` (membership filter) and `attrs[fieldName]` (the cell
// values). This suite pins the backend contract those reads depend on for the
// PRODUCTIVE path the UI actually uses:
//
//   1. tag is born schema-less via resolve-path (typing #foo on a note)
//   2. it later GAINS a schema via PATCH /schema (the SchemaLens "Fields" save)
//   3. it is applied to a node via PUT /nodes/:id/tags/:tagId
//   4. a schema field gets a value via PUT /nodes/:id/attributes/:key
//
// The regression guarded here: `class_tag_ids` is derived with a
// `tag_schema_id IS NOT NULL` predicate, so a tag applied BEFORE it had a
// schema must STILL surface in the instances table once the schema is added —
// the derivation is live (a join), not frozen at apply time. Without that, the
// headline tag page would silently drop notes tagged before the schema existed.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { randomUUID } from "node:crypto";
import { nativeOwnerActor } from "./helpers/persistActor.js";

// A workspace of its own: the full-body /api/bootstrap caps at 5000 notes,
// oldest first, so in a shared workspace holding other tests' notes this
// file's notes could fall past the cap.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

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

type BootNode = { id: string; class_tag_ids?: string[]; attrs?: Record<string, string> };
type Boot = { nodes: BootNode[]; tags: Array<{ id: string }> };

describe.skipIf(!isTestDb)("tag page instances table — schema-field columns over PUT-applied tags", () => {
  const stamp = Date.now();
  let tagId = "", appliedFirst = "", appliedAfter = "";

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`tag-instances-${randomUUID()}`])).rows[0]!.id;
    // Native requests act as the workspace's System actor (index.ts).
    await nativeOwnerActor(ownWorkspace);
    await getWorkspaceId();

    // 1. Born schema-less, the way the UI mints a tag (#foo on a note).
    tagId = ((await (await req("/api/tags/resolve-path", { method: "POST", json: { path: `book${stamp}` } })).json()) as { leaf_id: string }).leaf_id;

    // 2. Apply it to a note BEFORE the schema exists — this is the node the
    //    `tag_schema_id IS NOT NULL` predicate would wrongly drop if the
    //    derivation were frozen at apply time.
    appliedFirst = ((await (await req("/api/nodes", { method: "POST", json: { title: `early ${stamp}`, markdown: "x" } })).json()) as { id: string }).id;
    await req(`/api/nodes/${appliedFirst}/tags/${tagId}`, { method: "PUT", json: {} });

    // 3. Now give the tag a schema via the SchemaLens save path. This links a
    //    collection_schemas row and sets content_nodes.tag_schema_id.
    const patched = await req(`/api/tags/${tagId}/schema`, { method: "PATCH", json: {
      fields: [{ name: "author", type: "text" }, { name: "rating", type: "number" }],
    } });
    expect(patched.status).toBeLessThan(300);

    // 4. Apply to a second note AFTER the schema exists, and give both notes a
    //    field value the instances table must render in its columns.
    appliedAfter = ((await (await req("/api/nodes", { method: "POST", json: { title: `late ${stamp}`, markdown: "x" } })).json()) as { id: string }).id;
    await req(`/api/nodes/${appliedAfter}/tags/${tagId}`, { method: "PUT", json: {} });
    await req(`/api/nodes/${appliedFirst}/attributes/author`, { method: "PUT", json: { value: "Le Guin" } });
    await req(`/api/nodes/${appliedAfter}/attributes/author`, { method: "PUT", json: { value: "Borges" } });
    await req(`/api/nodes/${appliedAfter}/attributes/rating`, { method: "PUT", json: { value: "5", value_type: "number" } });
  });

  it("the tag now carries a schema_id (PATCH /schema linked one)", async () => {
    const tags = (await (await req("/api/tags")).json()) as Array<{ id: string; schema_id: string | null; schema_fields?: Array<{ name: string }> }>;
    const tag = tags.find((t) => t.id === tagId)!;
    expect(tag.schema_id).toBeTruthy();
    expect((tag.schema_fields ?? []).map((f) => f.name)).toEqual(["author", "rating"]);
  });

  it("bootstrap class_tag_ids includes BOTH notes — even the one tagged before the schema existed", async () => {
    const boot = (await (await req("/api/bootstrap")).json()) as Boot;
    const early = boot.nodes.find((n) => n.id === appliedFirst)!;
    const late = boot.nodes.find((n) => n.id === appliedAfter)!;
    // This is the headline guarantee: the instances filter (n.class_tag_ids
    // includes tag.id) catches a node tagged via PUT before the schema landed.
    expect(early.class_tag_ids).toContain(tagId);
    expect(late.class_tag_ids).toContain(tagId);
  });

  it("each instance row carries its schema-field values under attrs[fieldName] — the table cells", async () => {
    const boot = (await (await req("/api/bootstrap")).json()) as Boot;
    const early = boot.nodes.find((n) => n.id === appliedFirst)!;
    const late = boot.nodes.find((n) => n.id === appliedAfter)!;
    // SchemaLens renders <td>{ (n.attrs ?? {})[f.name] }</td> — the values must
    // be keyed by the field's `name` for the columns to show anything.
    expect(early.attrs?.author).toBe("Le Guin");
    expect(late.attrs?.author).toBe("Borges");
    expect(late.attrs?.rating).toBe("5");
  });

  it("GET /nodes/:id returns the SAME enriched shape (lazy-body door used after a PUT apply)", async () => {
    // The frontend swaps a single fetched node into the store verbatim after a
    // mutation; its class_tag_ids + attrs must match bootstrap so the instances
    // table stays correct without a full reload.
    const one = (await (await req(`/api/nodes/${appliedAfter}`)).json()) as BootNode;
    expect(one.class_tag_ids).toContain(tagId);
    expect(one.attrs?.author).toBe("Borges");
    expect(one.attrs?.rating).toBe("5");
  });
});
