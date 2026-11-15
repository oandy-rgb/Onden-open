// Deterministic 20k-note workspace for the performance benchmark.
//
//   npm run bench:seed            (from the repo root or packages/backend)
//
// The same PRNG seed gives the same rows every time (ids, text, timestamps),
// so two runs measure the same data. The target database name must end in
// `_bench`; it is dropped and rebuilt from db/schema.sql minus what a plain
// Postgres 16 cannot load (common.ts SCHEMA_SKIPS).
import pg from "pg";
import { pathToFileURL } from "node:url";
import { assertBenchDatabase, benchDatabaseUrl, makeRng, recreateBenchDatabase, type Rng } from "./common.js";

export const SEED = 20261024;
export const SEED_VERSION = "1";
export const SHAPE = {
  notes: 20_000, tags: 300, nodeTags: 40_000, attributes: 60_000, edges: 60_000, events: 150_000,
} as const;
/** Words the search benchmark looks for: one in ~40% of the notes, one in a handful. */
export const COMMON_WORD = "專案";
export const RARE_WORD = "量子糾纏";
export const RARE_WORD_NOTES = 8;
/** Fixed in the data so media / publish checks have something to point at. */
export const MEDIA_FILENAME = "bench-image.png";

const BASE_TIME = Date.UTC(2025, 5, 1);
const DAY = 86_400_000;
const BATCH = 4_000;

const ZH = [
  "今天整理了這週的進度，", "需要再確認一次資料來源，", "這個想法可以先放進收件匣，", "讀完這章之後留下幾個問題，",
  "資料結構的選擇會影響後面的實作，", "我想把筆記拆成更小的單位，", "和同學討論之後方向更清楚了，",
  "作業的截止日期是下週三，", "實驗結果和預期有一點落差，", "先寫一個最小的版本再慢慢補，", "測試通過不代表設計就是對的，",
  "演算法的時間複雜度要先算過，", "把這段程式碼重新讀了一遍，", "圖書館的自習室比較安靜，", "下次開會前要先準備好報告，",
  "這篇論文的方法值得再讀一次，", "把待辦清單依優先順序排好，", "記得備份資料並檢查是否能還原，", "網路不穩的時候要保留輸入，",
  "單元測試與整合測試各有用處，", "先釐清需求再決定架構，", "日常使用的舒適度也很重要，", "把重複的步驟寫成腳本，",
];
const EN = [
  "The design needs a clearer contract between the two modules.", "Remember to rerun the benchmark after the refactor lands.",
  "Read chapter 4 on transactions and write down three questions.", "A smaller query plan usually beats a clever index.",
  "Sketch two alternatives before committing to an interface.", "The sync cursor must never move backwards.",
  "Offline edits are queued and replayed in order.", "Keep the markdown source readable without any tooling.",
  "Tags describe what a note is, folders describe where it lives.", "Latency budgets are only useful when they are checked.",
];
const TITLE_ZH = ["學習筆記", "會議記錄", "讀書心得", "實驗紀錄", "專題想法", "週報", "待辦整理", "論文摘要", "程式設計", "資料庫", "作業討論", "復習重點"];
const TITLE_EN = ["Reading notes", "Design sketch", "Weekly review", "Lab log", "Idea", "Reference", "Meeting", "Draft"];
const ATTR_STATUS = ["todo", "doing", "done", "blocked"] as const;
const EVENT_TYPES = [
  ["NODE_UPDATED", 70], ["TAG_APPLIED", 10], ["ATTRIBUTE_SET", 10], ["EDGE_CREATED", 6], ["NODE_MOVED", 4],
] as const;

function body(rng: Rng, index: number, rareAt: ReadonlySet<number>): string {
  const target = 1000 + rng.int(1000);
  const parts: string[] = [`# ${rng.pick(TITLE_ZH)} ${index}`, ""];
  let bytes = 0;
  const common = rng.next() < 0.4;
  const rare = rareAt.has(index);
  while (bytes < target) {
    const sentences: string[] = [];
    for (let i = 0, n = 2 + rng.int(4); i < n; i++) sentences.push(rng.next() < 0.7 ? rng.pick(ZH) : ` ${rng.pick(EN)} `);
    let para = sentences.join("") + "。";
    if (parts.length === 4 && common) para += `這個${COMMON_WORD}還在進行中。`;
    if (parts.length === 6 && rare) para += `其中提到${RARE_WORD}的概念。`;
    if (rng.next() < 0.15) para = `- ${para}\n- ${rng.pick(EN)}`;
    if (rng.next() < 0.08) para = `## ${rng.pick(TITLE_EN)}\n\n${para}`;
    parts.push(para, "");
    bytes += Buffer.byteLength(para);
  }
  return parts.join("\n");
}

type Cols = Record<string, { type: string; values: unknown[] }>;

