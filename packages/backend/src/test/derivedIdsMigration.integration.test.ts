// Migration 201: things Onden makes by itself (capture / skills / site-settings / page tags, the site settings note, the system,
// default and personal spaces) get an id computed from what they are for, and every reference to the old id follows.
// One fixture is built the way an older server left it (random ids, references of every kind), the migration's own preview
// is run on it, the migration is run, and each test reads the result. `rerunMigration` is the repo's helper for that.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_NOTE_NAMESPACE, TASKS_NOTE_TITLE, dayNoteIdName, derivedIdName } from "@onden/markdown";
import { uuidV5 } from "../utils.js";
import { pool, q } from "../db.js";
import { derivedId } from "../services/derivedIds.js";
import { appendToDayNote } from "../services/dayNotes.js";
import { persistActor } from "./helpers/persistActor.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";

const MIGRATION = "201_derived_ids_function_ref_stamps";
const sqlText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations", `${MIGRATION}.sql`), "utf8");

/** The preview query in the migration's header (comment lines `--   ...` after the `part` line, up to the next bare `--`). */
function previewQuery(): string {
  const lines = sqlText.split("\n");
  const from = lines.findIndex((l) => l.includes("`part` = rows | left untouched | references")) + 2;
  const out: string[] = [];
  for (let i = from; i < lines.length && lines[i] !== "--"; i++) out.push(lines[i]!.replace(/^--   ?/, ""));
  return out.join("\n");
}

type PreviewRow = { part: string; what: string; will_change: string | null; already_derived: string | null; left_untouched: string | null; ids: string | null; reason: string | null };

const isTestDb = isTestDatabase();
const uuid = () => randomUUID();

