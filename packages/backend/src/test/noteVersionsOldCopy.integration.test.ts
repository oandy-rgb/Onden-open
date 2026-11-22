// Migration 220 on a copy made by the repo's old-copy tool (src/browser/makeOldCopy.ts, mode `history`: a database from before 220 whose
// history was written through the app, plus a save whose text is gone and a note never saved through an event). The proof the batch asks
// for (history-replication proposal §9 row 1; review of PR #1935 round 2, point 8 and the items it did not check):
//   * the read-only preview in the migration's header, run on the copy before upgrading, gives exactly the numbers today's migrate() writes;
//   * two copies of that database, each upgraded by itself, hold the same version identities;
//   * running the migration's pass again changes nothing (no row, no sequence number).
// Registered only when the driver is PGlite: the tool and its copy are PGlite databases (as test/makeOldCopy.test.ts).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowUnstampedWrite, dbDriver, migrate, q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { PREVIEW_SQL } from "./helpers/versionsPreview.js";

const backend = resolve(import.meta.dirname, "../..");
const count = async (text: string) => Number((await q<{ n: string }>(text)).rows[0]!.n);
const written = async () => ({
  body_versions: String(await count(`SELECT count(*)::text AS n FROM note_versions WHERE unit = 'body' AND version_key LIKE 'g:%'`)),
  ink_versions: String(await count(`SELECT count(*)::text AS n FROM note_versions WHERE unit <> 'body' AND version_key LIKE 'g:%' AND kind <> 'set_aside'`)),
  body_baselines: String(await count(`SELECT count(*)::text AS n FROM note_versions WHERE unit = 'body' AND version_key LIKE 'b:%'`)),
  ink_baselines: String(await count(`SELECT count(*)::text AS n FROM note_versions WHERE unit <> 'body' AND version_key LIKE 'b:%'`)),
  // a save of a note with a version list that names text no blob holds: not minted, and not mapped
  ink_inline_values: String(await count(`SELECT count(DISTINCT ve.version_key)::text AS n FROM note_version_events ve JOIN domain_events e ON e.id = ve.event_id
     WHERE e.event_type = 'ATTRIBUTE_SET' AND NOT e.payload ? 'value_ref' AND e.payload ? 'value'`)),
  drawing_saves_without_value: String(await count(`SELECT count(*)::text AS n FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id AND note_version_in_scope(c.node_type, c.source_type)
     WHERE e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink') AND e.payload ? 'value_ref'
       AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'value_ref') AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = c.id AND m.hash = e.payload->>'value_ref')
       AND NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = e.workspace_id AND j.state = 'joining')`)),
  saves_without_text: String(await count(`SELECT count(*)::text AS n FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id AND note_version_in_scope(c.node_type, c.source_type)
     WHERE e.event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND e.payload ? 'body_hash' AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = COALESCE(e.body_hash, e.payload->>'body_hash'))`)),
});
const identities = () => q(`SELECT note_id, unit, version_key, kind, title, content_hash, CASE WHEN version_key LIKE 'b:%' THEN NULL ELSE at END AS at,
                                   clock_wall, clock_counter, ordinal, author_kind, author_id, restored_from FROM note_versions ORDER BY note_id, unit, version_key`).then((r) => r.rows);

// Pure, every round (so the file has a suite on real Postgres too, where the copy below does not exist): the preview an operator pastes reads only.
describe("the preview in migration 220's header", () => {
  it("is one read: a WITH … SELECT, no statement that writes or holds a lock", () => {
    expect(PREVIEW_SQL.trim()).toMatch(/^WITH /);
    expect(PREVIEW_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|LOCK|COPY|FOR UPDATE|FOR SHARE|set_config|nextval|note_versions_backfill)\b/i);
    expect(PREVIEW_SQL.trim().endsWith(";")).toBe(true);
    expect(PREVIEW_SQL.split(";").filter((s) => s.trim()).length).toBe(1);
  });
});

if (dbDriver === "pglite") describe.skipIf(!isTestDatabase())("migration 220 on a copy the old-copy tool made", () => {
  let dir = "", file = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "versions-copy-"));
    file = join(dir, "history.tar.gz");
    await promisify(execFile)("npx", ["tsx", "src/browser/makeOldCopy.ts", file, "history"], { cwd: backend, timeout: 280_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", ONDEN_PGLITE_SNAPSHOT: "" } });
  }, 300_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("the preview equals what the upgrade writes; two copies upgraded apart agree; a second pass adds nothing", async () => {
    const [a, b] = [await RealNode.open("old-history-a", undefined, file), await RealNode.open("old-history-b", undefined, file)];
    try {
      const before = await onNode(a, async () => {
        // the copy is from before 220: no version table, history only as events
        expect((await q<{ t: string | null }>(`SELECT to_regclass('note_versions')::text AS t`)).rows[0]!.t).toBeNull();
        expect(await count(`SELECT count(*)::text AS n FROM domain_events WHERE payload ? 'body_hash'`)).toBeGreaterThan(20);
        return (await q<Record<string, string>>(PREVIEW_SQL)).rows[0]!;
      });
      const after = await onNode(a, async () => { await migrate({ seedNativeActor: false }); return written(); });
      console.log(`[migration 220, old copy] preview ${JSON.stringify(before)}; written ${JSON.stringify(after)}`);
      expect(after).toEqual(before);
      for (const key of ["body_versions", "ink_versions", "body_baselines", "saves_without_text"]) expect(Number(before[key]), key).toBeGreaterThan(0);

      await onNode(b, () => migrate({ seedNativeActor: false }));
      const [ida, idb] = [await onNode(a, identities), await onNode(b, identities)];
      expect(ida.length).toBeGreaterThan(20);
      expect(idb).toEqual(ida);

      await onNode(a, async () => {
        const state = async () => [await q(`SELECT workspace_id, next_seq FROM sync_clock ORDER BY 1`).then((r) => r.rows), await count(`SELECT count(*)::text AS n FROM note_version_positions`),
          await count(`SELECT count(*)::text AS n FROM note_version_events`), await identities()];
        const s0 = await state();
        const again = await allowUnstampedWrite("test: the migration's pass again", () => withTransaction(async () => {
          await q(`SELECT set_config('onden.no_versions', 'on', true)`);
          return (await q(`SELECT b.* FROM workspaces w CROSS JOIN LATERAL note_versions_backfill(w.id) b`)).rows;
        }));
        expect(again.every((r) => Number(r.versions) + Number(r.baselines) + Number(r.set_aside) === 0 && r.s0 === null)).toBe(true);
        expect(await state()).toEqual(s0);
      });
    } finally { await a.close(); await b.close(); }
  }, 300_000);
});
