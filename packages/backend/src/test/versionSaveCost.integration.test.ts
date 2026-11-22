// What minting a version adds to one save (history-replication proposal §4.1, review of PR #1935 round 2, point 1): a body save of a note of
// about 20 KB and a drawing save of a drawing of about 1.8 MB (1,000 strokes, stored as chunks), each repeated, through the routes a person
// uses. Time is printed, never asserted (a shared machine stretches it); the rows the versions add are asserted: one version, one position,
// one event map per save, whatever the size of the content (nothing is hashed again for it: the version names the hash putBlob or the
// chunk store already computed). The same file runs on a checkout from before migration 220 (where the version tables do not exist and the
// row counts are skipped), which is how the PR's before/after numbers were taken.
// realPostgresAlso: the commit-time checks read content putBlob committed on its own connection, and the save path spans two connections on a server
import { afterEach, describe, expect, it } from "vitest";
import { dbDriver, q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const ROUNDS = 9;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const versionRows = async (): Promise<number | null> => {
  if (!(await q<{ t: string | null }>(`SELECT to_regclass('note_versions')::text AS t`)).rows[0]!.t) return null;
  return Number((await q<{ n: string }>(`SELECT ((SELECT count(*) FROM note_versions) + (SELECT count(*) FROM note_version_positions) + (SELECT count(*) FROM note_version_events))::text AS n`)).rows[0]!.n);
};

describe.skipIf(!isTestDb)("what a version adds to a save", () => {
  it("a 20 KB body save and a 1.8 MB drawing save: time printed; three rows per save, whatever the size", async () => {
    const node = await openNode("save-cost"); open.push(node);
    const world = await buildSourceWorld(node);
    await onNode(node, async () => {
      const line = (i: number) => `Line ${i}: the quick brown fox jumps over the lazy dog, again and again, to make the body long.`;
      let body = Array.from({ length: 220 }, (_, i) => line(i)).join("\n");
      const id = (await world.call("POST", "/api/nodes", { title: "Cost", markdown: body, space_id: world.spaceA })).id as string;
      const strokes = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, points: Array.from({ length: 130 }, (_, k) => [i + k * 0.5, k * 1.25 + i * 0.01]) }));
      let drawing = JSON.stringify({ v: 1, strokes });
      await world.call("PUT", `/api/nodes/${id}/attributes/note_ink`, { value: drawing });
      await q(`ANALYZE`);
      const bodyMs: number[] = [], inkMs: number[] = [], bodyRows: number[] = [], inkRows: number[] = [];
      for (let k = 0; k < ROUNDS; k++) {
        body = `${k % 2 ? "X" : "Y"}${body.slice(1)}`;
        let r0 = await versionRows(); let t = performance.now();
        await world.call("PATCH", `/api/nodes/${id}`, { markdown: body });
        bodyMs.push(performance.now() - t);
        if (r0 !== null) bodyRows.push((await versionRows())! - r0);
        const previous = drawing;
        drawing = JSON.stringify({ v: 1, strokes: [...strokes, { id: `extra${k}`, points: [[k, k], [k + 1, k + 1]] }] });
        r0 = await versionRows(); t = performance.now();
        await world.call("PUT", `/api/nodes/${id}/attributes/note_ink`, { value: drawing, base_value: previous });
        inkMs.push(performance.now() - t);
        if (r0 !== null) inkRows.push((await versionRows())! - r0);
      }
      console.log(`[version save cost] ${dbDriver}: body ${Math.round(body.length / 1024)} KB save median ${median(bodyMs).toFixed(1)} ms; drawing ${(drawing.length / 1e6).toFixed(2)} MB save median ${median(inkMs).toFixed(1)} ms; version rows per save: body ${JSON.stringify(bodyRows)}, drawing ${JSON.stringify(inkRows)}`);
      expect(drawing.length).toBeGreaterThan(1_500_000);
      if (bodyRows.length > 0) {
        expect(bodyRows.every((n) => n === 3)).toBe(true);
        expect(inkRows.every((n) => n === 3)).toBe(true);
      }
    });
  }, 600_000);
});
