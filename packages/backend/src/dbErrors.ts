// Which database failures are worth running the same work again.
//
// Transient = the statement was fine and the state of the world made it fail:
// a serialization failure or deadlock (the other transaction won), a lock that
// timed out, the pool or server out of connections, a dropped connection.
// Everything else (constraint, syntax, validation, plain Error) is
// deterministic: running it again fails the same way, so callers must not.

/** SQLSTATE codes (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "53300", // too_many_connections
  "57P01", // admin_shutdown (server restarting)
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ECONNABORTED",
]);

// node-postgres raises these without a code.
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /client has encountered a connection error/i,
];

export function isTransientDbError(err: unknown): boolean {
  // Follow `cause` (wrapped errors), bounded so a cycle cannot loop.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string") {
      if (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code)) return true;
      // Class 08: connection exception.
      if (e.code.length === 5 && e.code.startsWith("08")) return true;
    }
    if (typeof e.message === "string" && TRANSIENT_MESSAGES.some((re) => re.test(e.message as string))) return true;
    cur = e.cause;
  }
  return false;
}
