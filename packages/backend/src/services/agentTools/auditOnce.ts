// Refusals at the agent gate (not allowed, rate limited) are audited, but a
// token that keeps knocking must not write a domain_events row per knock: the
// table is append-only. At most one row per token + reason per window; the
// refusals in between still happen, they are just not re-recorded. Per process,
// like the in-memory rate limiter; with several replicas each writes its own one.

const WINDOW_MS = 60_000;
const lastAudited = new Map<string, number>();

/** True when this refusal should be audited now (and records that it was). */
export function auditRefusalOnce(tokenKey: string, reason: string, now = Date.now()): boolean {
  const key = `${tokenKey}|${reason}`;
  const last = lastAudited.get(key);
  if (last !== undefined && now - last < WINDOW_MS) return false;
  if (lastAudited.size > 5000) {
    for (const [k, t] of lastAudited) if (now - t >= WINDOW_MS) lastAudited.delete(k);
  }
  lastAudited.set(key, now);
  return true;
}

/** Test seam. */
export function _resetAuditOnce(): void { lastAudited.clear(); }
