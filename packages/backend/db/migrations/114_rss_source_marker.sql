-- RSS sources are marked by an internal attribute; the #subscription tag retires
-- (user decision 2026-10-18, "A + save destination").
--
-- A source used to be a note carrying the reserved #subscription tag and a
-- `_rss_url`. It is now a note carrying `_rss_kind = 'source'`
-- (modules/rss/sources.ts SOURCE_SQL), a reserved `_rss_` key only the RSS
-- module writes. This migration moves every existing source to the marker and
-- takes the tag out of service:
--
--   (a) mark: every content note (live or in the trash, so a restored source
--       is still a feed) that carries the subscription tag and a `_rss_url`
--       gets `_rss_kind = 'source'`;
--   (b) detach: the subscription tag is removed from those notes — it carried
--       no meaning beyond "this is a feed", which the marker now says;
--   (c) retire: the tag loses its reserved key, so it is an ordinary tag again
--       (the reserved-tag guards refuse to delete or merge a KEYED tag,
--       services/reservedTags.ts assertTagDefinitionChange). Then, only when
--       nothing uses it any more — no note still tagged with it by hand, no
--       live child tag — it is moved to the trash (deleted_at, restorable),
--       never purged. A tag someone applied to their own notes stays live as
--       an ordinary tag.
--
-- "The subscription tag" is the row holding reserved_key 'subscription' (any
-- node_type or lifecycle: migration 106 keyed flipped and trashed rows too),
-- and — the runtime adopt rule (reservedTags.adoptReservedTag) — a live,
-- keyless ROOT class_tag titled 'subscription' in a workspace where no row
-- holds the key. A nested #x/subscription is a member's own tag: never chosen.
--
-- Raw SQL, no domain events, like every data migration: it records a change of
-- representation, not a user's edit. The node_tags DELETE fires the membership
-- epoch and tag-state triggers as any removal does.
--
-- Idempotent: once (c) has cleared the key, (a)–(c) find no subscription tag;
-- the marker INSERT skips rows that already have it.

CREATE TEMP TABLE m114_subscription_tags ON COMMIT DROP AS
SELECT t.id, t.workspace_id
  FROM content_nodes t
 WHERE t.reserved_key = 'subscription'
    OR (t.reserved_key IS NULL AND t.node_type = 'class_tag' AND t.deleted_at IS NULL
        AND t.parent_id IS NULL AND t.title = 'subscription'
        AND NOT EXISTS (SELECT 1 FROM content_nodes k
                         WHERE k.workspace_id = t.workspace_id AND k.reserved_key = 'subscription'));

-- (a) mark the sources.
INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
SELECT DISTINCT n.workspace_id, n.id, '_rss_kind', 'source', 'text', false, 'explicit'
  FROM content_nodes n
  JOIN node_tags nt ON nt.node_id = n.id
  JOIN m114_subscription_tags s ON s.id = nt.tag_id AND s.workspace_id = n.workspace_id
 WHERE n.node_type = 'content'
   AND EXISTS (SELECT 1 FROM node_attributes u WHERE u.node_id = n.id AND u.key = '_rss_url')
ON CONFLICT (node_id, key) DO NOTHING;

-- (b) detach the tag from the sources it marked.
DELETE FROM node_tags nt
 USING m114_subscription_tags s
 WHERE nt.tag_id = s.id
   AND EXISTS (SELECT 1 FROM node_attributes k
                WHERE k.node_id = nt.node_id AND k.key = '_rss_kind' AND k.value = 'source');

-- (c) retire the tag: an ordinary tag again, and in the trash when unused.
UPDATE content_nodes t
   SET reserved_key = NULL, updated_at = now()
  FROM m114_subscription_tags s
 WHERE t.id = s.id AND t.reserved_key = 'subscription';

UPDATE content_nodes t
   SET deleted_at = now(), updated_at = now()
  FROM m114_subscription_tags s
 WHERE t.id = s.id AND t.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id AND c.deleted_at IS NULL);

COMMENT ON COLUMN public.content_nodes.reserved_key IS 'Role of a system-reserved class_tag (task, workspace-config, page); NULL for ordinary nodes. See services/reservedTags.ts. (subscription retired by migration 114: RSS sources carry _rss_kind instead.)';
