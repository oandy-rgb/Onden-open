// A view filter "title contains 100%" must match the literal text "100%", not
// "100" followed by anything: % and _ are escaped by containsPattern. The
// title column carries a PGroonga index, whose ILIKE scan is the part a mocked
// SQL test cannot vouch for. A number in the jsonb filter value (the view
// builder stores 100, not "100") must not fail the request either.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { executeView } from "../services/collectionViewQuery.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("view filter contains escapes LIKE wildcards", () => {
  const STAMP = Date.now();
  let WS = "", tagId = "";
  const ids: Record<string, string> = {};
  // No STAMP in the titles: its digits can contain "100" (Date.now() does about 1 run in 100), which makes the
  // "a_b"/"axb" notes match the numeric "100" filter. Ids and slugs keep the rows unique; the query is scoped to our tag.
  const TITLES = { literal: "全部 100% 完成", plain: "100 項目", under: "a_b", other: "axb" };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    tagId = (await seedClassTag(WS, {
      name: "LikeEscape", slug: `like-escape-${STAMP}`, title: `like-escape-tag-${STAMP}`, nodeSlug: `like-escape-tag-${STAMP}`, fields: [],
    })).tagId;
    for (const [key, title] of Object.entries(TITLES)) {
      const nid = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'') RETURNING id`, [WS, title, `like-${key}-${STAMP}`],
      )).rows[0]!.id;
      ids[key] = nid;
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [nid, tagId]);
    }
  });

  const titlesFor = async (value: string | number) =>
    (await executeView({
      workspaceId: WS, tagId, sorts: [], visibleFields: [], readableIds: Object.values(ids),
      filters: [{ field: "title", op: "contains", value: value as string }],
    })).rows.map((r) => r.id);

  it("'100%' returns only the note that contains 100%", async () => {
    expect(await titlesFor("100%")).toEqual([ids.literal]);
  });
  it("'a_b' does not match 'axb'", async () => {
    expect(await titlesFor("a_b")).toEqual([ids.under]);
  });
  it("a numeric filter value is read as its text instead of failing", async () => {
    expect((await titlesFor(100)).sort()).toEqual([ids.literal, ids.plain].sort());
  });
});
