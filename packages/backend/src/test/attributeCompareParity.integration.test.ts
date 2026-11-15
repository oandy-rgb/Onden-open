// The server's typed attribute filters (filter/sqlClauses.ts) and attribute
// sort (collectionViewQuery.ts attributeSortSql) over the same fixture the
// frontend's onden-base block is checked against
// (packages/frontend/src/test/basesCompareParity.test.ts): both must list and
// order the same notes (D49).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db.js";
import { executeView, type FilterClause } from "../services/collectionViewQuery.js";
import { seedQ } from "./helpers/seedQ.js";

type Fixture = {
  notes: Array<{ key: string; attrs: Record<string, [string, string]> }>;
  filters: Array<{ expr: string; clause: FilterClause; expect: string[] }>;
  sorts: Array<{ key: string; dir: "asc" | "desc"; expect: string[] }>;
};
const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, "../../../frontend/src/test/fixtures/attributeCompareParity.json"), "utf8")) as Fixture;

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);

describe.skipIf(!isTestDb)("attribute comparisons match the frontend's Bases (DB)", () => {
  let workspaceId = "";
  let tagId = "";
  const keyOf = new Map<string, string>();
  const view = (filters: FilterClause[], sorts: Array<{ field: string; dir: "asc" | "desc" }>) =>
    executeView({ workspaceId, tagId, filters, sorts, visibleFields: [], limit: 200, readableIds: [...keyOf.keys()] });

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Compare',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    tagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'class_tag', 'Compare', $2, '') RETURNING id::text`, [workspaceId, `tag-${randomUUID()}`])).rows[0]!.id;
    for (const n of fixture.notes) {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`, [workspaceId, n.key, randomUUID()])).rows[0]!.id;
      keyOf.set(id, n.key);
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
      for (const [key, [value, type]] of Object.entries(n.attrs)) {
        await seedQ(
          `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, id, key, value, type]);
      }
    }
  });

  for (const f of fixture.filters) {
    it(`${f.expr} (${f.clause.op} ${JSON.stringify(f.clause.value)})`, async () => {
      const { rows } = await view([f.clause], []);
      expect(rows.map((r) => keyOf.get(r.id)).sort()).toEqual([...f.expect].sort());
    });
  }

  for (const s of fixture.sorts) {
    it(`sort ${s.key} ${s.dir}`, async () => {
      const { rows } = await view([], [{ field: s.key, dir: s.dir }]);
      expect(rows.map((r) => keyOf.get(r.id))).toEqual(s.expect);
    });
  }
});
