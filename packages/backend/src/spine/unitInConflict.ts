// A system or background write refused because the unit it changes holds a conflict nobody has looked at (migration 206 sync_stamp_put_over, SQLSTATE ON001).
// The database raises it from inside a stamp trigger, wherever the write came from; db.ts turns it into this error where a transaction or savepoint ends, so every
// caller (mutate, a cascade, a restore, a route) sees one retryable 409 and no path has to know the SQLSTATE. A leaf file: db.ts imports it.
import { CodedStatusError } from "../statusError.js";

class UnitInConflictError extends CodedStatusError {
  constructor() { super(409, "sync_unit_in_conflict", "a background write waits: the note it changes has two versions that nobody has chosen between yet"); }
}

/** The error to throw in place of `error`: this one when the database refused a system write beside a conflict, `error` itself otherwise. */
export const translateUnitInConflict = (error: unknown): unknown => ((error as { code?: unknown } | null)?.code === "ON001" ? new UnitInConflictError() : error);
