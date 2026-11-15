-- 145: RSS subscriptions are settings in a table, no longer notes.
--
-- Product decision (2026-10-29): a subscription is a SETTING, not content. Since
-- migration 061 each one was a note marked `_rss_kind = 'source'` with its feed
-- state in reserved `_rss_*` attributes, and people found "a note you cannot
-- write" odd. Subscriptions now live in `rss_subscriptions`, managed on the
-- Reading page; the note tree holds no feed notes. 061 chose notes so that
-- subscriptions would merge across devices, be recoverable from history and
-- follow space permissions. The first two do not matter for a setting; the
-- third is kept: every row carries `space_id` and is read under the same space
-- rule as a note (services/readPolicy.ts readableSpaceScopeSql), so a
-- subscription in a space you cannot see stays invisible, with its articles.
--
-- What this migration does, in order:
--   1. creates rss_subscriptions (one column per `_rss_*` feed-state attribute
--      of modules/rss/sources.ts: etag, last_modified, fetch_interval_minutes,
--      last_fetched_at, last_error, auto_tag_id, embed, auto_dismiss_days,
--      default_tag_ids + default_parent_id (the save default), always_fulltext);
--   2. moves every LIVE source note that has a feed URL into the table, KEEPING
--      THE NOTE'S ID as the subscription's id. Saved articles carry
--      `_rss_source = <that id>` as their origin, so they keep pointing at the
--      right subscription with no rewrite, and "the same article is saved
--      once" (rss_staging.saved_node_id, save.ts) stays correct;
--   3. points rss_staging at the table: `source_node_id` becomes
--      `subscription_id`, the foreign key moves from content_nodes to
--      rss_subscriptions. Staged articles, their tombstones and the per-person
--      "seen" marks (rss_seen, keyed by the staging row) move with their feed.
--      Staging rows of a feed that was NOT carried over (a source note in the
--      trash = an unsubscribed feed, or one with no URL) are deleted: they were
--      only a stream buffer. The saved NOTES are never touched;
--   4. decides what happens to each source NOTE:
--        * it KEEPS as an ordinary note (source_type 'manual', every `_rss_*`
--          attribute removed) when anything hangs off it: a child note (saved
--          articles; live or in the trash), a body someone wrote (anything but
--          the text the app generated), a tag, a link, a pointer, a whiteboard
--          card, an attribute of the person's own, or it is the workspace home.
--          Children are not moved. A feed whose save default was "under the
--          feed's note" keeps filing there (default_parent_id = the note);
--        * otherwise it goes to the trash (deleted_at + deleted_by_event_id,
--          with a NODE_DELETED event by system actor 'migration:145', like 144),
--          so it can be restored from History;
--        * a source note already in the trash stays there, only its `_rss_*`
--          attributes go; a source note with no feed URL stays where it is,
--          only its markers go. Nothing is ever hard-deleted;
--   5. drops the queued/finished `rss_fetch` outbox rows: their payload named
--      the source note (`sourceNodeId`); the scheduler files fresh ones
--      (`subscriptionId`) within a minute.
--
-- The legacy save default ("tags of the feed note + auto_tag, under the feed
-- note", used while `_rss_default_tags` was absent) becomes an explicit
-- default_tag_ids/default_parent_id, so where articles are saved is unchanged.
--
-- Raw SQL and no domain events beyond the NODE_DELETED above, like every data
-- migration: it records a change of representation, not a user's edit.
-- Re-runnable: the table is created IF NOT EXISTS, the source notes are found
-- by the marker this migration removes, and the staging change is guarded by
-- the column it renames. Rows of the new table are never overwritten.
--
-- drill: allows notes_live, notes_deleted, attributes

CREATE TABLE IF NOT EXISTS public.rss_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    -- The space that decides who reads it (same rule as a note). A deleted
    -- space leaves the row inert: it is neither listed nor fetched.
    space_id uuid NOT NULL,
    title text NOT NULL,
    -- The feed address, normalised by modules/rss/feedUrl.ts at the boundary.
    url text NOT NULL,
    created_by_actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Conditional-GET validators and the fetch loop's own state.
    etag text,
    last_modified text,
    fetch_interval_minutes integer DEFAULT 60 NOT NULL,
    last_fetched_at timestamp with time zone,
    last_error text,
    -- The tag articles are filed under when no save default is set.
    auto_tag_id uuid,
    embed boolean DEFAULT false NOT NULL,
    -- Unseen-aging override in days; NULL = the module default.
    auto_dismiss_days integer,
    -- The feed's own save default: NULL = none set (fall back to the module
    -- default); an array (possibly empty) = explicit.
    default_tag_ids uuid[],
    default_parent_id uuid,
    always_fulltext boolean DEFAULT false NOT NULL,
    CONSTRAINT rss_subscriptions_pkey PRIMARY KEY (id),
    CONSTRAINT rss_subscriptions_interval_check CHECK (fetch_interval_minutes >= 1),
    CONSTRAINT rss_subscriptions_dismiss_check CHECK (auto_dismiss_days IS NULL OR auto_dismiss_days >= 1),
    CONSTRAINT rss_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id)
        REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT rss_subscriptions_space_id_fkey FOREIGN KEY (space_id)
        REFERENCES public.spaces(id) ON DELETE CASCADE,
    CONSTRAINT rss_subscriptions_created_by_fkey FOREIGN KEY (created_by_actor_id)
        REFERENCES public.actors(id) ON DELETE SET NULL,
    CONSTRAINT rss_subscriptions_auto_tag_fkey FOREIGN KEY (auto_tag_id)
        REFERENCES public.content_nodes(id) ON DELETE SET NULL,
    CONSTRAINT rss_subscriptions_default_parent_fkey FOREIGN KEY (default_parent_id)
        REFERENCES public.content_nodes(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.rss_subscriptions IS 'RSS subscriptions: settings, not notes (migration 145). Read under the space rule via space_id; written by modules/rss/sources.ts only.';

CREATE INDEX IF NOT EXISTS rss_subscriptions_space_idx ON public.rss_subscriptions USING btree (workspace_id, space_id);

-- ── helpers (session-local; they vanish with the connection) ────────────────

CREATE OR REPLACE FUNCTION pg_temp.m145_attr(p_node uuid, p_key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT value FROM node_attributes WHERE node_id = p_node AND key = p_key $$;

-- Reserved attributes were free text: a bad value must not fail the migration.
CREATE OR REPLACE FUNCTION pg_temp.m145_int(t text) RETURNS integer AS $$
BEGIN
  RETURN NULLIF(btrim(t), '')::integer;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.m145_ts(t text) RETURNS timestamptz AS $$
BEGIN
  RETURN NULLIF(btrim(t), '')::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.m145_uuid(t text) RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(btrim(t), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- "a,b,c" → the valid uuids, in order, without repeats.
CREATE OR REPLACE FUNCTION pg_temp.m145_uuids(t text) RETURNS uuid[] AS $$
  SELECT COALESCE(array_agg(d.u ORDER BY d.ord), '{}'::uuid[])
    FROM (SELECT DISTINCT ON (z.u) z.u, z.ord
            FROM (SELECT pg_temp.m145_uuid(s.x) AS u, s.ord
                    FROM unnest(string_to_array(COALESCE(t, ''), ',')) WITH ORDINALITY AS s(x, ord)) z
           WHERE z.u IS NOT NULL
           ORDER BY z.u, z.ord) d
$$ LANGUAGE sql STABLE;

-- ── 1: the source notes ─────────────────────────────────────────────────────

DROP TABLE IF EXISTS pg_temp.m145_src;
CREATE TEMP TABLE m145_src ON COMMIT DROP AS
SELECT n.id, n.workspace_id, n.title, n.created_at, n.deleted_at, n.markdown,
       COALESCE(n.space_id, (SELECT s.id FROM spaces s WHERE s.workspace_id = n.workspace_id AND s.is_default)) AS space_id,
       btrim(COALESCE(pg_temp.m145_attr(n.id, '_rss_url'), '')) AS url,
       EXISTS (SELECT 1 FROM node_attributes d WHERE d.node_id = n.id AND d.key = '_rss_default_tags') AS has_default,
       false AS migrate,
       false AS keep,
       NULL::uuid AS auto_tag_id,
       '{}'::uuid[] AS own_tag_ids,
       NULL::uuid[] AS default_tag_ids,
       NULL::uuid AS default_parent_id
  FROM content_nodes n
 WHERE n.node_type = 'content'
   AND EXISTS (SELECT 1 FROM node_attributes k WHERE k.node_id = n.id AND k.key = '_rss_kind' AND k.value = 'source');

-- A live source with a feed URL and a space becomes a subscription.
UPDATE m145_src s SET migrate = (s.deleted_at IS NULL AND s.url <> '' AND s.space_id IS NOT NULL);

-- Which notes stay: anything that was ever more than the app's own marker. The
-- generated body is "Subscribed feed: <url>" (createSource) or the bare url
-- (migration 061).
UPDATE m145_src s SET keep = (
     EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = s.id)
  OR btrim(COALESCE(s.markdown, ''), E' \t\r\n') NOT IN ('', s.url, 'Subscribed feed: ' || s.url)
  OR EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = s.id)
  OR EXISTS (SELECT 1 FROM node_edges e WHERE e.source_node_id = s.id OR e.target_node_id = s.id)
  OR EXISTS (SELECT 1 FROM note_pointers p WHERE p.parent_id = s.id OR p.target_id = s.id)
  OR EXISTS (SELECT 1 FROM node_positions p WHERE p.node_id = s.id OR p.sub_canvas_id = s.id OR p.surface = s.id::text)
  OR EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = s.id AND left(a.key, 5) <> '_rss_')
  OR EXISTS (SELECT 1 FROM workspaces w WHERE w.home_node_id = s.id)
) WHERE s.migrate;

