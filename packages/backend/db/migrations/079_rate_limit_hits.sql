-- 079_rate_limit_hits.sql
--
-- Backing store for the SHARED, cross-instance rate limiter (PgRateLimiter). One
-- row per request hit; the limiter counts hits inside the sliding window per
-- token and opportunistically prunes aged-out rows. Only used when
-- RATE_LIMIT_BACKEND=pg (multi-replica deployments) — the default in-memory
-- limiter never touches it. Not workspace-scoped: rate limits are per agent
-- token, which is already workspace-bound at mint time.

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
    token_id text NOT NULL,
    hit_at timestamp with time zone DEFAULT now() NOT NULL
);

-- The limiter filters by (token_id, hit_at >= window_start) and prunes by
-- (token_id, hit_at < cutoff); this index serves both.
CREATE INDEX IF NOT EXISTS rate_limit_hits_token_time_idx
    ON public.rate_limit_hits USING btree (token_id, hit_at);
