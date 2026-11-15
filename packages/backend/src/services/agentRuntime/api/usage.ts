// The api session's progress log and token use: diagnostic lines (never synced, never
// restored) and the running totals on the session row.
import { q } from "../../../db.js";
import type { AgentSession } from "../../agentSessionStore.js";
import type { TurnUsage } from "./protocols/index.js";

/** The owner's own prices for the service, USD per million tokens (credential settings). Blank = tokens only. */
export type Prices = { inputPerM: number; outputPerM: number };

/** Micro-USD estimate, or null when the owner wrote no prices. USD per million tokens equals micro-USD per token,
 *  so no scaling is needed. Cache reads count at a tenth and cache writes at 1.25 times the input price. */
export function estimateMicroUsd(prices: Prices | null, u: TurnUsage): number | null {
  if (!prices) return null;
  return Math.round((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * prices.inputPerM + u.output * prices.outputPerM);
}

const logSeq = new Map<string, number>();
/** Append one line to the session's progress log (diagnostic, never synced). */
export async function logLine(sessionId: string, kind: "action" | "search" | "message" | "usage" | "read", body: Record<string, unknown>): Promise<void> {
  const seq = (logSeq.get(sessionId) ?? 1);
  logSeq.set(sessionId, seq + 1);
  await q(`INSERT INTO agent_session_events (session_id, seq, kind, body) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id, seq) DO NOTHING`, [sessionId, seq, kind, body]);
}

/** Add one reply's usage to the session row. Cost stays NULL when the owner wrote no prices. */
export async function recordUsage(session: AgentSession, prices: Prices | null, u: TurnUsage): Promise<void> {
  const cost = estimateMicroUsd(prices, u);
  await q(
    `UPDATE agent_sessions SET turns = turns + 1, input_tokens = input_tokens + $2, output_tokens = output_tokens + $3,
            cache_read_tokens = cache_read_tokens + $4,
            cost_estimate_micro_usd = CASE WHEN $5::bigint IS NULL THEN cost_estimate_micro_usd ELSE COALESCE(cost_estimate_micro_usd, 0) + $5::bigint END
      WHERE id = $1`,
    [session.id, u.input + u.cacheWrite, u.output, u.cacheRead, cost]);
  await logLine(session.id, "usage", { input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead });
}


/** The session ended: its line counter is no longer needed. */
export function forgetLog(sessionId: string): void {
  logSeq.delete(sessionId);
}