-- auto_tag: stored as the tag's id, or (an older source) its title when exactly
-- one live tag has it.
UPDATE m145_src s SET auto_tag_id = CASE
  WHEN pg_temp.m145_uuid(pg_temp.m145_attr(s.id, '_rss_auto_tag')) IS NOT NULL THEN
    (SELECT t.id FROM content_nodes t
      WHERE t.id = pg_temp.m145_uuid(pg_temp.m145_attr(s.id, '_rss_auto_tag')) AND t.node_type = 'class_tag')
  ELSE
    (SELECT CASE WHEN count(*) = 1 THEN min(t.id::text)::uuid END FROM content_nodes t
      WHERE t.workspace_id = s.workspace_id AND t.node_type = 'class_tag' AND t.deleted_at IS NULL
        AND t.title = pg_temp.m145_attr(s.id, '_rss_auto_tag'))
  END
WHERE s.migrate;

UPDATE m145_src s SET own_tag_ids = ARRAY(
  SELECT nt.tag_id FROM node_tags nt
    JOIN content_nodes t ON t.id = nt.tag_id AND t.node_type = 'class_tag' AND t.deleted_at IS NULL
   WHERE nt.node_id = s.id ORDER BY t.title, t.id)
WHERE s.migrate;

-- The save default. Explicit (`_rss_default_tags` present): carried as is. Else
-- the legacy rule: the note's own tags and the auto tag, filed under the note.
UPDATE m145_src s SET
  default_tag_ids = CASE
    WHEN s.has_default THEN pg_temp.m145_uuids(pg_temp.m145_attr(s.id, '_rss_default_tags'))
    WHEN cardinality(s.own_tag_ids) > 0 OR s.auto_tag_id IS NOT NULL THEN
      s.own_tag_ids || CASE WHEN s.auto_tag_id IS NOT NULL AND NOT s.auto_tag_id = ANY(s.own_tag_ids)
                            THEN ARRAY[s.auto_tag_id] ELSE '{}'::uuid[] END
  END,
  default_parent_id = CASE
    WHEN s.has_default THEN
      (SELECT p.id FROM content_nodes p
        WHERE p.id = pg_temp.m145_uuid(pg_temp.m145_attr(s.id, '_rss_default_parent'))
          AND p.workspace_id = s.workspace_id AND p.node_type = 'content')
    WHEN (cardinality(s.own_tag_ids) > 0 OR s.auto_tag_id IS NOT NULL) AND s.keep THEN s.id
  END