async function insertRows(c: pg.Client, table: string, cols: Cols, conflict = ""): Promise<void> {
  const names = Object.keys(cols);
  const total = cols[names[0]!]!.values.length;
  const casts = names.map((n, i) => `$${i + 1}::${cols[n]!.type}[]`).join(", ");
  const sql = `INSERT INTO ${table} (${names.join(", ")}) SELECT * FROM unnest(${casts}) ${conflict}`;
  for (let from = 0; from < total; from += BATCH) {
    await c.query(sql, names.map((n) => cols[n]!.values.slice(from, from + BATCH)));
  }
}

export type SeedSummary = { database: string; seconds: number; counts: Record<string, number> };

export async function seedBenchDatabase(url = benchDatabaseUrl(), log: (m: string) => void = console.log): Promise<SeedSummary> {
  const database = assertBenchDatabase(url);
  const started = Date.now();
  log(`[seed] rebuilding ${database} from db/schema.sql (pgroonga / vector stripped)`);
  await recreateBenchDatabase(url);
  const rng = makeRng(SEED);
  const iso = (ms: number) => new Date(ms).toISOString();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET jit = off");
    // Workspace and actors go through the schema's own triggers (default space,
    // personal space, owner), exactly as a real signup does.
    const workspaceId = rng.uuid();
    const ownerId = rng.uuid();
    const editorId = rng.uuid();
    // The schema ships an empty "default" workspace with random ids; replace it
    // so the ids are the seeded ones too.
    await c.query("DELETE FROM workspaces");
    await c.query("INSERT INTO workspaces (id, name, slug, created_at) VALUES ($1, 'Bench', 'default', $2)", [workspaceId, iso(BASE_TIME)]);
    await c.query(
      `INSERT INTO actors (id, workspace_id, name, type, external_id, created_at) VALUES
         ($1, $3, 'Bench Owner', 'human', 'bench-owner', $4), ($2, $3, 'Bench Editor', 'human', 'bench-editor', $4),
         ($5, $3, 'System', 'agent', 'system', $4)`,
      [ownerId, editorId, workspaceId, iso(BASE_TIME), rng.uuid()]);
    await c.query(
      `INSERT INTO space_members (space_id, actor_id, permission)
       SELECT s.id, a.id, 'edit' FROM spaces s, actors a WHERE s.workspace_id = $1 AND s.is_default AND a.workspace_id = $1
       ON CONFLICT (space_id, actor_id) DO NOTHING`, [workspaceId]);
    await c.query("UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1", [workspaceId, ownerId]);

    // Bulk loads skip the actor-ref check per event (the actor ids are real); the
    // membership epoch is set by hand below, as no trigger bumps it for these
    // inserts.
    await c.query("ALTER TABLE domain_events DISABLE TRIGGER domain_events_actor_ref");

    // ── tags: 300 class_tag nodes, 30 roots (every third carries a schema) ──
    const tagIds: string[] = [];
    const tagCols: Cols = {
      id: { type: "uuid", values: [] }, title: { type: "text", values: [] }, slug: { type: "text", values: [] },
      parent_id: { type: "uuid", values: [] }, tag_schema: { type: "jsonb", values: [] }, created_at: { type: "timestamptz", values: [] },
    };
    for (let i = 0; i < SHAPE.tags; i++) {
      const id = rng.uuid();
      tagIds.push(id);
      tagCols.id!.values.push(id);
      tagCols.title!.values.push(`標籤${i}`);
      tagCols.slug!.values.push(`tag-${i}`);
      tagCols.parent_id!.values.push(i < 30 ? null : tagIds[rng.int(30)]);
      tagCols.tag_schema!.values.push(i % 3 === 0 ? JSON.stringify({ name: `標籤${i}`, fields: [{ key: "status", type: "text" }], version: 1 }) : null);
      tagCols.created_at!.values.push(iso(BASE_TIME + i * 1000));
    }
    await c.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, parent_id, tag_schema, created_at, updated_at)
       SELECT id, $1, 'manual', 'class_tag', title, slug, parent_id, tag_schema, created_at, created_at
         FROM unnest($2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::jsonb[], $7::timestamptz[]) AS t(id, title, slug, parent_id, tag_schema, created_at)
        ORDER BY (parent_id IS NOT NULL)`,
      [workspaceId, ...Object.values(tagCols).map((col) => col.values)]);

    // ── notes: a tree (parents always earlier), 1–2 KB bodies ──
    const rareAt = new Set<number>();
    while (rareAt.size < RARE_WORD_NOTES) rareAt.add(1_000 + rng.int(SHAPE.notes - 1_000));
    const noteIds: string[] = [];
    const notes: Cols = {
      id: { type: "uuid", values: [] }, title: { type: "text", values: [] }, slug: { type: "text", values: [] },
      markdown: { type: "text", values: [] }, parent_id: { type: "uuid", values: [] }, sort_order: { type: "int", values: [] },
      created_at: { type: "timestamptz", values: [] }, updated_at: { type: "timestamptz", values: [] },
    };
    const childCount = new Map<string, number>();
    for (let i = 0; i < SHAPE.notes; i++) {
      const id = rng.uuid();
      noteIds.push(id);
      const parent = i < 400 ? null : noteIds[rng.int(Math.min(i, 3_000))]!;
      const siblings = childCount.get(parent ?? "root") ?? 0;
      childCount.set(parent ?? "root", siblings + 1);
      const created = BASE_TIME + Math.floor((i / SHAPE.notes) * 300 * DAY);
      notes.id!.values.push(id);
      notes.title!.values.push(`${rng.pick(TITLE_ZH)} ${i}`);
      notes.slug!.values.push(`note-${i}`);
      notes.markdown!.values.push(body(rng, i, rareAt));
      notes.parent_id!.values.push(parent);
      notes.sort_order!.values.push(siblings);
      notes.created_at!.values.push(iso(created));
      notes.updated_at!.values.push(iso(created + rng.int(60 * DAY)));
    }
    await c.query("BEGIN");
    for (let from = 0; from < SHAPE.notes; from += 1_000) {
      const slice = Object.values(notes).map((col) => col.values.slice(from, from + 1_000));
      await c.query(
        `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, sort_order, created_at, updated_at)
         SELECT id, $1, 'manual', 'content', title, slug, markdown, parent_id, sort_order, created_at, updated_at
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::int[], $8::timestamptz[], $9::timestamptz[])
                AS t(id, title, slug, markdown, parent_id, sort_order, created_at, updated_at)`,
        [workspaceId, ...slice]);
    }
    await c.query("COMMIT");

    // ── node_tags: ~40k pairs, most notes carry 1–3 tags ──
    const pairs = new Set<string>();
    const tagRows: Cols = { node_id: { type: "uuid", values: [] }, tag_id: { type: "uuid", values: [] } };
    for (let i = 0; pairs.size < SHAPE.nodeTags; i = (i + 1) % SHAPE.notes) {
      const node = noteIds[i]!;
      const tag = tagIds[rng.int(SHAPE.tags)]!;
      if (pairs.has(node + tag)) continue;
      pairs.add(node + tag);
      tagRows.node_id!.values.push(node);
      tagRows.tag_id!.values.push(tag);
    }
    await insertRows(c, "node_tags", tagRows);

    // ── attributes: ~3 per note ──
    const attrs: Cols = {
      id: { type: "uuid", values: [] }, workspace_id: { type: "uuid", values: [] }, node_id: { type: "uuid", values: [] },
      key: { type: "text", values: [] }, value: { type: "text", values: [] }, value_type: { type: "text", values: [] },
    };
    const addAttr = (node: string, key: string, value: string, type = "text") => {
      attrs.id!.values.push(rng.uuid()); attrs.workspace_id!.values.push(workspaceId); attrs.node_id!.values.push(node);
      attrs.key!.values.push(key); attrs.value!.values.push(value); attrs.value_type!.values.push(type);
    };
    for (let i = 0; attrs.id!.values.length < SHAPE.attributes; i++) {
      const node = noteIds[i % SHAPE.notes]!;
      const round = Math.floor(i / SHAPE.notes);
      if (round === 0) addAttr(node, "status", rng.pick(ATTR_STATUS));
      else if (round === 1) addAttr(node, "priority", String(1 + rng.int(5)), "number");
      else addAttr(node, "due", iso(BASE_TIME + rng.int(300) * DAY).slice(0, 10), "date");
    }
    await insertRows(c, "node_attributes", attrs);

    // ── edges: ~60k links, unique by (source, target, type, origin) ──
    const seen = new Set<string>();
    const edges: Cols = {
      id: { type: "uuid", values: [] }, workspace_id: { type: "uuid", values: [] }, source_node_id: { type: "uuid", values: [] },
      target_node_id: { type: "uuid", values: [] }, edge_type: { type: "text", values: [] }, status: { type: "text", values: [] },
    };
    while (edges.id!.values.length < SHAPE.edges) {
      const a = noteIds[rng.int(SHAPE.notes)]!;
      const b = noteIds[rng.int(SHAPE.notes)]!;
      const type = rng.next() < 0.8 ? "link" : "related";
      if (a === b || seen.has(a + b + type)) continue;
      seen.add(a + b + type);
      edges.id!.values.push(rng.uuid()); edges.workspace_id!.values.push(workspaceId);
      edges.source_node_id!.values.push(a); edges.target_node_id!.values.push(b);
      edges.edge_type!.values.push(type); edges.status!.values.push("active");
    }
    await insertRows(c, "node_edges", edges);

    // ── events: a create for every note, then edits; the last 500 hit 500
    // different notes, so the 500-event delta carries 500 upserts. ──
    const weighted = EVENT_TYPES.flatMap(([type, weight]) => Array<string>(weight).fill(type));
    const events: Cols = {
      workspace_id: { type: "uuid", values: [] }, actor_type: { type: "text", values: [] }, actor_id: { type: "text", values: [] },
      event_type: { type: "text", values: [] }, target_type: { type: "text", values: [] }, target_id: { type: "text", values: [] },
      payload: { type: "jsonb", values: [] }, created_at: { type: "timestamptz", values: [] },
    };
    const eventSpan = 400 * DAY;
    const lastDistinct = new Set<number>();
    while (lastDistinct.size < 500) lastDistinct.add(rng.int(SHAPE.notes));
    const lastTargets = [...lastDistinct];
    for (let i = 0; i < SHAPE.events; i++) {
      const fromEnd = SHAPE.events - i;
      const target = i < SHAPE.notes ? i : fromEnd <= 500 ? lastTargets[500 - fromEnd]! : rng.int(SHAPE.notes);
      const type = i < SHAPE.notes ? "NODE_CREATED" : fromEnd <= 500 ? "NODE_UPDATED" : rng.pick(weighted);
      const actor = rng.next() < 0.7 ? ownerId : editorId;
      events.workspace_id!.values.push(workspaceId);
      events.actor_type!.values.push("user");
      events.actor_id!.values.push(actor);
      events.event_type!.values.push(type);
      events.target_type!.values.push("node");
      events.target_id!.values.push(noteIds[target]!);
      events.payload!.values.push(JSON.stringify({
        node_id: noteIds[target], title: `${rng.pick(TITLE_ZH)} ${target}`, changes: { markdown: { len: 900 + rng.int(1200) } },
        note: rng.pick(ZH).repeat(3),
      }));
      events.created_at!.values.push(iso(BASE_TIME + Math.floor((i / SHAPE.events) * eventSpan)));
    }
    await insertRows(c, "domain_events", events);

    // ── one large publish snapshot: every note, with its body (tens of MB) ──
    const snapshotNodes = noteIds.map((id, i) => ({
      id, title: notes.title!.values[i], slug: notes.slug!.values[i], markdown: notes.markdown!.values[i],
      parent_id: notes.parent_id!.values[i], updated_at: notes.updated_at!.values[i],
    }));
    // The first note embeds the media file the visibility check asks about.
    snapshotNodes[0]!.markdown += `\n\n![](/api/media/${MEDIA_FILENAME})\n`;
    const lastEvent = (await c.query("SELECT max(id)::text AS id FROM domain_events")).rows[0].id as string;
    await c.query(
      `INSERT INTO publish_snapshots (id, workspace_id, title, home_node_id, event_cursor, payload, artifact_ref, created_at)
       VALUES ($1, $2, 'Bench Site', $3, $4, $5::jsonb, '/site/', $6)`,
      [rng.uuid(), workspaceId, noteIds[0], lastEvent,
        JSON.stringify({ nodes: snapshotNodes, edges: [], presentation: {} }), iso(BASE_TIME + 300 * DAY)]);

    await c.query("ALTER TABLE domain_events ENABLE TRIGGER domain_events_actor_ref");
    await c.query("UPDATE workspaces SET membership_epoch = 1, home_node_id = $2 WHERE id = $1", [workspaceId, noteIds[0]]);
    await c.query("CREATE TABLE bench_seed (version text NOT NULL, seed int NOT NULL, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, media_owner_id uuid NOT NULL)");
    await c.query("INSERT INTO bench_seed VALUES ($1, $2, $3, $4, $5)", [SEED_VERSION, SEED, workspaceId, ownerId, noteIds[0]]);
    log("[seed] analyzing");
    await c.query("VACUUM ANALYZE");

    const counts: Record<string, number> = {};
    for (const table of ["content_nodes", "node_tags", "node_attributes", "node_edges", "domain_events", "publish_snapshots", "spaces"]) {
      counts[table] = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    log(`[seed] done in ${seconds}s: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    return { database, seconds, counts };
  } finally { await c.end(); }
}

export type BenchSeedRow = { version: string; seed: number; workspace_id: string; owner_id: string; media_owner_id: string };

/** The seeded workspace, or null when the database is missing / empty / from an older seed. */
export async function readSeedRow(url = benchDatabaseUrl()): Promise<BenchSeedRow | null> {
  assertBenchDatabase(url);
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    const r = await c.query("SELECT * FROM bench_seed LIMIT 1");
    const row = r.rows[0] as BenchSeedRow | undefined;
    return row && row.version === SEED_VERSION && row.seed === SEED ? row : null;
  } catch { return null; } finally { await c.end().catch(() => {}); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  seedBenchDatabase().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
