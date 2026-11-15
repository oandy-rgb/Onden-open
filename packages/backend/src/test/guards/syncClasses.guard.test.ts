// The table classification (spine/syncClasses.ts, proposal causal-stamps-2026-11-12 §4) stays honest without a database:
// the "undecided" list can only shrink, and the tables that have a stamp trigger are the ones marked wired.
// (That every table of a migrated database is classified is src/test/syncClasses.integration.test.ts.)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYNC_CLASSES, WIRED_TABLES } from "../../spine/syncClasses.js";

// Tables the proposal does not name. A table leaves this list when it is classified; none may be added
// (a new table gets a real class in spine/syncClasses.ts).
// ratchet:list sync-class-undecided
const UNDECIDED_TABLES = [
  "agent_runners", "agent_session_events", "agent_tokens", "ai_suggestions", "board_copy_folds",
  "board_copy_unparents", "board_ink_moves", "canvas_note_conversions", "dispatcher_pending", "ds_capture_cursor",
  "ds_captured_events", "ds_node", "ds_ops", "ds_peers", "ds_projection_failures", "ds_rejections", "ds_unsupported",
  "event_reviews", "member_removals", "owner_member_migration_log", "push_reminder_sent", "push_subscriptions",
  "schema_migrations", "snapshot_media",
];

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

describe("sync classes", () => {
  it("every undecided table is in the ratchet list, and the list names no table that was decided since", () => {
    const undecided = Object.entries(SYNC_CLASSES).filter(([, e]) => e.class === "undecided").map(([name]) => name).sort();
    expect(undecided).toEqual([...UNDECIDED_TABLES].sort());
  });

  it("each entry has a known class and a reason", () => {
    for (const [name, entry] of Object.entries(SYNC_CLASSES)) {
      expect(["stamped", "derived", "node-local", "separate", "undecided"], name).toContain(entry.class);
      expect(entry.note.length, `${name} needs a note`).toBeGreaterThan(5);
    }
  });

  it("the tables with a stamp trigger are exactly the ones marked wired, and they are stamped data", () => {
    const wired = new Set<string>();
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(migrations, file), "utf8");
      for (const m of sql.matchAll(/EXECUTE FUNCTION sync_stamp_trigger\('(\w+)'/g)) wired.add(m[1]!);
      // the JSON-column function (migration 199) names 'table.column' as its first argument
      for (const m of sql.matchAll(/EXECUTE FUNCTION sync_stamp_json_trigger\('(\w+)\.\w+'/g)) wired.add(m[1]!);
      // node_attributes has its own function (a drawing is a multi-MB value; migration 194): its triggers are on that table by name
      for (const m of sql.matchAll(/CREATE OR REPLACE TRIGGER (\w+?)_sync_stamp_\w+ AFTER \w+ ON \w+ FOR EACH ROW\s+EXECUTE FUNCTION sync_stamp_attribute_trigger\(\)/g)) wired.add(m[1]!);
    }
    expect([...wired].sort()).toEqual([...WIRED_TABLES].sort());
    for (const name of wired) expect(SYNC_CLASSES[name]!.class).toBe("stamped");
  });
});
