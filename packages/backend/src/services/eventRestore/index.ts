// Event restore: undo one recorded domain event by appending its inverse.
// A domain that owns the inverse of its own events registers it through
// services/restoreContract.ts instead of being imported here.
export { restoreEvent, previewEventRestore } from "./restore.js";
export type { EventRow, RestoreResult, RestoreError } from "../restoreContract.js";
