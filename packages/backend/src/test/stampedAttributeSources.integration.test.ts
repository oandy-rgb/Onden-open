// Which `node_attributes.source` values are units (migration 223, batch 4a: the values a note's text gives it travel). ONE list, four places that must agree:
// the SQL function the stamp trigger and the genesis pass call (sync_attribute_source_stamped), the TypeScript list (spine/attributeSource.ts STAMPED_ATTRIBUTE_SOURCES),
// what a change bundle carries (spine/stampedMerge/dbUnits.ts, the `where` of node_attributes) and what a snapshot carries (spine/snapshotTables.json).
// And the two behaviours migration 223 adds: a `markdown` / `frontmatter` row is stamped by the trigger, and an existing one gets its genesis stamp from the pass.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { onNode, type RealNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { STAMPED_ATTRIBUTE_SOURCES, stampedAttributeSourceSql } from "../spine/attributeSource.js";
import { sourceOf } from "../spine/stampedMerge/dbUnits.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const snapshotTables = JSON.parse(readFileSync(fileURLToPath(new URL("../spine/snapshotTables.json", import.meta.url)), "utf8")) as Record<string, { where?: string }>;

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const EVERY_SOURCE = ["ui", "explicit", "dispatcher", "markdown", "frontmatter", "derived"];
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

describe("which attribute sources are units: one list (no database)", () => {
  it("the bundle's `where` of node_attributes and the snapshot's are the TypeScript list", () => {
    expect(STAMPED_ATTRIBUTE_SOURCES).toEqual(["ui", "explicit", "dispatcher", "markdown", "frontmatter"]);
    expect(sourceOf("node_attributes").where).toBe(stampedAttributeSourceSql("t"));
    expect(snapshotTables.node_attributes!.where).toContain(stampedAttributeSourceSql("t"));
  });
});

describe.skipIf(!isTestDb)("which attribute sources are units: the database", () => {
  it("sync_attribute_source_stamped says yes for exactly the TypeScript list; a markdown and a frontmatter row are stamped; an existing one gets its genesis stamp", async () => {
    const node = await openNode("attr-sources");
    open.push(node);
    const world = await buildSourceWorld(node);
    await onNode(node, async () => {
      const said = (await q<{ s: string; on: boolean }>(`SELECT s, sync_attribute_source_stamped(s) AS on FROM unnest($1::text[]) s`, [EVERY_SOURCE])).rows;
      expect(said.filter((r) => r.on).map((r) => r.s)).toEqual([...STAMPED_ATTRIBUTE_SOURCES]);
      const note = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' ORDER BY created_at LIMIT 1`, [world.ws])).rows[0]!.id;
      const stampOf = async (key: string) => (await q<{ origin: string }>(`SELECT origin FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2 AND field = '*'`, [world.ws, `${note}/${key}`])).rows[0]?.origin ?? null;
      for (const source of ["markdown", "frontmatter", "derived"]) {
        const key = `k-${source}-${randomUUID().slice(0, 6)}`;
        await withEventTransaction(world.ws, () => q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, 'v', 'text', $4)`, [world.ws, note, key, source]));
        expect(await stampOf(key) !== null, source).toBe(source !== "derived");
      }
      // a row written before migration 223 had no stamp: the pass gives it the genesis one (and none to a derived row)
      const old = `k-old-${randomUUID().slice(0, 6)}`;
      await withEventTransaction(world.ws, async () => {
        await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, 'v', 'text', 'markdown')`, [world.ws, note, old]);
        await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2`, [world.ws, `${note}/${old}`]);
      });
      await withEventTransaction(world.ws, () => q(`SELECT * FROM sync_genesis_pass()`));
      expect(await stampOf(old)).toBe("genesis");
    });
  }, 300_000);
});
