// A site published before migration 201 names a note whose id the migration changed by its old id. Until the next publish the served
// site must show what it showed (modules/website/publishing/servedSite.ts, services/idRewrites.ts), and a note taken down before the
// migration (payload.taken_down, takenDown.ts) must stay down, under its new id.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DAY_NOTE_NAMESPACE, TASKS_NOTE_TITLE, dayNoteIdName } from "@onden/markdown";
import { pool, q } from "../db.js";

let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { recordTakedowns } from "../modules/website/publishing/takenDown.js";
import { uuidV5 } from "../utils.js";
import { persistActor } from "./helpers/persistActor.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { seedQ } from "./helpers/seedQ.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

describe.skipIf(!isTestDatabase())("a site published before migration 201 stays as it was", () => {
  const tag = randomUUID().slice(0, 8);
  const spaceShown = randomUUID();
  const spaceDown = randomUUID();
  // two notes whose ids their spaces gave them (a space's tasks note), one on the site, one taken down since it was published
  const shown = uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(spaceShown, TASKS_NOTE_TITLE));
  const down = uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(spaceDown, TASKS_NOTE_TITLE));

  const payloadOf = async () => (await q<{ payload: { nodes: Array<{ id: string }>; taken_down?: string[] } }>(
    `SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [ws])).rows[0]!.payload;
  const served = async () => ((await loadServedSite(ws)).payload as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id);

  /** A space an older server gave a random id: its members are taken off while the id changes and put back. */
  async function reIdSpace(from: string, to: string) {
    const members = (await q<{ actor_id: string; permission: string }>(`SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [from])).rows;
    await seedQ(`DELETE FROM space_members WHERE space_id = $1`, [from]);
    await seedQ(`UPDATE spaces SET id = $2, capabilities = capabilities || '{"publish": true}'::jsonb WHERE id = $1`, [from, to]);
    for (const m of members) await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, $3)`, [to, m.actor_id, m.permission]);
  }

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived site', $1) RETURNING id::text`, [`derived-site-${tag}`])).rows[0]!.id;
    const owner = await persistActor(ws, { id: "", name: `Owner ${tag}`, role: "admin", type: "human" });
    await setWorkspaceOwner(ws, owner.id);
    const current = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [ws, owner.id])).rows[0]!.id;
    await reIdSpace(current, spaceShown);
    await reIdSpace(personal, spaceDown);
    for (const [id, space, slug] of [[shown, spaceShown, `shown-${tag}`], [down, spaceDown, `down-${tag}`]] as const) {
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'content', $3, $4, 'body', $5)`,
        [id, ws, TASKS_NOTE_TITLE, slug, space]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_published', 'true', 'text', 'ui')`, [ws, id]);
    }
    const node = (id: string, slug: string) => ({ id, node_type: "content", title: TASKS_NOTE_TITLE, slug, parent_id: null });
    await seedQ(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload) VALUES ($1, 'Site', 0, $2::jsonb)`,
      [ws, JSON.stringify({ nodes: [node(shown, `shown-${tag}`), node(down, `down-${tag}`)], edges: [], presentation: {}, settings_frozen: true, taken_down: [down] })]);
    expect(await served()).toEqual([shown]); // before: the taken-down note is off the site
    await rerunMigration("201_derived_ids_function_ref_stamps");
  }, 60_000);
  afterAll(async () => { await pool.end(); });

  it("shows the same notes after the migration changed the ids of the notes and of their spaces", async () => {
    expect((await q(`SELECT 1 FROM content_nodes WHERE id IN ($1, $2)`, [shown, down])).rows).toHaveLength(0); // the notes really moved
    expect(await served()).toEqual([shown]); // the snapshot still names it by the old id, and it is still on the site
  });

  it("a note taken down before the migration stays down: it is not shown again under its new id", async () => {
    expect(await served()).not.toContain(down);
    const current = (await q<{ id: string }>(`SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND n.slug = $2`, [ws, `down-${tag}`])).rows[0]!.id;
    expect(current).not.toBe(down);
  });

  it("recording take-downs after the migration does not mark the note that is still on the site as gone", async () => {
    await seedQ(`SELECT 1`); // (a transaction of its own: recordTakedowns runs in the transaction of the change)
    const { withTransaction } = await import("../db.js");
    await withTransaction(() => recordTakedowns(ws));
    expect((await payloadOf()).taken_down).toEqual([down]);
    expect(await served()).toEqual([shown]);
  });
});
