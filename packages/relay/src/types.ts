/** What a store call answers: a value, or an HTTP status with a stable code. Codes never say whether a session exists beyond what the status already does. */
export type Outcome<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: RelayErrorCode };

export type RelayErrorCode =
  | "not_found" // no such session, wrong token, or no such object: deliberately indistinguishable
  | "unauthorized" // no credentials presented at all
  | "bad_request"
  | "conflict"
  | "too_large"
  | "session_full"
  | "unsupported_media_type"
  | "rate_limited"
  | "capacity";

export interface ObjectEntry {
  name: string;
  size: number;
}

/** The calls the HTTP layer makes on one session. Implemented by `SessionCore` (and, over RPC, by the Durable Object). */
export interface SessionApi {
  putHello(hello: Uint8Array): Promise<Outcome<null>>;
  getHello(): Promise<Outcome<Uint8Array>>;
  /** `readTokenHash` is required on the first write of a session and ignored afterwards. */
  putObject(name: string, bytes: Uint8Array, writeToken: string, readTokenHash: string | undefined): Promise<Outcome<null>>;
  listObjects(readToken: string): Promise<Outcome<ObjectEntry[]>>;
  getObject(name: string, readToken: string): Promise<Outcome<Uint8Array>>;
  /** The phone has everything: delete the session now. */
  destroy(readToken: string): Promise<Outcome<null>>;
}

export interface RateLimiterApi {
  /** Count one request from a source; `newSession` also counts against the new-session allowance. */
  hit(newSession: boolean): Promise<Outcome<null>>;
}

export interface RegistryApi {
  /** Idempotent per session id. Fails with `capacity` when the relay is full. */
  acquire(sessionId: string, hardExpiresAt: number): Promise<Outcome<null>>;
  release(sessionId: string): Promise<void>;
}
