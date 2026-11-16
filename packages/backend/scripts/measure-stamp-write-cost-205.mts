// What migration 205 adds to the cost of stamping a write: sync_stamp_put (what the triggers called before) against sync_stamp_put_row (what they call now), on
// units that have a real stamp and on units that stand on a genesis value, in-memory PGlite.
//   npx tsx scripts/measure-stamp-write-cost-205.mts [units]        (default 5000)
// The old function is made here from migration 190's statement (plus 204's stand-aside line), under another name, so both run on the same database and rows.
import { performance } from "node:perf_hooks";
import { setEnvironment } from "../src/config.js";

setEnvironment({ NODE_ENV: "production", ONDEN_DB_DRIVER: "pglite", ONDEN_PGLITE_DIR: "memory://", BETTER_AUTH_SECRET: "measure-only-never-used-to-sign-a-session", BETTER_AUTH_URL: "http://localhost", LOG_LEVEL: "warn" });
const N = Number(process.argv[2] ?? 5000);
const db = await import("../src/db.js");
await db.migrate();
const { q } = db;
const ws = await db.getWorkspaceId();

await q(`CREATE OR REPLACE FUNCTION old_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
  BEGIN
    IF sync_import_active(p_ws) THEN RETURN; END IF;
    INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
    VALUES (p_ws, p_table, p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int, s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted)
    ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
      author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted;
  END $$ LANGUAGE plpgsql`);
const stamp = `'{"origin":"n","seq":5,"wall":1700000000000,"counter":0,"author":null,"device":null}'::jsonb`;
const rows = async (label: string, genesis: boolean) => {
  await q(`DELETE FROM sync_stamps WHERE table_name = $1`, [label]);
  await q(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, deleted)
           SELECT $1, $2, 'r' || g, '*', $3, 1, $4, 0, false FROM generate_series(1, $5::int) g`, [ws, label, genesis ? "genesis" : "n", genesis ? 0 : 1700000000000, N]);
};
const time = async (name: string, sql: string) => { const t = performance.now(); await q(sql); return { name, perStampMicros: Math.round(((performance.now() - t) * 1000) / N * 10) / 10 }; };
const out: unknown[] = [];
for (const genesis of [false, true]) {
  for (const label of ["m_old", "m_new_row", "m_new_text"]) await rows(label, genesis);
  out.push({ units: genesis ? "at a genesis value" : "with a real stamp", ...await time("before (190)", `SELECT old_put('${ws}', 'm_old', 'r' || g, 'title', false, ${stamp}) FROM generate_series(1, ${N}) g`) });
  out.push({ units: genesis ? "at a genesis value" : "with a real stamp", ...await time("205, old value not needed (put_over)", `SELECT sync_stamp_put_over('${ws}', 'm_new_text', 'r' || g, 'title', false, ${stamp}, NULL, false) FROM generate_series(1, ${N}) g`) });
  out.push({ units: genesis ? "at a genesis value" : "with a real stamp", ...await time("205, through the trigger's entry (put_row)", `SELECT sync_stamp_put_row('${ws}', 'm_new_row', 'r' || g, 'title', false, ${stamp}, (SELECT c FROM content_nodes c LIMIT 1), 'title') FROM generate_series(1, ${N}) g`) });
}
console.log(JSON.stringify({ units: N, results: out }, null, 1));
process.exit(0);
