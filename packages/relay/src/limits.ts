// Every limit the relay enforces, in one place. Docs: docs/architecture/send-to-phone-relay.md.

export const MiB = 1024 * 1024;

/** Total stored bytes per session (stored ciphertext, counting the current version of each object). */
export const SESSION_MAX_BYTES = 200 * MiB;
/** One object: a chunk (up to 4 MiB of data plus the 16-byte tag) or a manifest. */
export const MAX_OBJECT_BYTES = 4 * MiB + 1024;
export const MAX_OBJECTS_PER_SESSION = 2000;
export const MAX_HELLO_BYTES = 64;

/** Session ends this long after its last write (every write, including the progress list, restarts it). */
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Even a session that is written to forever ends this long after it was created. */
export const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Sessions alive at once on one relay, all sources together. */
export const MAX_ACTIVE_SESSIONS = 500;
/** Per source address (CF-Connecting-IP). */
export const MAX_REQUESTS_PER_MINUTE_PER_IP = 300;
export const MAX_NEW_SESSIONS_PER_HOUR_PER_IP = 10;

/** Durable Object SQLite values are limited (2 MB per row, unverified here), so the adapter stores objects in pieces this big. */
export const STORAGE_PART_BYTES = 1 * MiB;
