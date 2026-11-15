import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { decodeTaskRow, migrateTaskMirror, upsertTaskInto } from "../lib/taskMirror";

describe("task persistence", () => {
  it("migrates an existing database without losing tasks and round-trips due date and recurrence", async () => {
    const SQL = await initSqlJs(); const db = new SQL.Database();
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, node_id TEXT, title TEXT, status TEXT)");
    db.run("INSERT INTO tasks VALUES ('old', 'n1', 'Old task', 'todo')");
    migrateTaskMirror(db); migrateTaskMirror(db);
    expect(db.exec("SELECT title, due_date, recur FROM tasks")[0]!.values).toEqual([["Old task", null, null]]);
    const task = { id: "t1", node_id: "n1", title: "Study", status: "todo" as const, due_date: "2026-09-09T15:30", recur: "1w" };
    upsertTaskInto(db, task);
    const reopened = new SQL.Database(db.export());
    expect(reopened.exec("SELECT due_date, recur FROM tasks WHERE id='t1'")[0]!.values).toEqual([[task.due_date, task.recur]]);
    upsertTaskInto(reopened, { ...task, due_date: null, recur: null });
    expect(reopened.exec("SELECT due_date, recur FROM tasks WHERE id='t1'")[0]!.values).toEqual([[null, null]]);
    // D41: the completed tail's sort key survives the mirror.
    upsertTaskInto(reopened, { ...task, updated_at: "2026-10-16T01:00:00.000Z" });
    expect(reopened.exec("SELECT updated_at FROM tasks WHERE id='t1'")[0]!.values).toEqual([["2026-10-16T01:00:00.000Z"]]);
    db.close(); reopened.close();
  });

  it("rebuilds a database whose tasks table still requires a note, so a standalone task fits; keeps its rows and parks 'later' as someday", async () => {
    const SQL = await initSqlJs(); const db = new SQL.Database();
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo')");
    db.run("ALTER TABLE tasks ADD COLUMN due_date TEXT"); db.run("ALTER TABLE tasks ADD COLUMN recur TEXT"); db.run("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
    db.run("INSERT INTO tasks VALUES ('a', 'n1', 'Dated', 'todo', '2026-09-09', '1w', '2026-10-01T00:00:00.000Z')");
    db.run("INSERT INTO tasks VALUES ('b', 'n1', 'Parked', 'later', NULL, NULL, NULL)");
    migrateTaskMirror(db); migrateTaskMirror(db); // twice: nothing more happens
    const rows = db.exec("SELECT id, node_id, status, due_date, when_date, recur, updated_at, someday FROM tasks ORDER BY id")[0]!.values;
    expect(rows).toEqual([
      ["a", "n1", "todo", "2026-09-09", "2026-09-09", "1w", "2026-10-01T00:00:00.000Z", 0],
      ["b", "n1", "todo", null, null, null, null, 1],
    ]);
    // node_id may now be NULL.
    upsertTaskInto(db, { id: "c", node_id: null, title: "No note", status: "todo", when_date: "2026-10-24", evening: true, deadline: "2026-10-30", recur_mode: "after", remind_at: "2026-10-24T18:00", space_id: "s1", has_body: true });
    const c = db.exec("SELECT * FROM tasks WHERE id='c'");
    const row = Object.fromEntries(c[0]!.columns.map((name, i) => [name, c[0]!.values[0]![i]]));
    expect(decodeTaskRow(row)).toMatchObject({
      id: "c", node_id: null, when_date: "2026-10-24", due_date: "2026-10-24", evening: true, someday: false, deadline: "2026-10-30",
      recur_mode: "after", remind_at: "2026-10-24T18:00", space_id: "s1", has_body: true,
    });
    db.close();
  });

});
