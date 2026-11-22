#!/usr/bin/env node
// The SQL every restore runs once the data is loaded (scripts/lib/renewNodeId.sql), made from the migrations.
//
// A restore puts back an older copy of a node's database, and that copy goes on numbering its writes from where it stopped: numbers
// the node had already given to other writes (migration 213's header). So every restore ends with the node on a new id and its old id
// held as a former origin ('self-restore', migration 213; a snapshot names it as `former`, migration 214). Backups made by a version
// before migration 213 do not carry sync_renew_node_id(); this file brings the migrations' own definitions of the three functions with
// it and installs each one only where the restored database lacks it (a database that has it keeps its own: a host checkout older than
// the backup must not replace a newer definition). Nothing here defines the rule a second time: the definitions are copied, byte for
// byte, from the LAST migration that defines each function (what a migrated database ends up with), and
// packages/backend/src/test/guards/restoreRenewsNodeId.guard.test.ts fails while the checked-in file differs from what this prints.
//
//   node scripts/lib/renewNodeIdSql.mjs           print the SQL
//   node scripts/lib/renewNodeIdSql.mjs --write   rewrite scripts/lib/renewNodeId.sql
//
// Who reads the file: scripts/lib/renewNodeId.sh (scripts/restore.sh, scripts/restore-drill.sh, a person after a hand-made restore)
// and the desktop app (packages/desktop/src/nodeRenewal.mjs; scripts/stage.mjs ships the file next to the server).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RENEWAL_SQL_FILE = join(here, "renewNodeId.sql");
const MIGRATIONS = join(here, "..", "..", "packages", "backend", "db", "migrations");

/** The functions a renewal needs, in the order they are installed (each one calls only those before it). */
export const RENEWAL_FUNCTIONS = /** @type {const} */ (["sync_take_node_id", "sync_carried_labels", "sync_renew_node_id"]);

/** The whole statement `CREATE OR REPLACE FUNCTION fn(…) … $$ … $$ LANGUAGE …;` of the LAST migration (by file name) that defines `fn`.
 *  Only that one form is read; any other way a migration could define or remove `fn` (CREATE without OR REPLACE, a schema prefix, another
 *  quote than $$, DROP FUNCTION, a definition not at the start of a line) THROWS instead of being passed over: a definition this reader did
 *  not see would leave the file installing an older one, and nothing would say so until a restore (review of PR #1937, point 8).
 *  @param {string} fn @param {readonly (readonly [string, string])[]} migrations [file name, text] @returns {{ file: string, sql: string } | undefined} */
