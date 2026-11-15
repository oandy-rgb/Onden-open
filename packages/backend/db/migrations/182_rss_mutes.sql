-- 182: 少看這種 — a person's own mutes in the reader (Reading, 2026-11).
--
-- A mute hides articles from THIS person's list for a while; nothing is
-- deleted and nobody else's list changes (the same posture as rss_seen,
-- migration 092: per person, no domain event). Two kinds, one row each:
--   keyword          a word matched against article TITLES only;
--   subscription_id  a whole feed ("靜音一週").
-- Every mute ends by itself at expires_at (a week by default); the 來源 sheet
-- lists the active ones and can end one early (DELETE). Expired rows are inert
-- and swept by the next write of the same person.
CREATE TABLE IF NOT EXISTS public.rss_mutes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  subscription_id uuid REFERENCES public.rss_subscriptions(id) ON DELETE CASCADE,
  keyword text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT rss_mutes_one_target CHECK ((subscription_id IS NULL) <> (keyword IS NULL)),
  CONSTRAINT rss_mutes_keyword_length CHECK (keyword IS NULL OR char_length(keyword) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS rss_mutes_actor_idx ON public.rss_mutes (workspace_id, actor_id, expires_at);
