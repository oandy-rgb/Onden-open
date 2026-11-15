// D76: /api/nodes/search returns the snippet contract — plain text + highlight
// ranges (@onden/markdown snippet.ts) — and the same snippet the app's
// on-device index gives (frontend searchSnippets.test.tsx reads the same
// fixture). Before, it sent pgroonga_snippet_html: HTML-escaped fragments of
// raw markdown (`Q&amp;A for &lt;tips&gt;` on screen).
//
// SAFETY: only runs against a *_test database; skips otherwise. Needs
// pgroonga (the search operator), as every search test does.

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import type { Snippet } from "@onden/markdown";
import { searchNodes } from "../services/nodeSearch.js";
import { q, getWorkspaceId } from "../db.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const fixture = JSON.parse(readFileSync(new URL("../../../markdown/src/fixtures/searchSnippets.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; markdown: string; query: string; expected: Snippet }>;
};

describe.skipIf(!isTestDb)("search snippets (DB)", () => {
  let WS = "";
  let admin: ActorCtx = { id: "", name: "Snippet admin", role: "admin", type: "human" };
  const ids: string[] = [];
  let titleOnly = "";
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    for (const [i, c] of fixture.cases.entries()) {
      ids.push((await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
        [WS, `Snippet fixture ${i}`, `snippet-fixture-${i}-${stamp}`, c.markdown])).rows[0]!.id);
    }
    titleOnly = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'nothing here') RETURNING id`,
      [WS, `zqtitleonly${stamp}`, `snippet-title-only-${stamp}`])).rows[0]!.id;
  });

  fixture.cases.forEach((c, i) => {
    it(`agrees with the shared fixture: ${c.name}`, async () => {
      const rows = await searchNodes(WS, c.query, admin, 50);
      expect(rows.find((r) => r.id === ids[i])?.snippet).toEqual(c.expected);
    });
  });

  it("never sends HTML: a note's & and < arrive as written", async () => {
    const i = fixture.cases.findIndex((c) => c.name.startsWith("escapes"));
    const hit = (await searchNodes(WS, "kafka", admin, 50)).find((r) => r.id === ids[i])!;
    expect(hit.snippet!.text).toContain("Q&A: <tips> &");
    expect(JSON.stringify(hit.snippet)).not.toMatch(/&amp;|&lt;|class=\\?"keyword/);
  });

  it("has no snippet for a title-only match or a pure-filter query", async () => {
    const rows = await searchNodes(WS, `zqtitleonly${stamp}`, admin, 50);
    expect(rows.find((r) => r.id === titleOnly)).toMatchObject({ snippet: null });
    expect((await searchNodes(WS, "#nosuchtag", admin, 50)).every((r) => r.snippet === null)).toBe(true);
  });

  // Typing a note's exact name puts it first, however often other notes repeat
  // the word (the title tie-break comes before pgroonga_score).
  it("ranks a title equal to the query, then one starting with it, before the score", async () => {
    const word = `zqrank${stamp}`;
    const add = async (title: string, markdown: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
      [WS, title, `rank-${stamp}-${title.length}-${markdown.length}`, markdown])).rows[0]!.id;
    const heavy = await add(`Notes on ${word}`, `${word} `.repeat(80));
    const prefix = await add(`${word} primer`, `${word} ${word}`);
    const exact = await add(word.toUpperCase(), "short");
    const found = (await searchNodes(WS, word, admin, 50)).map((r) => r.id);
    expect(found.slice(0, 3)).toEqual([exact, prefix, heavy]);
  });
});
