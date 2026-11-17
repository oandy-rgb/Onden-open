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
 * makes them since migration 209, snapshotTables.ts RETIRED_STAMP_LABELS.) block_node_tags hang on paragraphs (block_nodes), which are derived from a note's body and are
 * rebuilt by batch 2b-2b.
 */
// ratchet:list not-carried-yet
const NOT_CARRIED_YET: Readonly<Record<string, string>> = {
  "block_node_tags": "a paragraph tag hangs on a block_nodes row, which is derived from the note's body; a merged body does not rebuild its paragraphs yet (batch 2b-2b)",
};
const FROZEN_VIEWS = "content_nodes.collection_views";
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

type Trigger = { rel: string; fn: string; args: string[] };
async function stampTriggers(): Promise<Trigger[]> {
  const r = await q<{ rel: string; fn: string; args: string }>(
    `SELECT t.tgrelid::regclass::text AS rel, p.proname AS fn, encode(t.tgargs, 'escape') AS args FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger') AND NOT t.tgisinternal`);
  return r.rows.map((x) => ({ rel: x.rel, fn: x.fn, args: x.args.split("\\000") }));
}

describe.skipIf(!isTestDb)("what a change bundle carries is the stamp triggers' own list", () => {
  it("every stamped and wired table has a unit source, or a reason it is not carried yet", () => {
    const stamped = Object.entries(SYNC_CLASSES).filter(([, e]) => e.class === "stamped" && e.wired).map(([t]) => t).sort();
    const missing = stamped.filter((t) => !UNIT_SOURCES.some((s) => s.table === t) && NOT_CARRIED_YET[t] === undefined);
    expect(missing).toEqual([]);
    // and nothing is listed that is not a stamped table
    for (const s of UNIT_SOURCES) expect(SYNC_CLASSES[s.table]?.class, s.table).toBe("stamped");
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
      expect("column" in ws ? ws.column : "viaNode" in ws ? `via:${ws.viaNode}` : `space:${ws.viaSpace}`, label).toBe(t.args[2]!.startsWith("via:") ? `via:${t.args[2]!.slice(4).split(",")[0]}` : t.args[2]);
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
