// Migration 235 (a note's slug is a unit): the read-only preview the owner runs on the production database before deploying. Every line is a count the database
// gives, none is a constant (review of PR #1992, round 1, point 3, and round 2, point 4): a note whose slug starts with `~` is counted (its written slug would be
// refused by every receiver), and the first line is what the migration's UPDATE writes on its first run.
// Its own database (openNode): the source world's people and invitations are unique per database. Runs on PGlite and on a real Postgres.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const MIGRATION = join(import.meta.dirname, "../../db/migrations/235_slug_is_a_unit.sql");

/** The preview query in the header: the comment lines after `-- Read-only preview` up to the line that is only `--   ;`. */
function preview(): string {
  const lines = readFileSync(MIGRATION, "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("-- Read-only preview"));
  const body: string[] = [];
  for (const l of lines.slice(from + 1)) { if (l.trim() === "--   ;") break; if (l.startsWith("--  ")) body.push(l.slice(4)); }
  return body.join("\n");
}

type Line = { part: string; n: string };
let node: RealNode;
/** The preview on this file's own database (openNode: a world's people and invitations are unique per database, so the shared test database is not this file's),
 *  in one transaction that is rolled back: read-only when nothing comes `before` it, else after `before` (nothing it did stays). */
const runPreview = (before?: string, params: unknown[] = []): Promise<Line[]> => onNode(node, () => withTransaction(async () => {
  if (before) await q(before, params); else await q("SET TRANSACTION READ ONLY");
  const rows = (await q<Line>(preview())).rows;
  throw Object.assign(new Error("roll back"), { rows });
}).then(() => { throw new Error("the preview's transaction was not rolled back"); }, (e: { rows?: Line[] }) => { if (!e.rows) throw e; return e.rows; }));

describe.skipIf(!isTestDatabase())("migration 235: the preview", () => {
  let ws!: string;
  beforeAll(async () => { node = await openNode("slug-235-preview"); ws = (await buildSourceWorld(node)).ws; }, 300_000);
  afterAll(async () => { await node?.close().catch(() => undefined); });

  it("runs in a read-only transaction and answers counts only, each read from the database", async () => {
    const rows = await runPreview();
    expect(rows.map((r) => r.part)).toEqual([
      "notes that get written_slug (= their slug; nothing else is written)",
      "notes whose slug starts with ~ (their written slug would be refused by every receiver; must be 0)",
    ]);
    for (const r of rows) expect(String(r.n), r.part).toMatch(/^\d+$/);
    for (const r of rows) for (const v of Object.values(r)) expect(String(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no id
    // the first line is every note: what the UPDATE writes on the first run (written_slug := slug)
    const notes = await onNode(node, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes`)).rows[0]!.n);
    expect(String(rows[0]!.n)).toBe(notes);
  });

  it("counts a note whose slug starts with ~ (its written slug would be refused by every full resend for ever)", async () => {
    const tilde = (rows: Line[]) => Number(rows.find((r) => r.part.startsWith("notes whose slug starts with ~"))!.n);
    const without = tilde(await runPreview());
    const withOne = tilde(await runPreview(
      `UPDATE content_nodes SET slug = '~' || id::text WHERE id = (SELECT id FROM content_nodes WHERE workspace_id = $1 AND deleted_at IS NULL AND left(slug, 1) <> '~' ORDER BY id LIMIT 1)`, [ws]));
    expect(withOne).toBe(without + 1);
  });
});
