-- 181: two per-subscription labels for the reader (Reading, 2026-11).
--
--   voice         'person' = a personal writer's feed, 'media' = a publication.
--                 The reader's 「聲音」 tag shows only the people. Chosen at
--                 subscribe time by a guess (modules/rss/voice.ts) and always
--                 changeable in the feed's settings. Existing feeds start as
--                 'media': nothing was guessed for them, and a wrong guess
--                 would be worse than none.
--   display_mode  how the feed's articles look in the list: 'text' (as before),
--                 'image' (a large picture card, for comics and photography),
--                 'video' (a play button in the list). A setting of the feed,
--                 shared by everyone who reads it, like always_fulltext.
--
-- Both are settings on the subscription row (migration 145): no domain event.
ALTER TABLE public.rss_subscriptions
  ADD COLUMN IF NOT EXISTS voice text NOT NULL DEFAULT 'media',
  ADD COLUMN IF NOT EXISTS display_mode text NOT NULL DEFAULT 'text';

DO $$ BEGIN
  ALTER TABLE public.rss_subscriptions
    ADD CONSTRAINT rss_subscriptions_voice_check CHECK (voice IN ('person', 'media'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.rss_subscriptions
    ADD CONSTRAINT rss_subscriptions_display_mode_check CHECK (display_mode IN ('text', 'image', 'video'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
