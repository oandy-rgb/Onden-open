-- GAP-237: removing a member must stick. Session actor resolution creates an
-- actor on first sight of a signed-in user, so a deleted member's next request
-- silently re-created them (as viewer) with read access to the workspace.
-- A removal record keyed by the login identity (actors.external_id, the auth
-- user id) stops that auto-provisioning. It is not a permission grant or an
-- event; ACTOR_DELETED remains the audit fact. An owner adding the person back
-- through POST /api/actors with that external_id deletes the record.
CREATE TABLE member_removals (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, external_id)
);
