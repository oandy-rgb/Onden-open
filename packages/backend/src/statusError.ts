/** A refusal the caller must see, with the HTTP status it maps to. The shared
 *  boundary (httpError.ts apiOnError) answers `{ error: message }` with that
 *  status, so a module can throw one without core importing the module. */
export type RefusalStatus = 400 | 403 | 404 | 409 | 410 | 413 | 422 | 503 | 507;

/** The base of every error class that is "a refusal with a status": a new one
 *  extends this (or CodedStatusError), it does not extend Error. */
export class StatusError extends Error {
  constructor(readonly status: RefusalStatus, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A StatusError that also names a stable `code`: answered as
 *  `{ error: code, detail: message }`, for a refusal the client branches on. */
export class CodedStatusError extends StatusError {
  constructor(status: RefusalStatus, readonly code: string, message: string) {
    super(status, message);
  }
}
