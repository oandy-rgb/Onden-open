import type { Database } from "sql.js";
import type { NodeTask } from "./api";

// The local copy of the server's task rows (docs/architecture/tasks-module.md).
// No imports beyond types: this file runs inside the local-DB worker, whose
// bundle is kept small (test/workerImports.test.ts).
//
// node_id is NULL for a standalone task (no note). Flags are 0/1 columns.
// `due_date` stays as the older name of `when_date`: both columns hold the
// same day, so a device that updates in between never reads a stale one.

const TEXT_COLUMNS = ["due_date", "recur", "updated_at", "when_date", "deadline", "recur_mode", "remind_at", "space_id", "time", "until", "done_at", "block_ref"];
const FLAG_COLUMNS = ["evening", "someday", "has_body"];

export function migrateTaskMirror(db: Database): void {
  const info = db.exec("PRAGMA table_info(tasks)")[0];
  // node_id was NOT NULL before standalone tasks; SQLite cannot drop that
  // constraint in place, so the table is rebuilt (rows kept as they are).
  const nodeId = info?.values.find((row) => row[1] === "node_id");
  if (nodeId && nodeId[3] === 1) {
    const extras = (info?.values ?? []).map((row) => String(row[1])).filter((name) => TEXT_COLUMNS.includes(name));
    db.run("CREATE TABLE tasks_rebuilt (id TEXT PRIMARY KEY, node_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo')");
    for (const column of extras) db.run(`ALTER TABLE tasks_rebuilt ADD COLUMN ${column} TEXT`);
    const names = ["id", "node_id", "title", "status", ...extras].join(", ");
    db.run(`INSERT INTO tasks_rebuilt (${names}) SELECT ${names} FROM tasks`);
    db.run("DROP TABLE tasks");
    db.run("ALTER TABLE tasks_rebuilt RENAME TO tasks");
  }
  const columns = new Set(db.exec("PRAGMA table_info(tasks)")[0]?.values.map((row) => row[1]));
  for (const column of TEXT_COLUMNS) {
    if (!columns.has(column)) db.run(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
  }
  for (const column of FLAG_COLUMNS) {
    if (!columns.has(column)) db.run(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  // Rows mirrored before when_date existed: its day was the due date. "later"
  // (parked) is todo + someday since the tasks module; the next sync rewrites both.
  if (!columns.has("when_date")) db.run("UPDATE tasks SET when_date = due_date WHERE due_date IS NOT NULL");
  db.run("UPDATE tasks SET status = 'todo', someday = 1 WHERE status = 'later'");
}

type SqlRunner = { run: (sql: string, params?: (string | number | null)[]) => unknown };

// Column order of the upsert: the row's fields as `values` lists them.
const UPSERT_COLUMNS = ["id", "node_id", "title", "status", "due_date", "when_date", "evening", "someday", "deadline", "recur", "recur_mode", "remind_at", "space_id", "has_body", "updated_at", "time", "until", "done_at", "block_ref"];

export function upsertTaskInto(db: SqlRunner, task: NodeTask): void {
  // `when_date` is the day; an older row or writer may only carry `due_date`.
  const when = task.when_date !== undefined ? task.when_date : task.due_date;
  const values = [
    task.id, task.node_id, task.title, task.status, when, when, task.evening ? 1 : 0, task.someday ? 1 : 0, task.deadline, task.recur,
    task.recur_mode, task.remind_at, task.space_id, task.has_body ? 1 : 0, task.updated_at, task.time, task.until, task.done_at, task.block_ref,
  ].map((value) => value ?? null);
  db.run(
    `INSERT INTO tasks (${UPSERT_COLUMNS}) VALUES (${UPSERT_COLUMNS.map(() => "?")})
     ON CONFLICT(id) DO UPDATE SET ${UPSERT_COLUMNS.slice(1).map((column) => `${column}=excluded.${column}`)}`,
    values,
  );
}

/** A mirrored row as the app's task: flags back to booleans, absent values
 *  left out so a row older than a field reads as the field being off. */
export function decodeTaskRow(row: Record<string, unknown>): NodeTask {
  const { evening, someday, has_body, ...rest } = row;
  return { ...rest, evening: evening === 1 || evening === true, someday: someday === 1 || someday === true, has_body: has_body === 1 || has_body === true } as NodeTask;
}
