// Migration 193: the Citations module is removed. What it must do to data that already exists:
//   * a module tag (tag_schema.module = 'citations') becomes an ordinary tag; its notes and field values stay;
//   * a tag still named paper-review is renamed to a plain name (論文 for a workspace with CJK titles, else Paper), unless
//     that name is taken or the person already renamed it;
//   * a tag never changed and with nothing on it goes to the trash through an event (so it can be restored);
//   * the function reference, the tag-level switch, the module id in the workspace lists and the derived `cites` edges go;
//   * note text containing [@key] is not touched. Running it twice changes nothing more.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { buildSyncDelta } from "../services/sync/index.js";
import type { ActorCtx } from "../types.js";

const MIGRATION = readFileSync(new URL("../../db/migrations/193_remove_citations_module.sql", import.meta.url), "utf8");
const PAPER_FIELDS = ["authors", "venue", "year", "doi", "arxiv_id", "citekey", "verdict", "tldr", "method", "findings", "limitations"];
const BODY = "As shown [@lee2020] and [see @kim2019, p. 3].";

describe.skipIf(!isTestDatabase())("migration 193 — the Citations module is removed (DB)", () => {
  const workspaces: string[] = [];

  async function workspace(modulesOff: string[] = []): Promise<string> {
    const id = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug, modules_off) VALUES ('M193', $1, $2::jsonb) RETURNING id::text`, [randomUUID(), JSON.stringify(modulesOff)],
    )).rows[0]!.id;
    workspaces.push(id);
    return id;
  }
  async function paperTag(ws: string, title: string, opts: { fields?: string[]; marked?: boolean; deleted?: boolean; switchOn?: boolean } = {}): Promise<string> {
    const schema: Record<string, unknown> = {
      fields: (opts.fields ?? PAPER_FIELDS).map((name) => ({ name, label: name, type: "text" })),
      ...(opts.marked === false ? {} : { module: "citations" }),
      ...(opts.switchOn ? { behaviour: { modules: { citations: { enabled: true }, review: { enabled: true } } } } : {}),
    };
    return (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema, deleted_at)
       VALUES ($1, 'manual', 'class_tag', $2, $3, $4::jsonb, ${opts.deleted ? "now()" : "NULL"}) RETURNING id::text`,
      [ws, title, `tag-${randomUUID()}`, JSON.stringify(schema)],
    )).rows[0]!.id;
  }
  async function note(ws: string, title: string, markdown = "", tag?: string): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'content', $2, $3, $4) RETURNING id::text`, [ws, title, `n-${randomUUID()}`, markdown],
    )).rows[0]!.id;
    if (tag) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tag]);
    return id;
  }
  const tagRow = async (id: string) => (await q<{ title: string; mod: string | null; live: boolean; hasSwitch: boolean; deletedBy: string | null }>(
    `SELECT title, tag_schema->>'module' AS mod, deleted_at IS NULL AS live,
            COALESCE((tag_schema->'behaviour'->'modules') ? 'citations', false) AS "hasSwitch", deleted_by_event_id::text AS "deletedBy"
       FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
  const run = () => seedQ(MIGRATION);

  let owner: ActorCtx = { id: "m193-owner", name: "Owner", role: "admin", type: "human" };
  let since = 0;
  let en = "", zh = "", taken = "", fresh = "", plain = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    en = await workspace(["citations", "skills"]);
    zh = await workspace();
    taken = await workspace();
    fresh = await workspace();
    plain = await workspace();

    // English workspace: the four kinds of module tag.
    ids.untouched = await paperTag(fresh, "paper-review", { switchOn: true });
    ids.used = await paperTag(en, "paper-review");
    ids.renamed = await paperTag(en, "My papers", { fields: ["authors", "my_field"] });
    ids.unchangedButRenamedByPerson = await paperTag(en, "Reading list");
    ids.trashedTag = await paperTag(en, "paper-review", { deleted: true });
    ids.notModule = await paperTag(plain, "paper-review", { marked: false });
    ids.paperNote = await note(en, "A paper", BODY, ids.used);
    ids.citing = await note(en, "Citing", BODY);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'citekey', 'lee2020', 'text', 'explicit')`, [en, ids.paperNote]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'cites', 'active', 'citation')`, [en, ids.citing, ids.paperNote]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'supports', 'active', 'manual')`, [en, ids.citing, ids.paperNote]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'citations', $2), ($1, 'review', $2)`, [en, ids.used]);

    // A workspace written in Chinese: any CJK title decides the plain name.
    ids.zhUsed = await paperTag(zh, "paper-review");
    await note(zh, "一則筆記", "", ids.zhUsed);

    // The plain name is already another live tag's: keep the old name rather than collide.
    await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema) VALUES ($1, 'manual', 'class_tag', 'Paper', $2, '{}'::jsonb)`, [taken, `tag-${randomUUID()}`]);
    ids.takenUsed = await paperTag(taken, "paper-review");
    await note(taken, "n", "", ids.takenUsed);

    // A plain user tag that only carried the tag-level switch of the removed function.
    ids.switchOnly = await paperTag(en, "Switch only", { marked: false, switchOn: true, fields: [] });

    owner = await persistActor(en, owner);
    since = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
    await run();
  });

  it("a module tag with notes becomes an ordinary tag named Paper; its note, field value and text stay", async () => {
    expect(await tagRow(ids.used)).toMatchObject({ title: "Paper", mod: null, live: true, hasSwitch: false });
    expect((await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'citekey'`, [ids.paperNote])).rows[0]?.value).toBe("lee2020");
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [ids.paperNote])).rows[0]!.markdown).toBe(BODY);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [ids.citing])).rows[0]!.markdown).toBe(BODY);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [ids.paperNote, ids.used])).rowCount).toBe(1);
  });

  it("a tag never changed and with nothing on it goes to the trash through an event, so it can be restored", async () => {
    const row = await tagRow(ids.untouched);
    expect(row).toMatchObject({ mod: null, live: false, hasSwitch: false });
    const event = (await q<{ event_type: string; target_id: string; inverse: string }>(
      `SELECT event_type, target_id, tx_meta->>'inverse_op' AS inverse FROM domain_events WHERE id = $1`, [row.deletedBy])).rows[0];
    expect(event).toEqual({ event_type: "NODE_DELETED", target_id: ids.untouched, inverse: "node.undeleted" });
  });

  it("a tag the person renamed or changed keeps its name and fields, just without the module mark", async () => {
    expect(await tagRow(ids.renamed)).toMatchObject({ title: "My papers", mod: null, live: true });
    expect(await tagRow(ids.unchangedButRenamedByPerson)).toMatchObject({ title: "Reading list", mod: null, live: true });
    expect((await q<{ n: number }>(`SELECT jsonb_array_length(tag_schema->'fields')::int AS n FROM content_nodes WHERE id = $1`, [ids.renamed])).rows[0]!.n).toBe(2);
  });

  it("a trashed module tag stays in the trash, unmarked; an unmarked paper-review is not touched", async () => {
    expect(await tagRow(ids.trashedTag)).toMatchObject({ title: "paper-review", mod: null, live: false, deletedBy: null });
    expect(await tagRow(ids.notModule)).toMatchObject({ title: "paper-review", mod: null, live: true });
  });

  it("the plain name follows the workspace: 論文 with Chinese titles; kept as it was when the plain name is taken", async () => {
    expect((await tagRow(ids.zhUsed)).title).toBe("論文");
    expect(await tagRow(ids.takenUsed)).toMatchObject({ title: "paper-review", mod: null, live: true });
  });

  it("deletes the function reference, the derived citation edge and the module id in the workspace list; keeps the rest", async () => {
    expect((await q<{ f: string }>(`SELECT function_id AS f FROM function_refs WHERE holder_node_id = $1`, [ids.used])).rows.map((r) => r.f)).toEqual(["review"]);
    expect((await q<{ origin: string }>(`SELECT origin FROM node_edges WHERE workspace_id = $1 ORDER BY origin`, [en])).rows.map((r) => r.origin)).toEqual(["manual"]);
    expect((await q<{ modules_off: string[] }>(`SELECT modules_off FROM workspaces WHERE id = $1`, [en])).rows[0]!.modules_off).toEqual(["skills"]);
  });

  it("every tag that stays live has a tag event, so a client with an older sync cursor reads it again", async () => {
    const events = (await q<{ target_id: string; event_type: string }>(
      `SELECT target_id, event_type FROM domain_events WHERE workspace_id = $1 AND id > $2 AND actor_id = 'migration:193' ORDER BY id`, [en, since])).rows;
    const tagEventFor = (id: string) => events.filter((e) => e.target_id === id).map((e) => e.event_type);
    for (const id of [ids.used, ids.renamed, ids.unchangedButRenamedByPerson, ids.switchOnly]) expect(tagEventFor(id), id).toEqual(["TAG_MODULES_MIGRATED"]);
    expect(tagEventFor(ids.untouched)).toEqual([]); // that one is in a workspace of its own (fresh)
    expect(tagEventFor(ids.trashedTag)).toEqual([]); // trashed before: nothing for a client to refresh
    const delta = await buildSyncDelta(owner, en, { since, known: [] });
    const upserted = new Map(delta.nodes.upsert.map((row) => [row.id as string, row]));
    expect(upserted.get(ids.used)).toMatchObject({ title: "Paper" });
    expect(upserted.get(ids.renamed)).toMatchObject({ title: "My papers" });
    expect(upserted.get(ids.used)!.tag_schema as Record<string, unknown>).not.toHaveProperty("module");
    expect(delta.tags?.find((tag) => tag.id === ids.used)).toMatchObject({ name: "Paper" });
    expect(delta.tags?.find((tag) => tag.id === ids.switchOnly)).toBeDefined();
  });

  it("a tag sent to the trash is announced as a deletion", async () => {
    const row = await tagRow(ids.untouched);
    const events = (await q<{ event_type: string }>(`SELECT event_type FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND actor_id = 'migration:193'`, [fresh, ids.untouched])).rows;
    expect(events.map((e) => e.event_type)).toEqual(["NODE_DELETED"]);
    expect(row.live).toBe(false);
  });

  it("running it again changes nothing", async () => {
    const snapshot = async () => (await q(`SELECT id::text, title, deleted_at, updated_at, tag_schema FROM content_nodes WHERE workspace_id = ANY($1::uuid[]) ORDER BY id`, [workspaces])).rows;
    const before = await snapshot();
    const eventsBefore = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0]!.n;
    await run();
    expect(await snapshot()).toEqual(before);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0]!.n).toBe(eventsBefore);
  });
});
