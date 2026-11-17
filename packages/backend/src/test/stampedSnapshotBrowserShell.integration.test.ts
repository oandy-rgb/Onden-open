// A receiver that still holds the sample notes a first start makes is not "empty" until they are gone for good (the trash is not enough);
// then it takes the copy. Split out of stampedSnapshot.integration.test.ts: the first test runs on both engines (a node is a PGlite or a
// database of the real server, helpers/distSim/postgresNodes.ts); the second needs the browser app's packaged PGlite database (a PGlite
// tar made by src/browser/prepareSnapshot.ts) and is registered only in a PGlite run: it is not skipped on a real Postgres, it does not
// exist there, because there is no packaged database to open (the PR that added it says so; nothing is added to the skip lists).
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

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";

describe.skipIf(!isTestDb)("a receiver with sample notes", () => {
  let src: RealNode;
  let world: SourceWorld;
  let cap: Capture;

  beforeAll(async () => {
    src = await openNode("source");
    world = await buildSourceWorld(src);
    cap = await capture(src, world, 12_000);
  }, 120_000);
  afterAll(async () => { await src?.close(); });

  it("a sample note in the trash keeps the database from being empty; once it is purged the copy is taken", async () => {
    const receiver = await openNode("receiver-with-sample");
    try {
      const sample = randomUUID();
      await onNode(receiver, () => seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, deleted_at) SELECT $1, id, 'manual', 'content', 'Welcome', 'welcome-sample', 'hello', now() FROM workspaces`, [sample]));
      await expect(fillFrom(receiver, world, cap)).rejects.toMatchObject({ code: "join_not_empty" });
      await onNode(receiver, () => seedQ(`DELETE FROM content_nodes WHERE id = $1`, [sample]));
      await fillFrom(receiver, world, cap);
      expect(compareDigests(cap.summary.digest, await digestAs(receiver, world.ws, world.owner))).toEqual([]);
    } finally { await receiver.close(); }
  }, 120_000);

  if (onPglite) it("the browser's packaged database takes the copy once its sample notes are gone for good, and its one local sign-in opens the person", async () => {
    // The receiver a browser shell starts from: prepareSnapshot's output, with the node identity the first open makes (browser/nodeIdentity.ts).
    const dir = mkdtempSync(join(tmpdir(), "packaged-"));
    const tar = join(dir, "packaged.tar.gz");
    let shell: RealNode | null = null;
    try {
      await promisify(execFile)("npx", ["tsx", "src/browser/prepareSnapshot.ts", tar], { cwd: resolve(import.meta.dirname, "../.."), timeout: 240_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" } });
      shell = await RealNode.open("browser-shell", undefined, tar);
      const login = await onNode(shell, async () => {
        await ensureOwnNodeId();
        // the browser's one local account (a sign-in): its actor is made at its first request, so only the account exists now
        return (await q<{ id: string }>(`SELECT id FROM "user"`)).rows[0]!.id;
      });
      // A note of the person's own (the first open's samples are such notes) keeps the database from being taken for empty, in the trash too:
      // the layer above must remove them for good (purge) before it joins; the trash is not enough.
      const sample = randomUUID();
      await onNode(shell, () => seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, deleted_at) SELECT $1, id, 'manual', 'content', 'Welcome', 'welcome-sample', 'hello', now() FROM workspaces`, [sample]));
      await expect(fillFrom(shell, world, cap, { localLogin: login })).rejects.toMatchObject({ code: "join_not_empty" });
      await onNode(shell, () => seedQ(`DELETE FROM content_nodes WHERE id = $1`, [sample]));
      await fillFrom(shell, world, cap, { localLogin: login });
      expect(compareDigests(cap.summary.digest, await digestAs(shell, world.ws, world.owner))).toEqual([]);
      const linked = await onNode(shell, async () => (await q<{ id: string }>(`SELECT id::text FROM actors WHERE external_id = $1`, [login])).rows.map((r) => r.id));
      expect(linked).toEqual([world.owner.id]);
    } finally { await shell?.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