WHERE s.migrate;

-- ── 2: the table rows ───────────────────────────────────────────────────────

INSERT INTO rss_subscriptions (
  id, workspace_id, space_id, title, url, created_by_actor_id, created_at,
  etag, last_modified, fetch_interval_minutes, last_fetched_at, last_error,
  auto_tag_id, embed, auto_dismiss_days, default_tag_ids, default_parent_id, always_fulltext)
SELECT s.id, s.workspace_id, s.space_id, s.title, s.url,
       (SELECT a.id FROM domain_events e JOIN actors a ON a.id::text = e.actor_id
         WHERE e.workspace_id = s.workspace_id AND e.target_id = s.id::text AND e.event_type = 'NODE_CREATED'
         ORDER BY e.id LIMIT 1),
       s.created_at,
       pg_temp.m145_attr(s.id, '_rss_etag'),
       pg_temp.m145_attr(s.id, '_rss_last_modified'),
       GREATEST(COALESCE(pg_temp.m145_int(pg_temp.m145_attr(s.id, '_rss_fetch_interval_minutes')), 60), 1),
       pg_temp.m145_ts(pg_temp.m145_attr(s.id, '_rss_last_fetched_at')),
       pg_temp.m145_attr(s.id, '_rss_last_error'),
       s.auto_tag_id,
       COALESCE(pg_temp.m145_attr(s.id, '_rss_embed'), '') = 'true',
       -- (GREATEST ignores NULL: keep "no override" as NULL.)
       CASE WHEN pg_temp.m145_int(pg_temp.m145_attr(s.id, '_rss_auto_dismiss_days')) IS NOT NULL
            THEN GREATEST(pg_temp.m145_int(pg_temp.m145_attr(s.id, '_rss_auto_dismiss_days')), 1) END,
       s.default_tag_ids,
       s.default_parent_id,
       COALESCE(pg_temp.m145_attr(s.id, '_rss_always_fulltext'), '') = 'true'
  FROM m145_src s
 WHERE s.migrate
