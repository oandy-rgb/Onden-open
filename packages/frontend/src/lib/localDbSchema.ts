import type { Database } from "sql.js";
import { CLIENT_PROTOCOL } from "@onden/markdown/contract";
import { evenOrderKey } from "@onden/markdown/contract";
import { LocalDbError } from "./localDbErrors";
import { migrateWorkspaceMirror } from "./workspaceMirror";
import { migrateTaskMirror } from "./taskMirror";

/** One schema upgrade path for cold startup and imported older local vaults.
 * Prepare a candidate before installing it as the active database. */
export function prepareLocalDatabase(database: Database): void {
  refuseCopyFromNewerBuild(database);
  database.run(`CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    home_node_id TEXT,
    actor_role TEXT
  )`);
  migrateWorkspaceMirror(database);
  database.run(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    node_type TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    markdown TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    presentation TEXT,
    tag_schema TEXT,
    class_tag_ids TEXT,
    label_tag_ids TEXT,
    updated_at TEXT
  )`);
  // Existing local DBs predate the tag columns — without them an offline cold
  // start loses class-tag identity: collection items (class_tag_ids) mix into the
  // note feeds and tag optimistic updates misclassify (storeOps reads tag_schema).
  // sqlite has no ADD COLUMN IF NOT EXISTS; the throw on "already exists" is the no-op.
  // body_len: the server body's length. With markdown '' it tells "not yet
  // downloaded" (> 0) from "really empty" (0); NULL on rows from older builds.
  // space_id: the note's space (docs/architecture/spaces.md); NULL for tags.
  // created_at: the tie-break of sibling order (lib/childOrder), so an offline
  // boot lists children as online does; NULL on rows from older builds.
  // collection_views: the note's saved views (JSON). Without them a cached note
  // forgets its whiteboard tab, so a board opened from this copy shows 內容
  // instead of its whiteboard (lib/viewTabs defaultTabKey).
  for (const col of ["tag_schema TEXT", "class_tag_ids TEXT", "label_tag_ids TEXT", "body_len INTEGER", "space_id TEXT", "created_at TEXT", "collection_views TEXT"]) {
    try { database.run(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch { /* column exists */ }
  }
  migratePlaceKeys(database);
  database.run(`CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    status TEXT NOT NULL
  )`);
  // origin (D74): who made the edge — "manual" or what the server derives it
  // from ("wikilink", "citation", "semantic"); lib/edgeRoles reads it to tell
  // a [[link]]'s arrow from a drawn one. NULL on rows from older builds until
  // the next bootstrap rewrites them.
  try { database.run("ALTER TABLE edges ADD COLUMN origin TEXT"); } catch { /* column exists */ }
  database.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    node_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo'
  )`);
  migrateTaskMirror(database);
  // Canvas offline mirror. A canvas IS a node (mig 057) so its node row already
  // rides the `nodes` mirror, but the canvas LIST metadata + the layout blob
  // (card positions = node_positions server-side, surfaced as CanvasData.data)
  // are served ONLY by GET /api/canvases[/:id] and never travel through /api/sync
  // — so without this table an offline-created/edited canvas vanishes on a cold
  // reload before the queue drains. `data` is the JSON CanvasData; NULL means
  // "meta only, layout not fetched yet" (list rows carry no layout).
  database.run(`CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    data TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  // Sidebar pointers (extra tree positions). Mirrored so pins survive an
  // offline cold start and /api/sync can retire removed ones.
  database.run(`CREATE TABLE IF NOT EXISTS pointers (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    target_id TEXT NOT NULL,
    display_prefix TEXT
  )`);
  migratePlaceKeys(database);
  // The boards each note is on ("Appears on canvases") and hand-placed
  // global-graph positions (D98): the bootstrap's canvas_memberships and
  // graph_positions, so an offline warm start shows them too. Memberships
  // follow the sync delta (lib/canvasMemberships.ts); positions follow each
  // bootstrap and this device's own placements.
  database.run(`CREATE TABLE IF NOT EXISTS canvas_memberships (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    canvas_title TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (canvas_id, node_id)
  )`);
  database.run("CREATE INDEX IF NOT EXISTS idx_canvas_memberships_node ON canvas_memberships(node_id)");
  database.run(`CREATE TABLE IF NOT EXISTS graph_positions (
    node_id TEXT PRIMARY KEY,
    x REAL NOT NULL,
    y REAL NOT NULL
  )`);
  // Paragraph anchors of the notes held here (docs/architecture/proposals/block-anchors-2026-11-01.md):
  // where each paragraph is, as the server last said. Shipped whole per note (bootstrap, sync delta) and
  // removed with the note, so what a revoked reader held goes with it. Nothing is written by this device.
  database.run(`CREATE TABLE IF NOT EXISTS note_anchors (
    anchor_id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    pos_from INTEGER NOT NULL,
    pos_to INTEGER NOT NULL,
    status TEXT NOT NULL,
    cand_from INTEGER,
    cand_to INTEGER
  )`);
  database.run("CREATE INDEX IF NOT EXISTS idx_note_anchors_note ON note_anchors(note_id)");
  // The words the paragraph had when last confirmed: what a link shows when the paragraph is gone or not here.
  try { database.run("ALTER TABLE note_anchors ADD COLUMN quote TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
  // Which anchor each `[[筆記/段落]]` link written in a held note means (block_link_bindings on the server).
  database.run(`CREATE TABLE IF NOT EXISTS note_link_bindings (
    note_id TEXT NOT NULL,
    link_text TEXT NOT NULL,
    anchor_id TEXT NOT NULL,
    PRIMARY KEY (note_id, link_text)
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    suggestion_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    reasoning TEXT
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  database.run(`CREATE TABLE IF NOT EXISTS pending_writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    body TEXT,
    idem_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Existing local DBs predate idem_key — sqlite has no ADD COLUMN IF NOT
  // EXISTS, so probe-and-alter (the throw on "already exists" is the no-op).
  try { database.run("ALTER TABLE pending_writes ADD COLUMN idem_key TEXT"); } catch { /* column exists */ }
  // Transient failures remain pending; the counter only controls warnings.
  try { database.run("ALTER TABLE pending_writes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
  // A terminal server rejection retains the original input for recovery,
  // separately from pending replay and from the readable content mirror.
  try { database.run("ALTER TABLE pending_writes ADD COLUMN rejection TEXT"); } catch { /* column exists */ }
  // The entities a write acts on (JSON WriteTarget[]), recorded when queued
  // (D45). Rows from older builds keep NULL and are decoded from the request.
  try { database.run("ALTER TABLE pending_writes ADD COLUMN targets TEXT"); } catch { /* column exists */ }
  // When the row was made (microseconds since 1970): the queue's order across tabs (localDbWorker.queuedAt).
  // Rows from older builds keep NULL and sort first, in id order, as they did.
  try { database.run("ALTER TABLE pending_writes ADD COLUMN made_at INTEGER"); } catch { /* column exists */ }
  // Mirrors backend node_attributes. Keyed by (node_id, key); value carries
  // the typed string + value_type tag so we can round-trip exact values
  // (booleans-as-text "true"/"false", dates ISO strings, etc).
  database.run(`CREATE TABLE IF NOT EXISTS node_attributes (
    node_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'text',
    is_inheritable INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'explicit',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, key)
  )`);
  // Indexes for the columns the read paths filter/join on. Without these every
  // lookup is a full table scan — sub-ms at hundreds of rows, visibly slow at
  // tens of thousands. (node_attributes(node_id) is already the leftmost PK
  // column, so it needs no separate index.)
  database.run("CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_nodes_node_type ON nodes(node_type)");
  database.run("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_tasks_node_id ON tasks(node_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_pointers_parent ON pointers(parent_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_pointers_target ON pointers(target_id)");
  try {
    database.run(`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      title,
      markdown,
      tokenize='trigram'
    )`);
    const [nc] = database.exec("SELECT count(*) as nc FROM nodes");
    const [fc] = database.exec("SELECT count(*) as fc FROM nodes_fts");
    const nodeCount = (nc?.values?.[0]?.[0] as number) ?? 0;
    const ftsCount = (fc?.values?.[0]?.[0] as number) ?? 0;
    if (nodeCount > 0 && ftsCount === 0) {
      database.run("INSERT INTO nodes_fts(id, title, markdown) SELECT id, title, markdown FROM nodes");
    }
  } catch {
    // FTS5 unavailable — search falls back to LIKE
  }
  stampMirrorSchema(database);
  stampCopyProtocol(database);
}

/** Order keys (server migration 200). A copy made before them has the integer `sort_order` and no key: the column is
 *  added and every row gets a key in the order older builds listed it (sort_order, then created_at, then id) — only when
 *  the column was just added, so a row written later with no key (a note not yet answered by the server) is never
 *  renumbered. The keys are placeholders with the same order: the whole bootstrap that MIRROR_SCHEMA_VERSION 4 asks for
 *  replaces them with the server's. The old column stays in the copy, unread. */
function migratePlaceKeys(database: Database): void {
  const tables: Array<{ table: "nodes" | "pointers"; order: string }> = [
    { table: "nodes", order: "sort_order, created_at IS NULL, created_at, id" },
    { table: "pointers", order: "sort_order, id" },
  ];
  for (const { table, order } of tables) {
    const hasTable = database.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table}'`)[0]?.values.length;
    if (!hasTable) continue;
    let added = false;
    try { database.run(`ALTER TABLE ${table} ADD COLUMN order_key TEXT`); added = true; } catch { /* column exists */ }
    try { database.run(`ALTER TABLE ${table} ADD COLUMN order_stamp TEXT NOT NULL DEFAULT ''`); } catch { /* column exists */ }
    const hasOld = database.exec(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'sort_order'`)[0]?.values.length;
    if (!added || !hasOld) continue;
    const rows = database.exec(`SELECT id, parent_id FROM ${table} ORDER BY parent_id IS NULL, parent_id, ${order}`)[0]?.values ?? [];
    let group: unknown = Symbol("none"), rank = 0;
    for (const [id, parent] of rows) {
      rank = parent === group ? rank + 1 : 0;
      group = parent;
      database.run(`UPDATE ${table} SET order_key = ? WHERE id = ?`, [evenOrderKey(rank), id as string]);
    }
  }
}

/** Raise this when an upgrade above adds a column (or changes what a column
 *  holds) that only a whole bootstrap fills in: rows from before it stay NULL
 *  until the next one, which otherwise comes up to a day later.
 *  2: the server's migration 194 gave every sidebar pointer a new id; a copy that still holds the old ids would
 *  fail to unpin (the server no longer has them) and could show a pin twice, so every copy reads them again.
 *  3: the server's migration 201 gave the personal, default and system spaces and four built-in tags new ids. The notes
 *  in those spaces kept their own ids, so the membership check (which compares the set of ids) saw nothing to fetch and a
 *  copy kept the old space id and old tag ids on them: the sidebar listed the personal space's notes under "Other".
 *  4: order keys (server migration 200) replace the integer order. The backfill wrote a key on every existing row without an
 *  event, so a copy made before it holds no key (or the placeholders an upgrade makes); the whole bootstrap this version asks
 *  for reads every row's real key and stamp again. */
export const MIRROR_SCHEMA_VERSION = 4;

/** Record the schema version this mirror was prepared with; a different one
 *  forgets when the last whole bootstrap was stored, so the next open does one. */
function stampMirrorSchema(database: Database): void {
  const [row] = database.exec("SELECT value FROM sync_state WHERE key = 'mirror_schema_version'");
  if (Number(row?.values?.[0]?.[0] ?? 0) === MIRROR_SCHEMA_VERSION) return;
  database.run("DELETE FROM sync_state WHERE key = 'full_refresh_at'");
  database.run(
    "INSERT INTO sync_state (key, value) VALUES ('mirror_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [String(MIRROR_SCHEMA_VERSION)],
  );
}

const COPY_PROTOCOL_KEY = "local_copy_protocol";

/** The protocol (CLIENT_PROTOCOL) of the newest build that wrote this copy. A copy from before this was recorded has
 *  none and is older than any build that records it. */
function copyProtocol(database: Database): number {
  const hasTable = database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_state'")[0]?.values.length;
  if (!hasTable) return 0;
  const [row] = database.exec("SELECT value FROM sync_state WHERE key = ?", [COPY_PROTOCOL_KEY]);
  return Number(row?.values?.[0]?.[0] ?? 0) || 0;
}

/** A copy written by a build that speaks a newer protocol is not opened by this one: its upgrade steps would run
 *  against a shape they do not know and its queued writes would be sent in a meaning this build lacks. Refusing leaves
 *  the stored copy untouched (the worker never saves what it did not open) for the newer build to use. */
function refuseCopyFromNewerBuild(database: Database): void {
  if (copyProtocol(database) > CLIENT_PROTOCOL) throw new LocalDbError("local_copy_too_new", "The local copy was written by a newer version");
}

function stampCopyProtocol(database: Database): void {
  database.run(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [COPY_PROTOCOL_KEY, String(CLIENT_PROTOCOL)],
  );
}
