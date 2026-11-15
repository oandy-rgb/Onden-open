-- 130: tag changes no longer move membership_epoch — on a database loaded from
-- db/schema.sql too.
--
-- Spaces decide who reads what ("Tags never carry permission",
-- services/readPolicy.ts), and 094_spaces_on.sql dropped the node_tags trigger
-- that bumped the epoch on every tag add/remove. db/schema.sql was never
-- regenerated afterwards, so a database created from the snapshot (fresh deploy,
-- CI) still had it: every tag change raised the fail-closed gate on the other
-- devices. This repeats the drop; it does nothing where 094 already ran.
DROP TRIGGER IF EXISTS node_tags_membership_bump ON public.node_tags;
DROP FUNCTION IF EXISTS public.bump_membership_on_node_tag();
