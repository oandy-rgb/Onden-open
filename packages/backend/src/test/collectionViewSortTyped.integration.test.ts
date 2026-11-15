// Regression (structured-data persona walkthrough): collection/database views
// sorted number- and date-typed attributes LEXICOGRAPHICALLY ("10" < "9" as
// text, date ranges misordered) because executeView ordered by the raw
// node_attributes.value text with no type cast. The fix casts based on the
// per-row value_type (set from the schema field type at write time). This
// pins the numeric ordering against a real Postgres — a mocked-SQL unit test
// can prove the cast is EMITTED, only PG proves it actually ORDERS right.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { executeView } from "../services/collectionViewQuery.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("collection view typed sort", () => {
  const STAMP = Date.now();
  let WS = "", tagId = "";
  const ids: Record<string, string> = {}; // value -> node id

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();

    // class-tag + schema declaring a number field "amount"
    tagId = (await seedClassTag(WS, {
      name: "Typed",
      slug: `typed-${STAMP}`,
      title: `typed-tag-${STAMP}`,
      nodeSlug: `typed-tag-${STAMP}`,
      fields: [{ name: "amount", type: "number" }],
    })).tagId;

    // three members with number values whose text order differs from
    // their numeric order: text → "10","100","9"; numeric → 9,10,100.
    for (const v of ["9", "10", "100"]) {
      const nid = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'') RETURNING id`,
        [WS, `typed ${v} ${STAMP}`, `typed-${v}-${STAMP}`],
      )).rows[0]!.id;
      ids[v] = nid;
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [nid, tagId]);
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
         VALUES ($1,$2,'amount',$3,'number','explicit')`,
        [WS, nid, v],
      );
    }
  });

  it("sorts a number field 9,10,100 ascending — not 10,100,9 (text order)", async () => {
    const { rows } = await executeView({
      workspaceId: WS, tagId,
      filters: [],
      sorts: [{ field: "amount", dir: "asc" }],
      visibleFields: ["amount"],
      readableIds: [ids["9"], ids["10"], ids["100"]],
    });
    expect(rows.map((r) => r.id)).toEqual([ids["9"], ids["10"], ids["100"]]);
    expect(rows.map((r) => r.attributes.amount)).toEqual(["9", "10", "100"]);
  });

  it("sorts a number field descending 100,10,9", async () => {
    const { rows } = await executeView({
      workspaceId: WS, tagId,
      filters: [],
      sorts: [{ field: "amount", dir: "desc" }],
      visibleFields: ["amount"],
      readableIds: [ids["9"], ids["10"], ids["100"]],
    });
    expect(rows.map((r) => r.id)).toEqual([ids["100"], ids["10"], ids["9"]]);
  });
});