export function lastDefinition(fn, migrations) {
  let found;
  const any = new RegExp(`\\b(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION|DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?)\\s+(?:"?public"?\\.)?"?${fn}"?\\s*\\(`, "gi");
  for (const [file, raw] of [...migrations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const text = raw.split("\n").map((line) => (/^\s*--/.test(line) ? " ".repeat(line.length) : line)).join("\n"); // a comment naming the function is not a definition (same length: offsets stay)
    for (let m = any.exec(text); m; m = any.exec(text)) {
      const atLineStart = m.index === 0 || text[m.index - 1] === "\n";
      if (!atLineStart || !text.startsWith(`CREATE OR REPLACE FUNCTION ${fn}(`, m.index)) {
        throw new Error(`${file} defines or drops ${fn}() in a form scripts/lib/renewNodeIdSql.mjs does not read ("${m[0]}"): write it as \`CREATE OR REPLACE FUNCTION ${fn}(\` at the start of a line with a $$ body, or teach the reader`);
      }
      const open = text.indexOf("$$", m.index);
      const close = open < 0 ? -1 : text.indexOf("$$", open + 2);
      const end = close < 0 ? -1 : text.indexOf(";", close + 2);
      const head = text.slice(m.index, open < 0 ? undefined : open);
      if (end < 0 || /\$[A-Za-z_]\w*\$/.test(head)) throw new Error(`${file}: the definition of ${fn}() has no $$ … $$ body this reader can find`);
      found = { file, sql: raw.slice(m.index, end + 1) };
    }
  }
  return found;
}

/** The table a restore that keeps its node id writes to (migration 224): the statement `CREATE TABLE IF NOT EXISTS sync_restore_kept_node_id (…);` of
 *  the one migration that makes it, so that a backup older than 224 gets the same table. @param {readonly (readonly [string, string])[]} migrations */
export function keptTableDefinition(migrations) {
  const found = migrations.flatMap(([file, text]) => {
    const m = /^CREATE TABLE IF NOT EXISTS sync_restore_kept_node_id \([\s\S]*?\n\);/m.exec(text);
    return m ? [{ file, sql: m[0] }] : [];
  });
  if (found.length !== 1) throw new Error(`expected one migration that makes sync_restore_kept_node_id, found ${found.length}`);
  return found[0];
}

/** @param {string} [dir] @returns {[string, string][]} */
export function readMigrations(dir = MIGRATIONS) {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
}

/** The file's text. @param {readonly (readonly [string, string])[]} migrations */
export function renewalSql(migrations) {
  const defs = RENEWAL_FUNCTIONS.map((fn) => {
    const d = lastDefinition(fn, migrations);
    if (!d) throw new Error(`no migration defines ${fn}()`);
    if (d.sql.includes("$onden_def$")) throw new Error(`${d.file} uses the quote $onden_def$ this file wraps it in`);
    return { fn, ...d };
  });
  const run = (/** @type {(typeof defs)[number]} */ d) => `-- ${d.file}\n      EXECUTE $onden_def$${d.sql}$onden_def$;`;
  const ifMissing = (/** @type {(typeof defs)[number]} */ d) => `    IF to_regprocedure('${d.fn}()') IS NULL THEN\n      ${run(d)}\n    END IF;`;
  const [take, labels, renew] = defs;
  const kept = keptTableDefinition(migrations);
  return `-- GENERATED by scripts/lib/renewNodeIdSql.mjs from packages/backend/db/migrations. Do not edit: run \`node scripts/lib/renewNodeIdSql.mjs --write\`.
--
-- What a restore runs once the data is loaded, before anything else writes, in the same session:
--   <this file>
--   SELECT * FROM pg_temp.onden_renew_after_restore(<the node id of the database it replaces, or NULL>, <keep the id if it cannot be renewed>);
-- The function is temporary (gone with the session): a restore adds no schema of its own, except the one table of the 'kept' outcome.
--
-- Outcomes (one row, or an error that leaves the database as it was):
--   'renewed'     the node took a new id (sync_renew_node_id: migration 213); the id the backup had is a 'self-restore' origin held up to its last
--                 number. If the database this restore replaces had a different id (it had been restored and renewed since the backup was made),
--                 that id is a 'self-restore' origin too, held up to 0: none of its writes are in the backup (sync_origins.have '{}' = 0 for every
--                 label, spine/stampedBundle.ts heldOfFormer), and a peer that holds them can send them back. \`origins\` counts both kinds of row.
--   'no-node-id'  the backup has no sync_node table (made before migration 190): it never numbered a write, so there is nothing to renew; the
--                 database takes a fresh id at its first write. Refused instead when the replaced database had an id (it could not be recorded).
--   'kept'        only with p_keep, where the rule cannot hold (the two refusals below): the database keeps the id it has, and says so in
--                 sync_restore_kept_node_id (migration 224; made here from that migration's definition in a backup older than it): one row per
--                 such restore (when, the id it kept, the replaced database's id, why). The exchange between nodes must refuse while that table
--                 has a row (spine/stampedMerge/README.md「接上傳輸前必須完成」). 'renewed' empties it: the id is a new one.
--   error 'onden-restore: no-origins-table'  the backup numbered writes (sync_node) but has no sync_origins table (migrations 190 to 205): its
--                 old id cannot be recorded, so the restore is refused rather than ending with an id that is not new or an old id nobody holds.
--   error 'onden-restore: no-node-table'     the backup has no node id but the database it replaces had one (see 'no-node-id').
--   error 'onden-restore: bad-node-id'       the id passed in is not a node id (gen_random_uuid() text).
CREATE OR REPLACE FUNCTION pg_temp.onden_renew_after_restore(p_overwritten text, p_keep boolean)
RETURNS TABLE (outcome text, before_id text, after_id text, clocks bigint, origins bigint, reason text) AS $onden_restore$
DECLARE v_before text; v_after text; v_clocks bigint; v_origins bigint; v_more bigint := 0; v_refused text;
BEGIN
  IF p_overwritten IS NOT NULL AND p_overwritten !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'onden-restore: bad-node-id';
  END IF;
  IF to_regclass('sync_node') IS NULL THEN
    IF p_overwritten IS NULL THEN
      RETURN QUERY SELECT 'no-node-id'::text, NULL::text, NULL::text, 0::bigint, 0::bigint, NULL::text;
      RETURN;
    END IF;
    v_refused := 'no-node-table';
  ELSIF to_regclass('sync_clock') IS NULL OR to_regclass('sync_stamps') IS NULL OR to_regclass('sync_stamp_heads') IS NULL
     OR to_regclass('sync_origins') IS NULL OR to_regprocedure('sync_lock_clock(uuid)') IS NULL THEN
    v_refused := 'no-origins-table';
  END IF;
  IF v_refused IS NOT NULL THEN
    IF NOT p_keep THEN RAISE EXCEPTION 'onden-restore: %', v_refused; END IF;
    -- ${kept.file}
    EXECUTE $onden_def$${kept.sql}$onden_def$;
    IF to_regclass('sync_node') IS NOT NULL THEN EXECUTE 'SELECT node_id FROM sync_node WHERE singleton' INTO v_before; END IF;
    EXECUTE 'INSERT INTO sync_restore_kept_node_id (workspace_id, node_id, overwritten, reason) SELECT w.id, $1, $2, $3 FROM workspaces w'
      USING v_before, p_overwritten, v_refused;
    RETURN QUERY SELECT 'kept'::text, v_before, v_before, 0::bigint, 0::bigint, v_refused;
    RETURN;
  END IF;
  -- each function only where the database lacks it; sync_carried_labels() is read only by the definition installed after it
  IF to_regprocedure('sync_renew_node_id()') IS NULL THEN
${ifMissing(take)}
${ifMissing(labels)}
    ${run(renew)}
  END IF;
  SELECT r.old_node_id, r.new_node_id, r.workspaces, r.origins_added INTO v_before, v_after, v_clocks, v_origins FROM sync_renew_node_id() r;
  IF p_overwritten IS NOT NULL AND p_overwritten IS DISTINCT FROM v_before THEN
    INSERT INTO sync_origins (workspace_id, origin, vouched_by) SELECT c.workspace_id, p_overwritten, 'self-restore' FROM sync_clock c
      ON CONFLICT (workspace_id, origin) DO NOTHING;
    GET DIAGNOSTICS v_more = ROW_COUNT;
  END IF;
  -- the id is new now: what a restore before this one kept is no longer this node's id (migration 224: rows <=> the current id was kept)
  IF to_regclass('sync_restore_kept_node_id') IS NOT NULL THEN EXECUTE 'TRUNCATE sync_restore_kept_node_id'; END IF;
  RETURN QUERY SELECT 'renewed'::text, v_before, v_after, v_clocks, v_origins + v_more, NULL::text;
END;
$onden_restore$ LANGUAGE plpgsql;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = renewalSql(readMigrations());
  if (process.argv.includes("--write")) writeFileSync(RENEWAL_SQL_FILE, text);
  else process.stdout.write(text);
}
