-- P3.5: the node_tags membership trigger also pg_notify's, so the app can raise
-- an INSTANT SSE membership tick on EVERY node_tags path — REST route, MCP tool,
-- Obsidian import, dispatcher cascade, template expansion — not only the few REST
-- routes that called bumpMembershipEpoch() explicitly (and which therefore
-- DOUBLE-bumped: trigger + explicit). After this, the trigger is the SINGLE
-- source for node_tags-driven membership signalling; the explicit bumps on the
-- tag-apply/remove route + tool are removed.
--
-- Division of labour (unchanged correctness posture):
--   • the epoch bump is the BY-CONSTRUCTION correctness signal — the client's
--     handshake runs a fail-closed gate whenever its epoch differs, so a revoked
--     node can't linger even if the NOTIFY is missed;
--   • the NOTIFY is the BEST-EFFORT instant nudge — an online client reconciles
--     the moment a tag (permission) change lands, instead of waiting for the next
--     handshake. A dropped listener loses only immediacy, never correctness.
--
-- NOTIFY is transactional: PG delivers it to listeners only after this trigger's
-- transaction COMMITS — matching the afterCommit() timing the explicit bump used.

CREATE OR REPLACE FUNCTION public.bump_membership_on_node_tag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ws uuid;
  new_epoch bigint;
BEGIN
  SELECT workspace_id INTO ws
  FROM public.content_nodes
  WHERE id = COALESCE(NEW.node_id, OLD.node_id);
  IF ws IS NOT NULL THEN
    UPDATE public.workspaces
    SET membership_epoch = membership_epoch + 1
    WHERE id = ws
    RETURNING membership_epoch INTO new_epoch;
    -- Channel name + payload consumed by services/membershipListener.ts.
    PERFORM pg_notify(
      'membership_epoch',
      json_build_object('workspace_id', ws, 'epoch', new_epoch)::text
    );
  END IF;
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$;
