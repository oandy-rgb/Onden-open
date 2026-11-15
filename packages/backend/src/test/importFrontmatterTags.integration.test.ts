// Regression: Markdown import (POST /api/import/obsidian) MUST wire YAML
// frontmatter `tags` into the real tag create/attach path — both the inline
// list form (`tags: [a, b]`) and the block-list form. Before the fix the
// frontmatter was parsed but tags were dropped on the floor.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";

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
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

async function tagIdsForNodeTitle(workspaceId: string, title: string): Promise<string[]> {
  const res = await q<{ tag_id: string }>(
    `SELECT nt.tag_id FROM node_tags nt
       JOIN content_nodes n ON n.id = nt.node_id
      WHERE n.workspace_id = $1 AND n.title = $2 AND n.deleted_at IS NULL`,
    [workspaceId, title],
  );
  return res.rows.map((r) => r.tag_id);
}

async function tagNamesForNodeTitle(workspaceId: string, title: string): Promise<string[]> {
  const res = await q<{ name: string }>(
    `SELECT t.title AS name FROM node_tags nt
       JOIN content_nodes n ON n.id = nt.node_id
       JOIN content_nodes t ON t.id = nt.tag_id
      WHERE n.workspace_id = $1 AND n.title = $2 AND n.deleted_at IS NULL`,
    [workspaceId, title],
  );
  return res.rows.map((r) => r.name).sort();
}

describe.skipIf(!isTestDb)("import wires frontmatter tags", () => {
  let workspaceId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    workspaceId = await getWorkspaceId();
  });

  it("creates + attaches tags from an inline list (tags: [a, b])", async () => {
    const title = `fm-inline-${Date.now()}`;
    const content = `---\ntitle: ${title}\ntags: [alpha-${Date.now()}, beta-${Date.now()}]\n---\nbody text`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `${title}.md`, content }] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);

    const tagIds = await tagIdsForNodeTitle(workspaceId, title);
    expect(tagIds.length).toBe(2);
    // The attached rows must point at real class_tag content_nodes.
    const classTags = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes
        WHERE id = ANY($1::uuid[]) AND node_type = 'class_tag' AND deleted_at IS NULL`,
      [tagIds],
    );
    expect(Number(classTags.rows[0]!.n)).toBe(2);
  });

  it("creates + attaches tags from a block list (tags:\\n  - a\\n  - b)", async () => {
    const stamp = Date.now();
    const title = `fm-block-${stamp}`;
    const a = `gamma-${stamp}`;
    const b = `delta-${stamp}`;
    const content = `---\ntitle: ${title}\ntags:\n  - ${a}\n  - ${b}\n---\nbody`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `${title}.md`, content }] },
    });
    expect(res.status).toBe(200);

    const names = await tagNamesForNodeTitle(workspaceId, title);
    expect(names).toEqual([a, b].sort());
  });

  it("block list with an EMPTY entry still attaches the non-empty tags (L1)", async () => {
    const stamp = Date.now();
    const title = `fm-block-empty-${stamp}`;
    const a = `eps-${stamp}`;
    const b = `zeta-${stamp}`;
    // The middle entry is an empty dash — used to break the block match and drop
    // EVERY tag.
    const content = `---\ntitle: ${title}\ntags:\n  - ${a}\n  -\n  - ${b}\n---\nbody`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `${title}.md`, content }] },
    });
    expect(res.status).toBe(200);

    const names = await tagNamesForNodeTitle(workspaceId, title);
    expect(names).toEqual([a, b].sort()); // was [] without the fix
  });

  it("creates + attaches a single scalar tag (tags: foo)", async () => {
    const stamp = Date.now();
    const title = `fm-scalar-${stamp}`;
    const tag = `solo-${stamp}`;
    const content = `---\ntitle: ${title}\ntags: ${tag}\n---\nbody`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `${title}.md`, content }] },
    });
    expect(res.status).toBe(200);

    const names = await tagNamesForNodeTitle(workspaceId, title);
    expect(names).toEqual([tag]);
  });

  it("resolves a nested tag path into a parent→child chain", async () => {
    const stamp = Date.now();
    const title = `fm-nested-${stamp}`;
    const parent = `projects-${stamp}`;
    const child = `onden-${stamp}`;
    const content = `---\ntitle: ${title}\ntags: [${parent}/${child}]\n---\nbody`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `${title}.md`, content }] },
    });
    expect(res.status).toBe(200);

    const tagIds = await tagIdsForNodeTitle(workspaceId, title);
    expect(tagIds.length).toBe(1); // only the LEAF is attached
    const leaf = await q<{ name: string; parent_id: string | null }>(
      `SELECT title AS name, parent_id FROM content_nodes WHERE id = $1`,
      [tagIds[0]],
    );
    expect(leaf.rows[0]!.name).toBe(child);
    expect(leaf.rows[0]!.parent_id).not.toBeNull();
    const parentRow = await q<{ name: string }>(
      `SELECT title AS name FROM content_nodes WHERE id = $1`,
      [leaf.rows[0]!.parent_id],
    );
    expect(parentRow.rows[0]!.name).toBe(parent);
  });
});
