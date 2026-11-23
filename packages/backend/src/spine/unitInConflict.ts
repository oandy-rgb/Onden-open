// Two refusals the database raises from inside a trigger, wherever the write came from, turned into coded errors where a transaction or savepoint ends (db.ts), so every
// caller (mutate, a cascade, a restore, a route) sees one 409 and no path has to know the SQLSTATE. A leaf file: db.ts imports it.
//   ON001  a system or background write to a unit that holds a conflict nobody has looked at (migration 206 sync_stamp_put_over): retryable.
//   ON237  a person or AI operator made or changed on a node that joined from another (migration 237 actors_written_on_the_centre): they are written on the main server.
import { CodedStatusError } from "../statusError.js";

class UnitInConflictError extends CodedStatusError {
  constructor() { super(409, "sync_unit_in_conflict", "a background write waits: the note it changes has two versions that nobody has chosen between yet"); }
}

class ActorsOnTheCentreError extends CodedStatusError {
  constructor() { super(409, "actors_on_main_server", "people and AI operators are added and changed on the main server; this device takes them from there"); }
}

/** The error to throw in place of `error`: one of the above for its SQLSTATE, `error` itself otherwise. */
export const translateUnitInConflict = (error: unknown): unknown => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ON001" ? new UnitInConflictError() : code === "ON237" ? new ActorsOnTheCentreError() : error;
};
