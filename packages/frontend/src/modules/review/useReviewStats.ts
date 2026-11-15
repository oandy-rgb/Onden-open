import { useLiveResource } from "./useLiveResource";

export type ReviewStats = {
  due: number; new: number; learned: number;
  /** The new cards today's daily cap still allows. */
  new_available?: number;
};

/** GET /api/review/stats (cheap count query), kept current by "changed"
 *  ticks and a 60s poll that runs regardless of the stream — due counts move
 *  with the clock (useLiveResource). `refresh` lets surfaces re-pull after a
 *  grading session. */
export function useReviewStats(intervalMs = 60_000): { stats: ReviewStats | null; refresh: () => Promise<void> } {
  const { value, refresh } = useLiveResource<ReviewStats, ReviewStats | null>("/api/review/stats", (raw) => raw, null, intervalMs);
  return { stats: value, refresh };
}
