// CSV import: duplicate header columns must each survive as their own field,
// not silently overwrite each other (L2). The import turns a CSV into a
// collection; the old one-node-per-row path (deepCsv:false) is gone (W9).
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

describe.skipIf(!isTestDb)("CSV import uniquifies duplicate headers (L2)", () => {
  let WS = "";
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("two columns sharing a header both land (status + status 2), not last-wins", async () => {
    const title = `Alpha ${stamp}`;
    const csv = `Name,status,status\n${title},open,closed\n`;
    const res = await req("/api/import/obsidian", {
      method: "POST",
      json: { files: [{ path: `dup-${stamp}.csv`, content: csv }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ collections_imported: 1, collection_rows_imported: 1 });

    const node = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL`,
      [WS, title],
    )).rows[0];
    expect(node, "row node created").toBeTruthy();
    const attrs = await q<{ key: string; value: string }>(
      `SELECT key, value FROM node_attributes WHERE node_id=$1`, [node!.id],
    );
    const map = Object.fromEntries(attrs.rows.map((r) => [r.key, r.value]));
    expect(map["status"]).toBe("open");        // first column preserved
    expect(map["status 2"]).toBe("closed");    // second column kept, not lost
  });
});
