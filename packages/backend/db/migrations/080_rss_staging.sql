-- 080_rss_staging.sql
--
-- RSS 改版: articles are NOT nodes until saved ([[rss-rebuild]] revision,
-- 2026-07-03). The reader's stream becomes a BOUNDARY BUFFER — the same
-- posture as the outbox table, the mirror image for inbound content:
--
--   external feed → rss_staging (not yours yet) → explicit save → node (yours)
--
-- Why: ingest-as-hidden-node made every unread article a permanent
-- NODE_CREATED in the event log (authored by a pseudo "agent" actor purely so
-- arrivals would ride the inbox's governance queue), which conflated
-- subscription TRIAGE (skim / save / skip — high volume, skippable, no
-- consequence) with agent-change APPROVAL (low volume, must decide,
-- inverse-undo on reject). No shipping reader mixes those two queues
-- (Readwise Feed/Library, Matter Subscriptions/Queue, Hey Feed/Imbox). Saving
-- an article is now the moment NODE_CREATED fires — authored by the human,
-- meaning "I chose to keep this".
--
-- The row doubles as the guid TOMBSTONE (miniflux entry_tombstones): TTL
-- cleanup clears body + stamps tombstoned_at but KEEPS the row, so a feed
-- that still lists an old item can't resurrect it on the next poll.
--
-- This migration:
--   1. creates rss_staging;
--   2. carries every legacy article node's guid into staging (dedup memory
--      survives the model change);
--   3. deletes legacy HIDDEN article nodes nothing hangs off (no children, no
--      edges, not promoted) — the junk the old model minted; promoted or
--      quoted articles stay as the real notes they already are;
--   4. clears the feed actor's whole unreviewed backlog from the governance
--      queue (arrival events are no longer "changes awaiting review");
--   5. drops the dead 'rss_item' value from ai_suggestions' target CHECK
--      (the rss_items table died in 061).
--
-- Re-runnable: IF NOT EXISTS / ON CONFLICT / NOT EXISTS guards throughout.

