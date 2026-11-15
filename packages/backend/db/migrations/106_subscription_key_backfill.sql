-- The RSS #subscription tag is found by reserved_key only (T5): its title is
-- no longer identity, so the RSS self-heal (modules/rss/subscriptionTag.ts)
-- repairs only a row holding the key. Migration 100 keyed LIVE class_tags
-- only; a workspace whose subscription tag had already been flipped to
-- node_type='content' (the 2026-06-27 PATCH-default bug) or trashed — and
-- that had not opened RSS since, when the old title self-heal would have
-- keyed it — kept a keyless row, and its feeds would be stranded.
--
-- Give the key to ONE such row per workspace: a root row titled
-- 'subscription', without a key, still applied to notes (the feed sources
-- carry it). Prefer a live class_tag, else the most recently created. Only
-- when no row in the workspace holds the key (live or not), so a tag the code
-- already knows is never displaced. Idempotent: once keyed, nothing matches.
-- A nested #x/subscription is a member's own tag and is never chosen.
UPDATE content_nodes t SET reserved_key = 'subscription'
  FROM (
    SELECT DISTINCT ON (c.workspace_id) c.id
      FROM content_nodes c
     WHERE c.title = 'subscription' AND c.parent_id IS NULL AND c.reserved_key IS NULL
       AND EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM content_nodes k
                        WHERE k.workspace_id = c.workspace_id AND k.reserved_key = 'subscription')
     ORDER BY c.workspace_id,
              (c.node_type = 'class_tag' AND c.deleted_at IS NULL) DESC,
              c.created_at DESC, c.id
  ) pick
 WHERE t.id = pick.id;
