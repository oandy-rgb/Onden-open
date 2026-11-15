// A Notion database row takes the page body that is its own: found by the page
// id, else by title inside the database's own folder, and only when that title
// names one row and one file. A page elsewhere that happens to share a title
// is never swallowed, and a body that can't be stored leaves its file for the
// loose-note import instead of dropping it.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("Notion row bodies are matched inside the database's folder", () => {
  let WS = "";
  let admin: ActorCtx = { id: "rowbodies-admin", name: "Admin", role: "admin", type: "human" };
  const stamp = Date.now();
  const db = `RB Tasks ${stamp}`;
  const markdownOf = async (title: string) => (await q<{ markdown: string }>(
    `SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [WS, title])).rows.map((r) => r.markdown);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
  });
  afterAll(async () => { await awaitAllDispatchers(); });

  it("takes the page in its own folder, leaves same-titled pages elsewhere and duplicate titles alone", async () => {
    const unique = `Unique ${stamp}`;
    const shared = `Shared ${stamp}`;
    const notes = `Notes ${stamp}`;
    const result = await importNotionDatabases(WS,
      [{ path: `${db}.csv`, content: `Name,Status\n${unique},Open\n${shared},Open\n${shared},Done\n${notes},Open\n` }],
      [
        { path: `${db}/${unique}.md`, content: `# ${unique}\n\nits own body\n` },
        { path: `${db}/${shared}.md`, content: `# ${shared}\n\nwhich row?\n` },
        // A page of the same name in another part of the export is not a row page.
        { path: `Elsewhere/${notes}.md`, content: `# ${notes}\n\nan ordinary page\n` },
      ],
      admin);
    await awaitAllDispatchers();
    expect(result).toMatchObject({ collections: 1, rows: 4, rowsSkipped: 0, bodiesAttached: 1 });
    expect([...result.consumedMdPaths]).toEqual([`${db}/${unique}.md`]);
    expect((await markdownOf(unique))[0]).toContain("its own body");
    // Two rows, one file: neither guesses.
    expect(await markdownOf(shared)).toEqual(["", ""]);
    expect(await markdownOf(notes)).toEqual([""]);
  });

  it("a body holding U+0000 is not stored and its file is not consumed; the row counts once", async () => {
    const title = `Nul ${stamp}`;
    const path = `${db} nul/${title}.md`;
    const result = await importNotionDatabases(WS,
      [{ path: `${db} nul.csv`, content: `Name,Status\n${title},Open\n` }],
      [{ path, content: `# ${title}\n\nbad\u0000text\n` }],
      admin);
    await awaitAllDispatchers();
    expect(result).toMatchObject({ rows: 1, rowsSkipped: 0, bodiesAttached: 0 });
    expect(result.consumedMdPaths.has(path)).toBe(false);
    expect(await markdownOf(title)).toEqual([""]);
  });
});
