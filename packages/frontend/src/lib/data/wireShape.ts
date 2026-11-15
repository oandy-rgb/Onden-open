// The shape check between "the server answered" and "written to the local copy".
// api() hands back whatever JSON came (a proxy's error page, a half-cut body, a
// server of another version) typed as Bootstrap / SyncDelta; the mirror's
// writers (localDbPersist, the worker's applySync) and the cursor logic in
// syncEngine then trust it. This checks only what those writers and the cursor
// read: containers are the right kind and each row has the string id they key
// on. Extra fields are ignored (a newer server with an older page must work);
// a missing optional channel is fine. It is not the contract's schema: zod
// stays out of the boot bundle, and wireShape.test.ts holds the two together.
//
// A failed check throws before anything is written or moved: the mirror and
// its event cursor keep their last good state and the caller's ordinary sync
// failure path (retry later, the "sync has a problem" state) takes over.
import type { Bootstrap } from "../api";
import type { SyncDelta } from "../localDb";

/** The answer was understood as JSON but is not the shape this page writes. Not a TypeError: the server was reached. */
export class WireShapeError extends Error {
  constructor(what: string) {
    super(`Unexpected server answer: ${what}`);
    this.name = "WireShapeError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function record(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new WireShapeError(`${what} is not an object`);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new WireShapeError(`${what} is not a list`);
  return v;
}

/** A list whose entries are objects carrying the given string fields. */
function rows(v: unknown, what: string, fields: readonly string[]): void {
  for (const row of list(v, what)) {
    const r = record(row, `${what} entry`);
    for (const field of fields) if (typeof r[field] !== "string") throw new WireShapeError(`${what} entry without ${field}`);
  }
}

function ids(v: unknown, what: string): void {
  for (const id of list(v, what)) if (typeof id !== "string") throw new WireShapeError(`${what} entry is not an id`);
}

/** An event cursor the mirror can store: a decimal string (bigint over JSON) or a whole number. */
function cursor(v: unknown, what: string): void {
  if (typeof v === "string" ? /^\d+$/.test(v) : Number.isSafeInteger(v) && (v as number) >= 0) return;
  throw new WireShapeError(`${what} is not an event cursor`);
}

function upsertDelete(v: unknown, what: string, fields: readonly string[], deleteFields: readonly string[] | null): void {
  const channel = record(v, what);
  rows(channel.upsert, `${what}.upsert`, fields);
  if (deleteFields) rows(channel.delete, `${what}.delete`, deleteFields);
  else ids(channel.delete, `${what}.delete`);
}

/** Before a bootstrap (after bootstrapWire decoded it) is stored. `?nodes=none` answers
 *  (`nodes_omitted`) leave the per-note channels out, so those are not required then. */
export function assertBootstrapShape(data: unknown): asserts data is Bootstrap {
  const b = record(data, "bootstrap");
  if (typeof record(b.workspace, "workspace").id !== "string") throw new WireShapeError("workspace without id");
  if (b.last_event_id !== undefined) cursor(b.last_event_id, "last_event_id");
  if (b.membership_epoch !== undefined && typeof b.membership_epoch !== "number") throw new WireShapeError("membership_epoch is not a number");
  list(b.suggestions, "suggestions");
  const perNote = b.nodes_omitted === true ? ["nodes", "edges", "tasks"].filter((k) => b[k] !== undefined) : ["nodes", "edges", "tasks"];
  for (const key of perNote) rows(b[key], key, ["id"]);
  if (b.attributes !== undefined) rows(b.attributes, "attributes", ["node_id", "key"]);
  for (const key of ["tags", "pointers"]) if (b[key] !== undefined) rows(b[key], key, ["id"]);
}

/** Before a sync delta (`POST /api/sync`, or one built from a membership projection) is stored or its cursor used. */
export function assertSyncDeltaShape(data: unknown): asserts data is SyncDelta {
  const d = record(data, "sync delta");
  cursor(d.last_event_id, "last_event_id");
  if (d.head_event_id !== undefined) cursor(d.head_event_id, "head_event_id");
  if (d.membership_epoch !== undefined && typeof d.membership_epoch !== "number") throw new WireShapeError("membership_epoch is not a number");
  upsertDelete(d.nodes, "nodes", ["id"], null);
  upsertDelete(d.edges, "edges", ["id"], null);
  upsertDelete(d.tasks, "tasks", ["id"], null);
  if (d.pointers !== undefined) upsertDelete(d.pointers, "pointers", ["id"], null);
  if (d.attributes !== undefined) upsertDelete(d.attributes, "attributes", ["node_id", "key"], ["node_id", "key"]);
  if (d.canvas_memberships !== undefined) rows(record(d.canvas_memberships, "canvas_memberships").upsert, "canvas_memberships.upsert", []);
  for (const key of ["note_anchors", "note_link_bindings"] as const) {
    if (d[key] !== undefined) rows(record(d[key], key).upsert, `${key}.upsert`, []);
  }
  if (d.tags !== undefined) rows(d.tags, "tags", ["id"]);
  if (d.workspace !== undefined && d.workspace !== null && typeof record(d.workspace, "workspace").name !== "string") throw new WireShapeError("workspace without name");
}
