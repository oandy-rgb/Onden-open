// Where a note's backup goes (services/outbox.ts backupTarget): decided when
// the backup runs, by note id; `<slug>.md` in the default space and
// `<space-id>/<slug>.md` elsewhere, since a slug is unique only within a
// space; nothing at all when the note is gone or its space keeps no backup.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { backupTarget } from "../services/outbox.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("backup target", () => {
  let ws = "";
  let defaultSpace = "";
  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Backup target', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
  });
  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
    await pool.end();
  });

  const note = async (slug: string, spaceId: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES ($1, 'manual', 'content', $2, $2, '', $3) RETURNING id::text`, [ws, slug, spaceId])).rows[0]!.id;

  it("keeps the old layout in the default space and a folder per other space", async () => {
    const lab = await makeSpace(ws, "lab", [], { publish: false, external_ai: false, backup: true });
    const shared = await note(`bt-shared-${randomUUID()}`, defaultSpace);
    const inLab = await note(`bt-lab-${randomUUID()}`, lab);
    const slugOf = async (id: string) => (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [id])).rows[0]!.slug;
    expect(await backupTarget({ nodeId: shared })).toEqual({ path: `${await slugOf(shared)}.md` });
    expect(await backupTarget({ nodeId: inLab })).toEqual({ path: `${lab}/${await slugOf(inLab)}.md` });
  });

  it("writes nothing for a space without backup, a note that is gone, or a pre-spaces slug that names nothing", async () => {
    const vault = await makeSpace(ws, "vault", [], { publish: false, external_ai: false, backup: false });
    expect(await backupTarget({ nodeId: await note(`bt-vault-${randomUUID()}`, vault) })).toBeNull();
    expect(await backupTarget({ nodeId: randomUUID() })).toBeNull();
    expect(await backupTarget({ slug: `bt-nothing-${randomUUID()}` })).toBeNull();
  });

  it("a pre-spaces intent still resolves when its slug names exactly one live note", async () => {
    const slug = `bt-legacy-${randomUUID()}`;
    await note(slug, defaultSpace);
    expect(await backupTarget({ slug })).toEqual({ path: `${slug}.md` });
  });
});
