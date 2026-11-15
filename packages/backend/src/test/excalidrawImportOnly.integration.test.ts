// Migration 110: imported Excalidraw drawings keep only what they were
// converted to — the original file, the plugin's frontmatter keys (lines and
// attributes) and its #excalidraw tag go; the person's own frontmatter, the
// note body and the drawing (ink_data) stay. Repeatable.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pool, q, getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const SQL = readFileSync(fileURLToPath(new URL("../../db/migrations/110_excalidraw_import_only.sql", import.meta.url)), "utf8");

describe.skipIf(!isTestDb)("migration 110: Excalidraw imports keep only the conversion (DB)", () => {
  let WS = "";
  const stamp = randomUUID().slice(0, 8);

  async function note(title: string, markdown: string, attrs: Record<string, string>): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, title, slug, markdown, node_type, source_type)
       VALUES ($1, $2, $3, $4, 'content', 'manual') RETURNING id`, [WS, title, `m110-${stamp}-${randomUUID().slice(0, 6)}`, markdown])).rows[0]!.id;
    for (const [key, value] of Object.entries(attrs)) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, $3, $4)`, [WS, id, key, value]);
    }
    return id;
  }
  const body = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  const keys = async (id: string) => (await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1 ORDER BY key`, [id])).rows.map((r) => r.key);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("removes the original, the plugin's keys and tag; keeps everything else", async () => {
    const drawing = await note(`Drawing ${stamp}`,
      `---\nexcalidraw-plugin: parsed\nexcalidraw-css: |\n  a { }\n  b { }\naliases: ["x.excalidraw"]\nexcalidraw-export-dark: false\n---\nA caption.\nexcalidraw-plugin: this line is body text\n`,
      { _import_excalidraw: "```compressed-json\nAAAA\n```", "excalidraw-plugin": "parsed", "excalidraw-export-dark": "false", ink_data: "{\"strokes\":[]}", aliases: "x.excalidraw" });
    const plain = await note(`Plain ${stamp}`, "---\ntitle: mine\n---\nno drawing\n", { title: "mine" });
    // The plugin's tag (a fresh workspace may have none: make one), with a member.
    const tag = (await seedQ<{ id: string }>(`SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND lower(title) = 'excalidraw' AND parent_id IS NULL AND deleted_at IS NULL`, [WS])).rows[0]?.id
      ?? (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, title, slug, node_type, source_type) VALUES ($1, 'excalidraw', $2, 'class_tag', 'manual') RETURNING id`, [WS, `excalidraw-${stamp}`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [drawing, tag]);

    const client = await pool.connect();
    try { await client.query(SQL); await client.query(SQL); } finally { client.release(); } // repeatable

    expect(await body(drawing)).toBe(`---\naliases: ["x.excalidraw"]\n---\nA caption.\nexcalidraw-plugin: this line is body text\n`);
    expect(await keys(drawing)).toEqual(["aliases", "ink_data"]);
    expect(await body(plain)).toBe("---\ntitle: mine\n---\nno drawing\n");
    expect(await keys(plain)).toEqual(["title"]);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [tag])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1`, [drawing])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [drawing])).rowCount).toBe(1);
  });
});
