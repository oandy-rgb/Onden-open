// The browser version taking a file from another device (browser/worker.ts `join-file`, frontend browserApp/BringNotes.tsx): a copy with a note of
// its own is refused (the screen turns that into words) and the refusal leaves the copy as it was; once nothing of its own is left the same file is taken in. SAFETY: two PGlite databases; only in a PGlite run, from the packaged database the browser app starts from.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, digestAs, fillFrom, openNode, type Capture, type SourceWorld } from "./helpers/stampedWorld.js";
import { compareDigests } from "../spine/snapshotSql.js";
import { ensureOwnNodeId } from "../browser/nodeIdentity.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "") && process.env.ONDEN_DB_DRIVER === "pglite";

describe.skipIf(!isTestDb)("an empty browser copy taking a file from another device", () => {
  let src: RealNode | undefined;
  let world: SourceWorld;
  let cap: Capture;
  let shell: RealNode;
  let dir: string;
  let login: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bring-"));
    const tar = join(dir, "packaged.tar.gz");
    await promisify(execFile)("npx", ["tsx", "src/browser/prepareSnapshot.ts", tar], { cwd: resolve(import.meta.dirname, "../.."), timeout: 240_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" } });
    shell = await RealNode.open("browser-shell-for-bring", undefined, tar);
    login = await onNode(shell, async () => {
      await ensureOwnNodeId();
      return (await q<{ id: string }>(`SELECT id FROM "user"`)).rows[0]!.id;
    });
  }, 300_000);
    const sourceMade = async () => {
    if (src) return;
    src = await openNode("source-for-bring");
    world = await buildSourceWorld(src);
    cap = await capture(src, world, 12_000);
  };
  afterAll(async () => { await shell?.close(); await src?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  const note = (id: string) => seedQ(
    `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) SELECT $1, id, 'manual', 'content', 'A note of the person', $2, 'x' FROM workspaces`, [id, `slug-${id}`]);

  it("a copy with a note of its own is refused as `join_not_empty` and is exactly as it was after; with none, the same file is taken in", async () => {
    await sourceMade();
    const own = randomUUID();
    await onNode(shell, () => note(own));
    const countBefore = await onNode(shell, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes`)).rows[0]!.n);
    await expect(fillFrom(shell, world, cap, { localLogin: login })).rejects.toMatchObject({ code: "join_not_empty" });
    // the refusal left the copy usable and unchanged: the same workspace, the same notes, the one person's sign-in
    const after = await onNode(shell, async () => ({
      n: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes`)).rows[0]!.n,
      workspaces: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).rows[0]!.n,
      joining: (await q(`SELECT 1 FROM sync_join WHERE state = 'joining'`)).rows.length,
    }));
    expect(after).toEqual({ n: countBefore, workspaces: "1", joining: 0 });
    await onNode(shell, () => seedQ(`DELETE FROM content_nodes WHERE id = $1`, [own]));
    await fillFrom(shell, world, cap, { localLogin: login });
    expect(compareDigests(cap.summary.digest, await digestAs(shell, world.ws, world.owner))).toEqual([]);
  }, 120_000);
});
