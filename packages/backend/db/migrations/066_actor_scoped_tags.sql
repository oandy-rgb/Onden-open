-- Per-person / per-matter read scoping for HUMAN collaborators.
--
-- Until now the only human read gate was the flat role rank (viewer < editor <
-- reviewer < admin): a viewer admitted to the shared workspace could read every
-- node whose tag-policy required_role they outranked — i.e. effectively the
-- whole workspace. Only bearer-token AGENTS could be confined to a tag scope
-- (agent_tokens.allowed_tag_ids → readPolicy.tokenReadableNodeIds). The lawyer /
-- teacher personas need the SAME confinement for invited HUMANS: "this paralegal
-- sees only the Acme matter", "this TA sees only Section B".
--
-- We reuse the existing tag substrate as the matter boundary rather than inventing
-- a parallel ACL: a NULL scope means unrestricted (current behaviour, the floor
-- for every existing actor), and a non-NULL uuid[] confines the actor's reads to
-- nodes carrying one of those tags — the exact mechanic readPolicy already applies
-- to token scopes, now keyed on the actor row instead of the token row.
ALTER TABLE actors
  ADD COLUMN IF NOT EXISTS scoped_tag_ids uuid[];
