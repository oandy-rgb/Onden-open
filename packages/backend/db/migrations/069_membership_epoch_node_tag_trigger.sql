-- Auto-bump workspaces.membership_epoch on ANY node_tags change.
--
-- membership_epoch is the single signal the client uses to know its readable set
-- may have changed and a reconcile is due. It was bumped by each mutation that
-- DECLARED affectsMembership — but a tag apply/remove reaches node_tags through
-- many paths (the spine, the tag-dispatcher cascade, template expansion, Obsidian
-- import, agent createNode, collection class-tagging), and several missed the
-- declaration → a silently-stale readable set → a revoked node lingering in the
-- offline mirror forever (the P0/P3 "silent revocation failure"). A tag is also
-- the carrier of read policy, so any tag change can move a node in/out of an
-- actor's scope.
--
-- Make the bump BY CONSTRUCTION: a trigger on node_tags fires in the SAME
-- transaction as the tag write, so no write path — present or future — can miss
-- it. Over-bumping (a plain label tag that gates nothing) is a safe, cheap
-- conservatism: the epoch only needs to CHANGE, and the client reconcile is a
-- bounded set-diff. Never-miss-a-revocation beats sparing a few reconciles.
--
-- node_tags has no workspace_id column, so resolve it from the host node.

CREATE OR REPLACE FUNCTION public.bump_membership_on_node_tag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ws uuid;
BEGIN
  SELECT workspace_id INTO ws
  FROM public.content_nodes
  WHERE id = COALESCE(NEW.node_id, OLD.node_id);
  IF ws IS NOT NULL THEN
    UPDATE public.workspaces
    SET membership_epoch = membership_epoch + 1
    WHERE id = ws;
  END IF;
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS node_tags_membership_bump ON public.node_tags;
CREATE TRIGGER node_tags_membership_bump
  AFTER INSERT OR DELETE ON public.node_tags
  FOR EACH ROW EXECUTE FUNCTION public.bump_membership_on_node_tag();
