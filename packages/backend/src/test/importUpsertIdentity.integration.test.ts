// Obsidian re-import resolves the upsert target by a STABLE per-file identity
// (the vault path), not the slug. Two bugs this pins:
//   H3 — two files whose titles slugify the same must become TWO nodes, not
//        collapse onto one (last-writer-wins data loss).
//   H2 — re-importing a vault must UPDATE each note in place by its path, even
//        when its slug was uniqueness-suffixed (my-note-2), not fork it.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
function importVault(files: Array<{ path: string; content: string }>, upsert: boolean): Promise<Response> {
  return Promise.resolve(
    app.request("/api/import/obsidian", {
      method: "POST",
      headers: { ...NATIVE, "content-type": "application/json" },
      body: JSON.stringify({ source: { id:"legacy",name:"Older imports" }, files, upsert }),
    }),
  );
}

// A unique title and paths per test (beforeEach) so the same-slugified-title
// pair collides with nothing else in the shared database, nor with the other
// test's import.
let STAMP = "";
let TITLE = ""; // both files use this exact title → same baseSlug

describe.skipIf(!isTestDb)("import upsert resolves by stable path identity (H2/H3)", () => {
  let WS = "";
  let pathA = "", pathB = "";
  const body = (content: string) => `---\ntitle: ${TITLE}\n---\n${content}`;

  const nodeByPath = (path: string) =>
    q<{ id: string; markdown: string; title: string }>(
      `SELECT n.id, n.markdown, n.title FROM content_nodes n
         JOIN node_attributes a ON a.node_id = n.id AND a.key = '_import_path' AND a.value = $2
        WHERE n.workspace_id = $1 AND n.deleted_at IS NULL`,
      [WS, path],
    );

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });
  beforeEach(() => {
    STAMP = `uid${randomUUID().slice(0, 8)}`;
    TITLE = `Dup ${STAMP}`;
    pathA = `${STAMP}/a.md`;
    pathB = `${STAMP}/b.md`;
  });

  it("two files with the same slugified title import as TWO distinct nodes (H3 — no collapse)", async () => {
    const res = await importVault(
      [{ path: pathA, content: body("alpha-content") }, { path: pathB, content: body("beta-content") }],
      true, // upsert on — the bug collapsed the 2nd onto the 1st under upsert
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as { imported: number };
    expect(r.imported).toBe(2);

    // Both files produced their own node, each carrying its OWN body.
    const a = (await nodeByPath(pathA)).rows;
    const b = (await nodeByPath(pathB)).rows;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(a[0]!.markdown).toContain("alpha-content");
    expect(b[0]!.markdown).toContain("beta-content");

    // Exactly two live nodes with this title — not one (collapse) or three (fork).
    const count = await q<{ n: string }>(
      `SELECT count(*) AS n FROM content_nodes WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL`,
      [WS, TITLE],
    );
    expect(count.rows[0]!.n).toBe("2");
  });

  it("re-importing the same vault UPDATES each note in place by path, never forks (H2)", async () => {
    expect((await importVault(
      [{ path: pathA, content: body("alpha-content") }, { path: pathB, content: body("beta-content") }], true,
    )).status).toBe(200);
    const aId = (await nodeByPath(pathA)).rows[0]!.id;
    const bId = (await nodeByPath(pathB)).rows[0]!.id;

    const res = await importVault(
      [{ path: pathA, content: body("alpha-v2") }, { path: pathB, content: body("beta-v2") }],
      true,
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as { imported: number; updated: number };
    expect(r.imported).toBe(0); // nothing forked
    expect(r.updated).toBe(2); // both updated in place

    // SAME node ids, each updated with its OWN new content (no cross-clobber).
    const a = (await nodeByPath(pathA)).rows;
    const b = (await nodeByPath(pathB)).rows;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).toBe(aId);
    expect(b[0]!.id).toBe(bId);
    expect(a[0]!.markdown).toContain("alpha-v2");
    expect(b[0]!.markdown).toContain("beta-v2");

    // Still exactly two live nodes — the re-import was a pull, not a fork.
    const count = await q<{ n: string }>(
      `SELECT count(*) AS n FROM content_nodes WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL`,
      [WS, TITLE],
    );
    expect(count.rows[0]!.n).toBe("2");
  });
});
