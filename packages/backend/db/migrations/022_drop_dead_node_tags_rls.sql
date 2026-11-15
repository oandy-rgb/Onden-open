-- Drop dead RLS on node_tags.
--
-- The DELETE policy was gated on current_setting('app.actor_role', true),
-- which is never SET LOCAL anywhere in the backend. Combined with the
-- "IS NULL OR = '' OR = 'admin'" disjunction, the policy was equivalent
-- to "always allow". The SELECT / INSERT policies were USING (true) anyway.
--
-- Net: the entire RLS layer on node_tags was a no-op pretending to be a
-- security control. Authorization is enforced in the application layer via
-- canActorOnNode / canActorOnTag in src/services/tagDispatcher.ts.
--
-- See db/schema.sql header "SINGLE-TENANT ASSUMPTION" for the broader
-- rationale: RLS deferred until a real session→workspace resolver exists
-- and the offline sql.js mirror has a story for replay-time enforcement.

DROP POLICY IF EXISTS node_tags_select ON node_tags;
DROP POLICY IF EXISTS node_tags_insert ON node_tags;
DROP POLICY IF EXISTS node_tags_delete ON node_tags;
ALTER TABLE node_tags DISABLE ROW LEVEL SECURITY;