describe.skipIf(!isTestDb)("migration 201: derived ids for what Onden makes by itself", () => {
  const tag = randomUUID().slice(0, 8);
  let wsA = ""; let wsB = ""; let wsC = "";
  let ada!: ActorCtx;
  const old = {
    capture: uuid(), skills: uuid(), config: uuid(), page: uuid(), note: uuid(), system: uuid(), defaultSpace: uuid(), personal: uuid(),
    child: uuid(), user: uuid(), ext: uuid(),
  };
  // ids a space gives its tasks note and a day's note (dayNoteIdName): derived from the space id, so they follow it
  const dayId = (space: string, name: string) => uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(space, name));
  // workspace B: the cases the migration must not guess
  const bad = { captureOne: uuid(), captureTwo: uuid(), skills: uuid(), takenBy: "" };
  const references = { subscription: uuid(), session: uuid() };
  let preview: PreviewRow[] = [];
  let untouchedBefore = "";
  let epochBefore: Record<string, string> = {};
  let contentBefore: Record<string, string> = {};

  const idsOf = (obj: Record<string, string>) => Object.values(obj).filter((v) => v !== "");
  const epoch = async (ws: string) => (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [ws])).rows[0]!.e;
  const dump = async (sql: string, params: unknown[] = []) => (await q<{ d: string }>(`SELECT COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS d FROM (${sql}) x`, params)).rows[0]!.d;

  async function newWorkspace(name: string): Promise<string> {
    return (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${tag}`])).rows[0]!.id;
  }
  /** A tag or note an older server made: a random id, and the row a current writer would make. */
  async function oldRow(ws: string, id: string, kind: "tag" | "note", over: { title: string; slug: string; schema?: unknown; reservedKey?: string; space?: string | null; hidden?: boolean; sourceType?: string }) {
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, tag_schema, reserved_key, space_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [id, ws, over.sourceType ?? "manual", kind === "tag" ? "class_tag" : "content", over.title, over.slug, kind === "note" ? "settings body" : "", over.hidden ?? false,
        over.schema ? JSON.stringify(over.schema) : null, over.reservedKey ?? null, over.space ?? null]);
  }

  beforeAll(async () => {
    wsA = await newWorkspace("derived-a"); wsB = await newWorkspace("derived-b"); wsC = await newWorkspace("derived-c");
    ada = await persistActor(wsA, { id: "", name: `Ada ${tag}`, role: "admin", type: "human" });
    const agent = await persistActor(wsA, { id: "", name: `Bot ${tag}`, role: "editor", type: "agent" });

    // the three spaces of workspace A, with the ids an older server gave them
    const dA = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsA])).rows[0]!.id;
    expect(dA).toBe(derivedId(derivedIdName.defaultSpace(wsA))); // what the database makes now
    const pA = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [wsA, ada.id])).rows[0]!.id;
    expect(pA).toBe(derivedId(derivedIdName.personalSpace(wsA, ada.id)));
    await seedQ(`INSERT INTO spaces (id, workspace_id, name, kind, capabilities) VALUES ($1, $2, 'system', 'system', '{}'::jsonb)`, [old.system, wsA]);
    // (their members are taken off while the id changes and put back under the new one)
    for (const [from, to] of [[dA, old.defaultSpace], [pA, old.personal]] as const) {
      const members = (await q<{ actor_id: string; permission: string }>(`SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [from])).rows;
      await seedQ(`DELETE FROM space_members WHERE space_id = $1`, [from]);
      await seedQ(`UPDATE spaces SET id = $2 WHERE id = $1`, [from, to]);
      for (const m of members) await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, $3)`, [to, m.actor_id, m.permission]);
    }

    // tags and the settings note, as an older server made them
    await oldRow(wsA, old.capture, "tag", { title: "收件匣", slug: `module-${old.capture}`, schema: { module: "capture", extends: [], name: "收件匣" } });
    await oldRow(wsA, old.skills, "tag", { title: "skill", slug: `module-${old.skills}`, schema: { module: "skills" } });
    await oldRow(wsA, old.config, "tag", { title: "workspace-config", slug: `tag-workspace-config-${old.config.slice(0, 6)}`, reservedKey: "workspace-config" });
    await oldRow(wsA, old.page, "tag", { title: "page", slug: `tag-page-${old.page.slice(0, 6)}`, reservedKey: "page" });
    await oldRow(wsA, old.note, "note", { title: "Site Config", slug: "_workspace_config", hidden: true, sourceType: "system", space: old.system });
    // notes that refer to them
    await oldRow(wsA, old.user, "note", { title: "A person's note", slug: `user-${tag}`, space: old.personal });
    // the tasks note and a day's note of the personal space, under the ids the OLD space id gives them; and a renamed one that only its id identifies
    await oldRow(wsA, dayId(old.personal, TASKS_NOTE_TITLE), "note", { title: TASKS_NOTE_TITLE, slug: `tasks-${tag}`, space: old.personal });
    await oldRow(wsA, dayId(old.personal, "2026-11-01"), "note", { title: "2026-11-01", slug: `day-${tag}`, space: old.personal });
    await oldRow(wsA, dayId(old.defaultSpace, TASKS_NOTE_TITLE), "note", { title: "my own name for it", slug: `renamed-tasks-${tag}`, space: old.defaultSpace });
    await oldRow(wsA, old.child, "tag", { title: "child of capture", slug: `child-${tag}` });
    await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [old.capture, old.child]);
    // a tag that extends the capture tag by id (inside its JSON), and a reference of a function to it
    await oldRow(wsA, old.ext, "tag", { title: "extends capture", slug: `ext-${tag}`, schema: { extends: [old.capture], fields: [{ name: "x" }] } });

    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2), ($3, $2), ($1, $4)`, [old.user, old.capture, old.note, old.config]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES
                 ($1, $2, 'brand', 'Onden', 'text', 'ui'), ($1, $3, 'pointer', $4, 'node_ref', 'ui'), ($1, $3, 'plain_text', $5, 'text', 'ui')`,
      [wsA, old.note, old.user, old.capture, "left alone: not the whole value"]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'mark', $2, $3::jsonb)`, [wsA, old.ext, JSON.stringify({ source_tag_id: old.capture, keep: "yes" })]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_space_id, config) VALUES ($1, 'on_space', $2, '{}'::jsonb)`, [wsA, old.defaultSpace]);
    await seedQ(`INSERT INTO rss_subscriptions (id, workspace_id, space_id, title, url, auto_tag_id, default_tag_ids, default_parent_id) VALUES ($1, $2, $3, 'Feed', 'https://example.test/feed.xml', $4, ARRAY[$4::uuid, $5::uuid], $6)`,
      [references.subscription, wsA, old.defaultSpace, old.capture, old.skills, old.child]);
    await seedQ(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, $3::jsonb)`, [ada.id, old.capture, JSON.stringify({ own: old.capture })]);
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, $2, $3::jsonb)`, [ada.id, `p-${tag}`, JSON.stringify({ lastSpace: old.personal })]);
    // text that mentions an id, and a job still waiting that names one: not changed, but the preview counts them
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [old.user, `see [[onden://node/${old.capture}]]`]);
    await seedQ(`INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status) VALUES ($1, 'embed', $2, $3::jsonb, 'pending')`, [wsA, `embed:${old.note}`, JSON.stringify({ nodeId: old.note })]);
    await seedQ(`INSERT INTO node_event_meta (node_id, actor_id, last_event_at) VALUES ($1, $2, now())`, [old.note, ada.id]);
    await seedQ(`UPDATE workspaces SET home_node_id = $2 WHERE id = $1`, [wsA, old.note]);
    await seedQ(`INSERT INTO agent_sessions (id, workspace_id, agent_actor_id, initiator_id, node_id, space_id, prompt, deadline_at, scope_tag_ids)
                 VALUES ($1, $2, $3, $4, $5, $6, 'p', now() + interval '1 hour', ARRAY[$7::uuid])`,
      [references.session, wsA, agent.id, ada.id, old.user, old.personal, old.capture]);
    // history that stays where it was written
    await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload) VALUES ($1, 'user', $2, 'NODE_UPDATED', 'node', $3, '{}'::jsonb)`,
      [wsA, ada.id, old.note]);

    // workspace B: two capture tags (which one is it?), a skills tag whose derived id belongs to something else
    bad.takenBy = derivedId(derivedIdName.moduleTag(wsB, "skills"));
    await oldRow(wsB, bad.captureOne, "tag", { title: "收件匣", slug: `module-${bad.captureOne}`, schema: { module: "capture" } });
    await oldRow(wsB, bad.captureTwo, "tag", { title: "捕捉", slug: `module-${bad.captureTwo}`, schema: { module: "capture" } });
    await oldRow(wsB, bad.skills, "tag", { title: "skill", slug: `module-${bad.skills}`, schema: { module: "skills" } });
    await oldRow(wsB, bad.takenBy, "note", { title: "Somebody's note", slug: `taken-${tag}` });

    untouchedBefore = await dump(`SELECT * FROM content_nodes WHERE workspace_id IN ($1, $2)`, [wsB, wsC]);
    epochBefore = { a: await epoch(wsA), b: await epoch(wsB), c: await epoch(wsC) };
    contentBefore = Object.fromEntries((await q<{ s: string; t: string }>(
      `SELECT slug AS s, md5(title || '|' || markdown || '|' || slug || '|' || COALESCE(reserved_key, '') || '|' || node_type) AS t FROM content_nodes WHERE workspace_id = $1`, [wsA])).rows.map((r) => [r.s, r.t]));

    preview = (await q<PreviewRow>(previewQuery())).rows;
    await rerunMigration(MIGRATION);
  }, 60_000);
  afterAll(async () => { await pool.end(); });

  const counts = (what: string) => preview.find((r) => r.part === "rows" && r.what === what);
  const refs = (what: string) => Number(preview.find((r) => r.part === "references" && r.what === what)?.will_change ?? 0);

  it("the preview says, per purpose, how many rows change, and lists the rows it will leave alone with the reason", () => {
    // (the database holds other tests' rows too: these are lower bounds from this file's workspaces, exact for the left-untouched list)
    expect(Number(counts("capture tag")!.will_change)).toBeGreaterThanOrEqual(1);
    for (const what of ["skills tag", "site settings tag", "page tag", "site settings note", "system space", "default space", "personal space"]) {
      expect(Number(counts(what)!.will_change), what).toBeGreaterThanOrEqual(1);
    }
    const left = preview.filter((r) => r.part === "left untouched").map((r) => `${r.what}|${r.ids}|${r.reason}`);
    expect(left).toEqual(expect.arrayContaining([
      `capture tag|${bad.captureOne}|several_candidates`, `capture tag|${bad.captureTwo}|several_candidates`, `skills tag|${bad.skills}|new_id_taken`,
    ]));
  });

  it("the preview counts the references of every kind that the migration then updates", () => {
    expect(refs("node_tags.tag_id")).toBeGreaterThanOrEqual(2); // capture + config on notes
    expect(refs("node_tags.node_id")).toBeGreaterThanOrEqual(1); // the settings note
    expect(refs("content_nodes.parent_id")).toBeGreaterThanOrEqual(1);
    expect(refs("content_nodes.space_id")).toBeGreaterThanOrEqual(2);
    expect(refs("function_refs.holder_space_id")).toBeGreaterThanOrEqual(1);
    expect(refs("rss_subscriptions.default_tag_ids")).toBeGreaterThanOrEqual(1);
    expect(refs("agent_sessions.scope_tag_ids")).toBeGreaterThanOrEqual(1);
    expect(refs("agent_sessions.space_id")).toBeGreaterThanOrEqual(1);
    expect(refs("node_attributes.value")).toBeGreaterThanOrEqual(1);
    expect(refs("content_nodes.tag_schema (inside the JSON)")).toBeGreaterThanOrEqual(1);
    expect(refs("function_refs.config (inside the JSON)")).toBeGreaterThanOrEqual(1);
    expect(refs("actor_prefs.value (inside the JSON)")).toBeGreaterThanOrEqual(1);
    expect(refs("node_event_meta.node_id")).toBeGreaterThanOrEqual(1);
    expect(refs("sync_stamps.row_key")).toBeGreaterThanOrEqual(1);
  });

  it("the preview also counts what is left as it is: note text that mentions an id, and jobs still waiting", () => {
    const left = (what: string) => Number(preview.find((r) => r.part === "left as is" && r.what.startsWith(what))?.will_change ?? 0);
    expect(left("content_nodes.markdown")).toBeGreaterThanOrEqual(1);
    expect(left("outbox.payload")).toBeGreaterThanOrEqual(1);
  });

  it("the preview runs on a database that has not had 201 yet (no function of the migration) and inside a read-only transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // as production is before the upgrade: the migration's functions do not exist
      await client.query("DROP FUNCTION onden_space_id(text)");
      await client.query("DROP FUNCTION onden_uuid5(uuid, text)");
      await client.query("SET TRANSACTION READ ONLY");
      const rows = (await client.query<PreviewRow>(previewQuery())).rows;
      // the derivation written out in the preview gives the ids the migration really made: what it rewrote reads as already derived
      const already = (what: string) => Number(rows.find((r) => r.part === "rows" && r.what === what)?.already_derived ?? 0);
      expect(already("capture tag")).toBeGreaterThanOrEqual(1);
      expect(already("personal space")).toBeGreaterThanOrEqual(1);
      expect(already("tasks note")).toBe(0); // (its ids are not candidates once the space has its derived id)
      await expect(client.query("CREATE TABLE preview_must_not_write (x int)")).rejects.toThrow(/read-only/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("every foreign key to a note or a space is in the preview, so a place the migration moves is never missing from the numbers", async () => {
    const fks = (await q<{ t: string; c: string }>(
      `SELECT c.conrelid::regclass::text AS t, a.attname AS c FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid IN ('content_nodes'::regclass, 'spaces'::regclass)`)).rows;
    expect(fks.length).toBeGreaterThan(30);
    const header = previewQuery();
    for (const { t, c } of fks) expect(header, `${t}.${c}`).toContain(`'${t}.${c}'`);
  });

  it("each purpose now has the derived id, the same one the TypeScript side computes", async () => {
    const at = async (table: string, id: string) => (await q(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows.length;
    expect(await at("content_nodes", derivedId(derivedIdName.moduleTag(wsA, "capture")))).toBe(1);
    expect(await at("content_nodes", derivedId(derivedIdName.moduleTag(wsA, "skills")))).toBe(1);
    expect(await at("content_nodes", derivedId(derivedIdName.reservedTag(wsA, "workspace-config")))).toBe(1);
    expect(await at("content_nodes", derivedId(derivedIdName.reservedTag(wsA, "page")))).toBe(1);
    expect(await at("content_nodes", derivedId(derivedIdName.siteConfigNote(wsA)))).toBe(1);
    expect(await at("spaces", derivedId(derivedIdName.systemSpace(wsA)))).toBe(1);
    expect(await at("spaces", derivedId(derivedIdName.defaultSpace(wsA)))).toBe(1);
    expect(await at("spaces", derivedId(derivedIdName.personalSpace(wsA, ada.id)))).toBe(1);
    for (const id of idsOf({ ...old }).filter((id) => !["child", "user", "ext"].some((k) => (old as Record<string, string>)[k] === id))) {
      expect(await at("content_nodes", id) + await at("spaces", id), `old id ${id} is gone`).toBe(0);
    }
  });

  it("the SQL derivation and the TypeScript one agree", async () => {
    const names = [derivedIdName.moduleTag(wsA, "capture"), derivedIdName.personalSpace(wsA, ada.id), "名稱 with ünïcode/and slash"];
    for (const name of names) {
      const sql = (await q<{ id: string }>(`SELECT onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', $1)::text AS id`, [name])).rows[0]!.id;
      expect(sql).toBe(derivedId(name));
    }
  });

  it("every reference of every kind follows the id; nothing but the append-only history still holds an old one", async () => {
    const olds = [old.capture, old.skills, old.config, old.page, old.note, old.system, old.defaultSpace, old.personal];
    const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    const holders: string[] = [];
    for (const t of tables) {
      // (a slug is a name, not a reference: slugs such as module-<old id> and note text are kept as they are, see the migration's header)
      const row = t === "content_nodes" ? "(to_jsonb(x) - 'slug' - 'markdown')::text" : "x::text";
      const n = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" x WHERE ${row} LIKE ANY($1::text[])`, [olds.map((id) => `%${id}%`)])).rows[0]!.n;
      if (n > 0) holders.push(t);
    }
    // domain_events and structure_log are append-only by trigger: the history of a rewritten row stays under the id it was written with.
    // (workspace B's rows are the cases that were left alone, and they never held these ids.)
    // id_rewrites is the old -> new record itself; outbox is the waiting job this test planted (the preview counts it); note text is content.
    expect(holders.sort()).toEqual(["domain_events", "id_rewrites", "outbox", "structure_log"]);
  });

  it("the references hold the NEW ids, in the form they had (a list stays a list, a whole value stays a whole value)", async () => {
    const cap = derivedId(derivedIdName.moduleTag(wsA, "capture"));
    const skills = derivedId(derivedIdName.moduleTag(wsA, "skills"));
    const cfg = derivedId(derivedIdName.reservedTag(wsA, "workspace-config"));
    const note = derivedId(derivedIdName.siteConfigNote(wsA));
    const sys = derivedId(derivedIdName.systemSpace(wsA));
    const def = derivedId(derivedIdName.defaultSpace(wsA));
    const personal = derivedId(derivedIdName.personalSpace(wsA, ada.id));
    const one = async (sql: string, params: unknown[] = []) => (await q<{ v: unknown }>(sql, params)).rows[0]!.v;
    expect(await one(`SELECT parent_id::text AS v FROM content_nodes WHERE id = $1`, [old.child])).toBe(cap);
    expect(await one(`SELECT space_id::text AS v FROM content_nodes WHERE id = $1`, [old.user])).toBe(personal);
    expect(await one(`SELECT space_id::text AS v FROM content_nodes WHERE id = $1`, [note])).toBe(sys);
    expect(await one(`SELECT array_agg(tag_id::text ORDER BY tag_id::text) AS v FROM node_tags WHERE node_id IN ($1, $2)`, [old.user, note])).toEqual([cap, cap, cfg].sort());
    expect(await one(`SELECT value AS v FROM node_attributes WHERE node_id = $1 AND key = 'pointer'`, [old.user])).toBe(cap);
    expect(await one(`SELECT value AS v FROM node_attributes WHERE node_id = $1 AND key = 'plain_text'`, [old.user])).toBe("left alone: not the whole value");
    expect(await one(`SELECT tag_schema->'extends'->>0 AS v FROM content_nodes WHERE id = $1`, [old.ext])).toBe(cap);
    expect(await one(`SELECT jsonb_array_length(tag_schema->'fields')::int AS v FROM content_nodes WHERE id = $1`, [old.ext])).toBe(1);
    expect(await one(`SELECT config AS v FROM function_refs WHERE holder_node_id = $1`, [old.ext])).toEqual({ source_tag_id: cap, keep: "yes" });
    expect(await one(`SELECT holder_space_id::text AS v FROM function_refs WHERE function_id = 'on_space' AND workspace_id = $1`, [wsA])).toBe(def);
    expect(await one(`SELECT to_jsonb(ARRAY[space_id::text, auto_tag_id::text]) || to_jsonb(default_tag_ids) AS v FROM rss_subscriptions WHERE id = $1`, [references.subscription])).toEqual([def, cap, cap, skills]);
    expect(await one(`SELECT settings AS v FROM actor_module_settings WHERE actor_id = $1 AND tag_id = $2`, [ada.id, cap])).toEqual({ own: cap });
    expect(await one(`SELECT value AS v FROM actor_prefs WHERE actor_id = $1 AND key = $2`, [ada.id, `p-${tag}`])).toEqual({ lastSpace: personal });
    expect(await one(`SELECT count(*)::int AS v FROM node_event_meta WHERE node_id = $1`, [note])).toBe(1);
    expect(await one(`SELECT home_node_id::text AS v FROM workspaces WHERE id = $1`, [wsA])).toBe(note);
    expect(await one(`SELECT space_id::text AS v FROM agent_sessions WHERE id = $1`, [references.session])).toBe(personal);
    expect(await one(`SELECT scope_tag_ids::text[] AS v FROM agent_sessions WHERE id = $1`, [references.session])).toEqual([cap]);
    expect(await one(`SELECT count(*)::int AS v FROM space_members WHERE space_id IN ($1, $2) AND actor_id = $3`, [def, personal, ada.id])).toBe(2);
  });

  it("a space's tasks note follows the space (its id is what the NEW space id gives, a renamed one too); day notes stay, and are still found by title", async () => {
    const personal = derivedId(derivedIdName.personalSpace(wsA, ada.id));
    const def = derivedId(derivedIdName.defaultSpace(wsA));
    const at = async (id: string) => (await q<{ title: string; space_id: string }>(`SELECT title, space_id::text FROM content_nodes WHERE id = $1`, [id])).rows[0];
    expect(await at(dayId(personal, TASKS_NOTE_TITLE))).toEqual({ title: TASKS_NOTE_TITLE, space_id: personal });
    expect(await at(dayId(def, TASKS_NOTE_TITLE))).toEqual({ title: "my own name for it", space_id: def });
    for (const gone of [dayId(old.personal, TASKS_NOTE_TITLE), dayId(old.defaultSpace, TASKS_NOTE_TITLE)]) expect(await at(gone)).toBeUndefined();
    expect(preview.find((r) => r.part === "rows" && r.what === "tasks note")).toBeTruthy();
    expect(preview.find((r) => r.part === "rows" && r.what === "day note")).toBeUndefined();
    // the day note keeps its id (derived from the old space), now sits in the space under its new id, and the server still finds it by title
    const dayOld = dayId(old.personal, "2026-11-01");
    expect(await at(dayOld)).toEqual({ title: "2026-11-01", space_id: personal });
    expect(await appendToDayNote(ada, wsA, "2026-11-01", "written after the rewrite")).toBe(true);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [dayOld])).rows[0]!.markdown).toContain("written after the rewrite");
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND title = '2026-11-01'`, [wsA, personal])).rows).toHaveLength(1);
  });

  it("who last changed a row follows it: its stamps, and a stamp whose key holds the id with another", async () => {
    const cap = derivedId(derivedIdName.moduleTag(wsA, "capture"));
    const stamps = (await q<{ table_name: string; row_key: string }>(`SELECT table_name, row_key FROM sync_stamps WHERE workspace_id = $1`, [wsA])).rows;
    expect(stamps.some((s) => s.table_name === "content_nodes" && s.row_key === cap)).toBe(true);
    expect(stamps.some((s) => s.row_key.includes(old.capture))).toBe(false);
    expect(stamps.some((s) => s.table_name === "node_tags" && s.row_key.endsWith(`/${cap}`))).toBe(true);
  });

  it("only ids change: the title, text, slug, reserved key and kind of every row are what they were", async () => {
    const after = Object.fromEntries((await q<{ t: string; s: string }>(
      `SELECT md5(title || '|' || markdown || '|' || slug || '|' || COALESCE(reserved_key, '') || '|' || node_type) AS t, slug AS s FROM content_nodes WHERE workspace_id = $1`, [wsA])).rows.map((r) => [r.s, r.t]));
    // (the day note is left out: another test appends to it, which is a change of content on purpose)
    const { [`day-${tag}`]: _dayAfter, ...afterRest } = after;
    const { [`day-${tag}`]: _dayBefore, ...beforeRest } = contentBefore;
    expect(afterRest).toEqual(beforeRest);
    expect(Object.keys(after).length).toBe(11);
  });

  it("rows with two candidates, or whose derived id is taken, and everything in a workspace with nothing to move, are untouched", async () => {
    expect(await dump(`SELECT * FROM content_nodes WHERE workspace_id IN ($1, $2)`, [wsB, wsC])).toBe(untouchedBefore);
    for (const id of [bad.captureOne, bad.captureTwo, bad.skills, bad.takenBy]) expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rows).toHaveLength(1);
  });

  it("devices re-read what they may see: the workspace that changed gets a new membership epoch, the others keep theirs", async () => {
    expect(Number(await epoch(wsA))).toBeGreaterThan(Number(epochBefore.a));
    expect(await epoch(wsB)).toBe(epochBefore.b);
    expect(await epoch(wsC)).toBe(epochBefore.c);
  });

  it("running it again changes nothing", async () => {
    const snapshot = async () => [
      await dump(`SELECT * FROM content_nodes`), await dump(`SELECT * FROM spaces`), await dump(`SELECT * FROM node_tags`), await dump(`SELECT * FROM function_refs`),
      await dump(`SELECT * FROM space_members`), await dump(`SELECT workspace_id, table_name, row_key, field FROM sync_stamps`),
      await dump(`SELECT id, membership_epoch FROM workspaces`),
    ];
    const first = await snapshot();
    await rerunMigration(MIGRATION);
    expect(await snapshot()).toEqual(first);
  });

  it("the foreign keys and triggers are back as they were: not deferrable, enabled, and a bad reference is refused again", async () => {
    const deferrable = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND condeferrable AND confrelid IN ('content_nodes'::regclass, 'spaces'::regclass)`)).rows[0]!.n;
    expect(deferrable).toBe(0);
    const off = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'`)).rows[0]!.n;
    expect(off).toBe(0);
    await expect(seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [uuid(), uuid()])).rejects.toThrow();
  });

  it("a space the database makes from now on has the derived id, and a deleted personal space of the same person does not stop a new one", async () => {
    const ws = await newWorkspace("derived-d");
    expect((await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id).toBe(derivedId(derivedIdName.defaultSpace(ws)));
    const bob = await persistActor(ws, { id: "", name: `Bob ${tag}`, role: "editor", type: "human" });
    const mine = derivedId(derivedIdName.personalSpace(ws, bob.id));
    expect((await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [bob.id])).rows[0]!.id).toBe(mine);
    // the derived id is taken by a deleted space of his: a second personal space would be made under another id
    await seedQ(`UPDATE spaces SET deleted_at = now() WHERE id = $1`, [mine]);
    const next = (await q<{ id: string }>(`SELECT onden_space_id($1)::text AS id`, [derivedIdName.personalSpace(ws, bob.id)])).rows[0]!.id;
    expect(next).not.toBe(mine);
    expect(next).toMatch(/^[0-9a-f-]{36}$/);
  });
});