ON CONFLICT (id) DO NOTHING;

-- ── 3: the staging buffer points at the table ──────────────────────────────

DO $stage$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'rss_staging' AND column_name = 'source_node_id') THEN
    ALTER TABLE public.rss_staging DROP CONSTRAINT IF EXISTS rss_staging_source_node_id_fkey;
    -- Only a feed that was carried over keeps its stream (see the header).
    DELETE FROM public.rss_staging WHERE source_node_id NOT IN (SELECT id FROM public.rss_subscriptions);
    ALTER TABLE public.rss_staging RENAME COLUMN source_node_id TO subscription_id;
    ALTER TABLE public.rss_staging RENAME CONSTRAINT rss_staging_source_guid_key TO rss_staging_subscription_guid_key;
    ALTER INDEX public.rss_staging_source_ts_idx RENAME TO rss_staging_subscription_ts_idx;
    ALTER TABLE public.rss_staging ADD CONSTRAINT rss_staging_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES public.rss_subscriptions(id) ON DELETE CASCADE;
  END IF;
END $stage$;

-- ── 4: the source notes ────────────────────────────────────────────────────

-- Not carried over, not kept: to the trash, restorable (the same soft delete a
-- person's delete does, as migration 144 does it).
DO $trash$
DECLARE
  r record;
  ev bigint;
BEGIN
  FOR r IN SELECT id, workspace_id, title FROM pg_temp.m145_src WHERE migrate AND NOT keep ORDER BY id LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:145', 'NODE_DELETED', 'node', r.id::text,
            jsonb_build_object('title', r.title),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.rss_subscriptions_table'))
    RETURNING id INTO ev;
    UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = ev, updated_at = now()
     WHERE id = r.id AND deleted_at IS NULL;
  END LOOP;
END $trash$;

-- Kept: an ordinary note now, so it shows in the tree like any other.
UPDATE content_nodes n SET source_type = 'manual', updated_at = now()
  FROM m145_src s WHERE s.id = n.id AND s.migrate AND s.keep AND n.source_type = 'rss';

-- Every source note, whatever happened to it, loses its feed attributes.
DELETE FROM node_attributes a USING m145_src s WHERE a.node_id = s.id AND left(a.key, 5) = '_rss_';

-- ── 5: queued fetches named the source note ────────────────────────────────

DELETE FROM outbox WHERE effect_kind = 'rss_fetch';