CREATE TABLE IF NOT EXISTS public.rss_staging (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    guid text NOT NULL,
    title text NOT NULL,
    url text,
    published_at timestamp with time zone,
    body text DEFAULT '' NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    -- NULL = unseen. "Seen" (Readwise wording), deliberately not "read":
    -- skimming past is a non-event, not a debt.
    seen_at timestamp with time zone,
    -- Set when the human saved the article into the library; the created node.
    saved_node_id uuid,
    -- TTL cleanup stamps this + clears body; the row stays as the guid tombstone.
    tombstoned_at timestamp with time zone,
    CONSTRAINT rss_staging_pkey PRIMARY KEY (id),
    CONSTRAINT rss_staging_source_guid_key UNIQUE (source_node_id, guid),
    CONSTRAINT rss_staging_workspace_id_fkey FOREIGN KEY (workspace_id)
        REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT rss_staging_source_node_id_fkey FOREIGN KEY (source_node_id)
        REFERENCES public.content_nodes(id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE: if the saved note is later hard-deleted the
    -- tombstone must SURVIVE (the user discarded it; don't re-ingest it).
    CONSTRAINT rss_staging_saved_node_id_fkey FOREIGN KEY (saved_node_id)
        REFERENCES public.content_nodes(id) ON DELETE SET NULL
);

-- List pagination orders by COALESCE(published_at, fetched_at) DESC.
CREATE INDEX IF NOT EXISTS rss_staging_source_ts_idx
    ON public.rss_staging USING btree (source_node_id, COALESCE(published_at, fetched_at) DESC);
-- Unseen badge counts (the hot per-poll query).
CREATE INDEX IF NOT EXISTS rss_staging_unseen_idx
    ON public.rss_staging USING btree (source_node_id)
    WHERE seen_at IS NULL AND tombstoned_at IS NULL;

-- ── 2+3: carry legacy article nodes over ────────────────────────────────────
-- A legacy article = a content node carrying `_rss_guid` + `_rss_source`.

-- Legacy `_rss_published_at` came straight from feed pubDate strings — cast
-- defensively (garbage → NULL) so one weird feed can't fail the migration.
CREATE OR REPLACE FUNCTION pg_temp.onden_safe_ts(t text) RETURNS timestamptz AS $$
BEGIN
  RETURN NULLIF(t, '')::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.content_nodes') IS NULL THEN
    RETURN;
  END IF;

  -- Every legacy article's guid becomes a staging row (the dedup memory),
  -- provisionally pointing at its node; read state carries over as seen_at.
  -- The junk DELETE below flips saved_node_id back to NULL via the FK's
  -- ON DELETE SET NULL — so exactly the surviving nodes (promoted, quoted,
  -- linked) end up as "saved" rows, with no double representation.
  INSERT INTO rss_staging (workspace_id, source_node_id, guid, title, url, published_at, body, fetched_at, seen_at, saved_node_id)
  SELECT n.workspace_id,
         s.value::uuid,
         g.value,
         n.title,
         u.value,
         pg_temp.onden_safe_ts(p.value),
         COALESCE(n.markdown, ''),
         n.created_at,
         CASE WHEN NOT n.hidden OR r.value = 'true' THEN now() END,
         n.id
    FROM content_nodes n
    JOIN node_attributes g ON g.node_id = n.id AND g.key = '_rss_guid'
    JOIN node_attributes s ON s.node_id = n.id AND s.key = '_rss_source'
    JOIN content_nodes src ON src.id = s.value::uuid  -- source must still exist (FK)
    LEFT JOIN node_attributes u ON u.node_id = n.id AND u.key = '_rss_url'
    LEFT JOIN node_attributes p ON p.node_id = n.id AND p.key = '_rss_published_at'
    LEFT JOIN node_attributes r ON r.node_id = n.id AND r.key = '_rss_read'
   WHERE n.deleted_at IS NULL AND n.node_type = 'content'
  ON CONFLICT (source_node_id, guid) DO NOTHING;

  -- Delete the junk the old model minted: hidden, never promoted, and nothing
  -- hangs off it (no children, no edges — a quoted article keeps its node so
  -- the quote card's parent + highlight_source edge stay intact).
  -- node_attributes / node_tags / embeddings / positions all cascade.
  DELETE FROM content_nodes n
   WHERE n.hidden
     AND n.deleted_at IS NULL
     AND n.node_type = 'content'
     AND EXISTS (SELECT 1 FROM node_attributes a
                  WHERE a.node_id = n.id AND a.key = '_rss_source')
     AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = n.id)
     AND NOT EXISTS (SELECT 1 FROM node_edges e
                      WHERE e.source_node_id = n.id OR e.target_node_id = n.id);

  -- The reader no longer keys read state off nodes.
  DELETE FROM node_attributes WHERE key = '_rss_read';

  -- 4: the feed actor's unreviewed backlog leaves the governance queue —
  -- arrivals are triage, not changes awaiting approval. Sweep-shaped
  -- (decision='approved', reviewed_by=the feed actor itself).
  INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by)
  SELECT e.id, e.workspace_id, 'approved', a.id::text
    FROM domain_events e
    JOIN actors a ON a.workspace_id = e.workspace_id AND a.external_id = 'rss-feed'
   WHERE e.actor_id = a.id::text
     AND NOT EXISTS (SELECT 1 FROM event_reviews r WHERE r.event_id = e.id)
  ON CONFLICT (event_id) DO NOTHING;
END $$;

-- ── 5: drop the dead 'rss_item' enum value (rss_items died in 061) ──────────
DO $$
BEGIN
  IF to_regclass('public.ai_suggestions') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM ai_suggestions WHERE target_type = 'rss_item';
  ALTER TABLE ai_suggestions DROP CONSTRAINT IF EXISTS ai_suggestions_target_type_check;
  ALTER TABLE ai_suggestions ADD CONSTRAINT ai_suggestions_target_type_check
    CHECK (target_type = ANY (ARRAY['node'::text, 'edge'::text]));
END $$;
