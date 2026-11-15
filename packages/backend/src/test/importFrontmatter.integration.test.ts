// Obsidian import maps the FULL frontmatter block (aliases, status, tags, and
// arbitrary custom keys) into node_attributes — the same surface the normal
// create/update paths use via syncFrontmatterAttributes. Previously import only
// pulled `title` and silently discarded everything else (aliases, tags, …).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { nativeOwnerActor } from "./helpers/persistActor.js";

// A workspace of its own (the app reads it through getWorkspaceId): the
// imports use fixed titles, paths and slugs that must meet no other data.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

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

// Native-origin admin bypass — same path the bootstrap tests use to act as the
// workspace owner without a real session.
const NATIVE = { origin: "http://localhost" };

function req(path: string, json: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { ...NATIVE, "content-type": "application/json" },
      body: JSON.stringify(json),
    }),
  );
}

describe.skipIf(!isTestDb)("import maps frontmatter attributes (aliases & co.)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Frontmatter import', $1) RETURNING id`, [`fm-${randomUUID()}`])).rows[0]!.id;
    // The native bypass acts as the workspace's System actor.
    await nativeOwnerActor(WS);
  });

  const attrsOf = (nodeId: string) =>
    q<{ key: string; value: string; source: string }>(
      `SELECT key, value, source FROM node_attributes WHERE node_id = $1 ORDER BY key`,
      [nodeId],
    );

  it("on create, persists aliases + custom keys as frontmatter attributes", async () => {
    const content = [
      "---",
      "title: FM Note",
      "aliases: [Foo, Bar Baz]",
      "status: doing",
      "tags:",
      "  - alpha",
      "  - beta",
      "---",
      "Body text.",
    ].join("\n");

    const res = await req("/api/import/obsidian", { files: [{ path: "FM Note.md", content }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number };
    expect(body.imported).toBe(1);

    const node = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'FM Note' AND deleted_at IS NULL`,
      [WS],
    )).rows[0];
    expect(node).toBeTruthy();

    const attrs = new Map((await attrsOf(node!.id)).rows.map((r) => [r.key, r]));
    // aliases — the headline of the bug — round-trips as a JSON array string.
    expect(attrs.get("aliases")?.value).toBe('["Foo","Bar Baz"]');
    expect(attrs.get("aliases")?.source).toBe("frontmatter");
    // arbitrary scalar key is preserved too.
    expect(attrs.get("status")?.value).toBe("doing");
    // tags and title become the note's tags and title, not attributes (a copy
    // as an attribute would drift from the real tags; @onden/markdown frontmatter.ts).
    expect(attrs.has("tags")).toBe(false);
    expect(attrs.has("title")).toBe(false);
  });

  it("on upsert update, re-syncs changed frontmatter attributes", async () => {
    const v1 = ["---", "title: FM Note Upd", "aliases: [One]", "---", "v1"].join("\n");
    const r1 = await req("/api/import/obsidian", { files: [{ path: "FM Note Upd.md", content: v1 }], source: { id:"legacy",name:"Older imports" }, upsert: true });
    expect(r1.status).toBe(200);

    const node = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'FM Note Upd' AND deleted_at IS NULL`,
      [WS],
    )).rows[0]!;
    expect((await attrsOf(node.id)).rows.find((r) => r.key === "aliases")?.value).toBe('["One"]');

    const v2 = ["---", "title: FM Note Upd", "aliases: [One, Two]", "---", "v2 body"].join("\n");
    const r2 = await req("/api/import/obsidian", { files: [{ path: "FM Note Upd.md", content: v2 }], source: { id:"legacy",name:"Older imports" }, upsert: true });
    expect(r2.status).toBe(200);
    const r2body = (await r2.json()) as { updated: number };
    expect(r2body.updated).toBe(1);

    expect((await attrsOf(node.id)).rows.find((r) => r.key === "aliases")?.value).toBe('["One","Two"]');
  });

  it("on upsert update, a changed title moves the slug as an edit does, and the update can be undone", async () => {
    const source = { id: "legacy", name: "Older imports" };
    const file = (title: string, body: string) => ({ path: "FM Rename.md", content: ["---", `title: ${title}`, "---", body].join("\n") });
    expect((await req("/api/import/obsidian", { files: [file("FM Rename Before", "v1")], source, upsert: true })).status).toBe(200);
    const before = (await q<{ id: string; slug: string }>(
      `SELECT id, slug FROM content_nodes WHERE workspace_id = $1 AND title = 'FM Rename Before' AND deleted_at IS NULL`, [WS],
    )).rows[0]!;
    expect(before.slug).toBe("fm-rename-before");

    const r2 = await req("/api/import/obsidian", { files: [file("FM Rename After", "v2")], source, upsert: true });
    expect(((await r2.json()) as { updated: number }).updated).toBe(1);
    const after = (await q<{ title: string; slug: string; markdown: string }>(
      `SELECT title, slug, markdown FROM content_nodes WHERE id = $1`, [before.id],
    )).rows[0]!;
    expect(after).toEqual({ title: "FM Rename After", slug: "fm-rename-after", markdown: "v2" });
    const ev = (await q<{ event_type: string; ui: string; prev: Record<string, unknown> }>(
      `SELECT event_type, tx_meta->>'ui_context' AS ui, tx_meta->'prev_field_values' AS prev
         FROM domain_events WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [before.id],
    )).rows[0]!;
    expect(ev).toEqual({ event_type: "NODE_UPDATED", ui: "import.obsidian.update", prev: { title: "FM Rename Before" } });
  });
});
