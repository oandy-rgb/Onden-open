// What a change bundle carries is decided in ONE list (spine/stampedMerge/dbUnits.ts UNIT_SOURCES, JSON_SOURCES, NOT_CARRIED_YET), and that list is the stamp triggers' own:
// every table spine/syncClasses.json calls `stamped` and wired has a source whose key, workspace and fields are the trigger's arguments, or a named reason it is not carried yet.
// A new stamped table, a new watched field or a new JSON column fails here until the list says what a bundle does with it.
import { describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RETIRED_STAMP_LABELS, SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { CARRIED_LABELS, UNIT_SOURCES, jsonSourceOf } from "../spine/stampedMerge/dbUnits.js";
import { SYNC_CLASSES } from "../spine/syncClasses.js";

/**
 * Stamped and wired (a trigger stamps them) but not carried by a bundle yet, each with why. A guard fails for any other stamped table without a source.
 * (A note's frozen views column is not here: nothing writes it any more, test/guards/viewRefs.guard.test.ts. A board's per-section stamps are not here either: no trigger
 * makes them since migration 209, snapshotTables.ts RETIRED_STAMP_LABELS.) Since migration 215 the paragraph rows (block_nodes) and their tags travel too.
 */
// ratchet:list not-carried-yet
const NOT_CARRIED_YET: Readonly<Record<string, string>> = {};
const FROZEN_VIEWS = "content_nodes.collection_views";
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

type Trigger = { rel: string; name: string; fn: string; args: string[] };
async function stampTriggers(): Promise<Trigger[]> {
  const r = await q<{ rel: string; name: string; fn: string; args: string }>(
    `SELECT t.tgrelid::regclass::text AS rel, t.tgname AS name, p.proname AS fn, encode(t.tgargs, 'escape') AS args FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger') AND NOT t.tgisinternal`);
  return r.rows.map((x) => ({ rel: x.rel, name: x.name, fn: x.fn, args: x.args.split("\\000") }));
}

describe.skipIf(!isTestDb)("what a change bundle carries is the stamp triggers' own list", () => {
  it("every stamped and wired table has a unit source, or a reason it is not carried yet", () => {
    const stamped = Object.entries(SYNC_CLASSES).filter(([, e]) => e.class === "stamped" && e.wired).map(([t]) => t).sort();
    const missing = stamped.filter((t) => !UNIT_SOURCES.some((s) => s.table === t) && NOT_CARRIED_YET[t] === undefined);
    expect(missing).toEqual([]);
    // and nothing is listed that is not a stamped table
    for (const s of UNIT_SOURCES) expect(SYNC_CLASSES[s.table]?.class, s.table).toBe("stamped");
  });

  // round 6, point 5: a source whose rows go with their note names a column the database holds to that: NOT NULL, a foreign key to content_nodes that cascades on
  // delete (so a row is never left on a note that is gone, and the rule of migration 215 section 2c sees every row that goes), and the row's workspace is its note's.
  it("a source whose rows go with their note: its column is NOT NULL and cascades from content_nodes, and a row's workspace is its note's", async () => {
    const sources = UNIT_SOURCES.filter((x) => x.goesWithNote);
    expect(sources.map((x) => x.table).sort()).toEqual(["block_anchors", "block_nodes", "note_anchor_places"]);
    for (const src of sources) {
      const col = (await q<{ nullable: string }>(`SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [src.table, src.goesWithNote])).rows;
      expect(col, src.table).toEqual([{ nullable: "NO" }]);
      const fk = (await q<{ del: string }>(
        `SELECT c.confdeltype::text AS del FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = 'content_nodes'::regclass AND a.attname = $2 AND array_length(c.conkey, 1) = 1`, [src.table, src.goesWithNote])).rows;
      expect(fk, src.table).toEqual([{ del: "c" }]);
      // the workspace check runs on every insert and every update
      const checks = (await q<{ t: string }>(`SELECT t.tgname AS t FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND p.proname = 'sync_rows_in_their_notes_workspace' ORDER BY 1`, [src.table])).rows.map((r) => r.t);
      expect(checks, src.table).toEqual([`${src.table}_in_notes_workspace_insert`, `${src.table}_in_notes_workspace_update`]);
      // round 8: the delete trigger keeps a moved row's values on its stamps by the columns its argument names: the source's own fields, so none is kept from another column
      const goes = (await q<{ args: string }>(`SELECT encode(t.tgargs, 'escape') AS args FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND p.proname = 'sync_rows_go_with_note'`, [src.table])).rows;
      expect(goes.length, src.table).toBe(1);
      expect(Object.fromEntries(goes[0]!.args.split("\\000")[0]!.split(",").map((x) => x.split("=") as [string, string])), src.table).toEqual(src.fields);
    }
  });

  // round 9, points 1 and 2: every unit column a foreign key empties (ON DELETE SET NULL) is declared `clearedOnDelete`, read from the catalog; and where a stamp
  // may keep a value (migration 215 sync_stamp_may_keep_value, the CHECK on sync_stamps) is exactly the sources that go with their note and those declared units
  it("every unit column an ON DELETE SET NULL foreign key empties is declared, and a stamp may keep a value exactly there and in the tables that go with their note", async () => {
    const setNull = new Set((await q<{ t: string; c: string }>(
      `SELECT c.conrelid::regclass::text AS t, a.attname AS c FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.confdeltype = 'n'`)).rows.map((r) => `${r.t}.${r.c}`));
    for (const src of UNIT_SOURCES) {
      const want: Record<string, string[]> = {};
      for (const [f, cols] of Object.entries(src.fields)) { const emptied = cols.split("+").filter((col) => setNull.has(`${src.table}.${col}`)); if (emptied.length) want[f] = emptied; }
      expect(src.clearedOnDelete ?? {}, src.label).toEqual(want);
      for (const f of [...Object.keys(src.fields), "*"]) {
        const may = (await q<{ ok: boolean }>(`SELECT sync_stamp_may_keep_value($1, $2) AS ok`, [src.label, f])).rows[0]!.ok;
        expect(may, `${src.label}.${f}`).toBe(!!src.goesWithNote || !!src.clearedOnDelete?.[f]);
      }
    }
    // the trigger that keeps an emptied id on its stamp (migration 215 sync_keep_emptied_id) names exactly the declared units, with the unit's columns
    for (const src of UNIT_SOURCES.filter((x) => x.clearedOnDelete)) {
      const keep = (await q<{ args: string }>(`SELECT encode(t.tgargs, 'escape') AS args FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND p.proname = 'sync_keep_emptied_id'`, [src.table])).rows;
      expect(keep.length, src.table).toBe(1);
      const args = keep[0]!.args.split("\\000");
      expect(args[0], src.table).toBe(src.label);
      const said = Object.fromEntries(args[4]!.split(",").map((e) => e.split(":")).map(([f, col, spec, reft, refc]) => [f!, { col: col!, spec: spec!, named: `${reft}.${refc}` }]));
      expect(Object.keys(said).sort(), src.table).toEqual(Object.keys(src.clearedOnDelete!).sort());
      for (const [f, cols] of Object.entries(src.clearedOnDelete!)) {
        const named = (await q<{ n: string }>(
          `SELECT cf.relname || '.' || af.attname AS n FROM pg_constraint k JOIN pg_class cf ON cf.oid = k.confrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
             JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = k.confkey[1] WHERE k.contype = 'f' AND k.conrelid = $1::regclass AND a.attname = $2`, [src.table, cols[0]])).rows[0]!.n;
        expect(said[f], `${src.table}.${f}`).toEqual({ col: cols[0], spec: src.fields[f], named });
        // the door checks a kept emptied id as a uuid (stampedImport.ts keptProblem): every key it names is one
        const [t, c] = named.split(".");
        expect((await q<{ ty: string }>(`SELECT format_type(atttypid, atttypmod) AS ty FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2`, [t, c])).rows[0]!.ty, named).toBe("uuid");
      }
    }
    // and the database refuses a kept text anywhere else
    const refused = await q(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, kept_value)
      VALUES (gen_random_uuid(), 'node_attributes', 'x', 'value', 'o', 1, 1, 0, '{"text": "words"}')`).then(() => null, (e: { code?: string }) => e.code);
    expect(refused).toBe("23514");
  });

  it("every label a trigger stamps is carried or named in NOT_CARRIED_YET, and each source is the trigger's arguments", async () => {
    const labels = new Set<string>();
    for (const t of await stampTriggers()) {
      if (t.fn === "sync_stamp_attribute_trigger") {
        // the attribute trigger names its labels itself (migrations 205, 209): every label in its text
        const body = (await q<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'sync_stamp_attribute_trigger'`)).rows[0]!.src;
        for (const m of body.matchAll(/'(node_attributes[^']*)'/g)) labels.add(m[1]!);
        const src = UNIT_SOURCES.find((s) => s.label === "node_attributes")!;
        expect(src.fields).toEqual({ value: "value", type: "value_type", inheritable: "is_inheritable" });
        expect(src.key.map((k) => k.column)).toEqual(["node_id", "key"]);
        continue;
      }
      const label = t.args[0]!;
      if (label === FROZEN_VIEWS) continue; // the frozen views column: no writer since views became function references (guards/viewRefs.guard.test.ts), so nothing to carry
      labels.add(label);
      if (t.fn === "sync_stamp_json_trigger") {
        const j = jsonSourceOf(label);
        if (!j) { expect(NOT_CARRIED_YET[label], `${label} is neither carried nor named`).toBeDefined(); continue; }
        expect([j.column, j.shape, j.prefix], label).toEqual([t.args[3], t.args[4], t.args[5]]);
        expect(UNIT_SOURCES.find((s) => s.label === j.of)?.table, label).toBe(t.rel);
        continue;
      }
      const src = UNIT_SOURCES.find((s) => s.label === label);
      if (!src) { expect(NOT_CARRIED_YET[label], `${label} is neither carried nor named`).toBeDefined(); continue; }
      expect(src.table, label).toBe(t.rel);
      expect(src.key.map((k) => k.column).join(","), label).toBe(t.args[1]);
      const ws = src.workspace;
      // a source whose rows go with their note files their stamps under the note (dbUnits.ts goesWithNote); its reads use the workspace column
      const declared = src.goesWithNote ? `via:${src.goesWithNote}` : "column" in ws ? ws.column : "viaNode" in ws ? `via:${ws.viaNode}` : `space:${ws.viaSpace}`;
      expect(declared, `${label} (${t.name})`).toBe(t.args[2]!.startsWith("via:") ? `via:${t.args[2]!.slice(4).split(",")[0]}` : t.args[2]);
      const fields = t.args[3] ? Object.fromEntries(t.args[3].split(",").map((x) => x.split("=") as [string, string])) : {};
      expect(src.fields, label).toEqual(fields);
    }
    for (const l of labels) expect(CARRIED_LABELS.includes(l) || NOT_CARRIED_YET[l] !== undefined, l).toBe(true);
    for (const l of Object.keys(NOT_CARRIED_YET)) expect(labels.has(l) || SYNC_CLASSES[l]?.class === "stamped", `${l} in NOT_CARRIED_YET is no label of a trigger`).toBe(true);
  });

  it("a retired label (snapshotTables.ts RETIRED_STAMP_LABELS) is made by no trigger and no genesis pass, and copied by no snapshot, digest or bundle", async () => {
    const made = (await q<{ fn: string }>(`SELECT proname AS fn FROM pg_proc WHERE proname IN ('sync_stamp_attribute_trigger', 'sync_genesis_pass', 'sync_stamp_trigger', 'sync_stamp_json_trigger')
                                             AND prosrc LIKE ANY ($1::text[])`, [RETIRED_STAMP_LABELS.map((l) => `%'${l}'%`)])).rows.map((r) => r.fn);
    expect(made).toEqual([]);
    const triggerArgs = (await stampTriggers()).map((t) => t.args[0]);
    for (const l of RETIRED_STAMP_LABELS) {
      expect(triggerArgs, l).not.toContain(l);
      expect(CARRIED_LABELS, l).not.toContain(l);
      expect(SNAPSHOT_SPECS.flatMap((s) => (s.stamps ?? []).map((d) => d.label)), l).not.toContain(l);
    }
  });

  it("the key types of every source are the columns' types (a key compared as another type cannot use the index)", async () => {
    for (const s of UNIT_SOURCES) {
      const r = await q<{ c: string; t: string }>(`SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [s.table]);
      const types = new Map(r.rows.map((x) => [x.c, x.t]));
      for (const k of s.key) expect(types.get(k.column), `${s.table}.${k.column}`).toBe(k.type === "uuid" ? "uuid" : "text");
    }
  });
});
