// Errors the local database worker reports by code, so the UI decides by the
// code and translates its own text, never by comparing an English message.

export type LocalDbErrorCode = "backup_foreign_account" | "local_copy_unavailable" | "local_copy_too_new";

export class LocalDbError extends Error {
  constructor(readonly code: LocalDbErrorCode, message: string) {
    super(message);
    this.name = "LocalDbError";
  }
}

export function localDbErrorCode(error: unknown): LocalDbErrorCode | null {
  return error instanceof LocalDbError ? error.code : null;
}
