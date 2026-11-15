// function_refs records who last changed it, like the other stamped tables (migration 201; causal-stamps proposal §8): the row as a
// whole, and each key of its config on its own, so two nodes that change different keys of one reference both survive a merge.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

type StampRow = { field: string; seq: number; deleted: boolean; author: string | null };

describe.skipIf(!isTestDatabase())("function_refs write stamps", () => {
  const tag = randomUUID().slice(0, 8);
  let ws = "";
  let ada!: ActorCtx;
  let holder = "";

  const stamps = async (table: string, key: string): Promise<Map<string, StampRow>> => new Map((await q<StampRow>(
    `SELECT field, seq::int, deleted, author FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`, [ws, table, key])).rows.map((r) => [r.field, r]));
  const write = (sql: string, params: unknown[]) => mutate({
    actor: ada, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "TAG_UPDATED", targetType: "tag", targetId: holder, payload: { probe: tag } },
    apply: async () => { await q(sql, params); },
  });

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Ref stamps', $1) RETURNING id::text`, [`ref-stamps-${tag}`])).rows[0]!.id;
    ada = await persistActor(ws, { id: "", name: `Ada ${tag}`, role: "admin", type: "human" });
    holder = (await seedClassTag(ws, { name: `Holder ${tag}`, slug: `holder-${tag}` })).tagId;
  }, 30_000);
  afterAll(async () => { await pool.end(); });

  it("a reference is stamped when it is made, each config key that changes gets its own later stamp, and a delete leaves a tombstone", async () => {
    const id = randomUUID();
    await write(`INSERT INTO function_refs (id, workspace_id, function_id, holder_node_id, config) VALUES ($1, $2, 'probe', $3, $4::jsonb)`,
      [id, ws, holder, JSON.stringify({ alpha: "1", beta: "1" })]);
    const made = await stamps("function_refs", id);
    expect(made.get("*")).toMatchObject({ deleted: false, author: ada.id });
    const configMade = await stamps("function_refs.config", id);
    expect([...configMade.keys()].sort()).toEqual(["key:alpha", "key:beta"]);

    await write(`UPDATE function_refs SET config = config || '{"alpha": "2"}'::jsonb WHERE id = $1`, [id]);
    const changed = await stamps("function_refs.config", id);
    expect(changed.get("key:alpha")!.seq).toBeGreaterThan(configMade.get("key:alpha")!.seq); // the stored value really moved
    expect(changed.get("key:beta")!.seq).toBe(configMade.get("key:beta")!.seq);                // the key nobody touched did not

    // the same value written again changes nothing, and a key taken out is a tombstone of that key
    await write(`UPDATE function_refs SET config = config || '{"alpha": "2"}'::jsonb WHERE id = $1`, [id]);
    expect((await stamps("function_refs.config", id)).get("key:alpha")!.seq).toBe(changed.get("key:alpha")!.seq);
    await write(`UPDATE function_refs SET config = config - 'beta' WHERE id = $1`, [id]);
    expect((await stamps("function_refs.config", id)).get("key:beta")).toMatchObject({ deleted: true });

    // moving the reference to another holder is stamped on the row, with a later number
    const second = (await seedClassTag(ws, { name: `Holder two ${tag}`, slug: `holder-two-${tag}` })).tagId;
    await write(`UPDATE function_refs SET holder_node_id = $2 WHERE id = $1`, [id, second]);
    expect((await stamps("function_refs", id)).get("holder")!.seq).toBeGreaterThan(made.get("*")!.seq);

    await write(`DELETE FROM function_refs WHERE id = $1`, [id]);
    const gone = await stamps("function_refs", id);
    expect(gone.get("*")).toMatchObject({ deleted: true });
    expect(gone.get("*")!.seq).toBeGreaterThan(made.get("*")!.seq);
  });

  it("a write outside the write entry is still stamped (author unknown) and counted, as for the other tables", async () => {
    const id = randomUUID();
    const before = Number((await q<{ n: string }>(`SELECT COALESCE(max(writes_without_mutate), 0)::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]?.n ?? "0");
    await seedQ(`INSERT INTO function_refs (id, workspace_id, function_id, holder_node_id) VALUES ($1, $2, 'probe_outside_entry', $3)`, [id, ws, holder]);
    expect((await stamps("function_refs", id)).get("*")).toMatchObject({ deleted: false, author: null });
    const after = Number((await q<{ n: string }>(`SELECT writes_without_mutate::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!.n);
    expect(after).toBeGreaterThan(before);
  });
});
