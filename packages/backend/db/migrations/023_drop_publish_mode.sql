-- Drop dead workspaces.publish_mode column.
--
-- The column was added with CHECK (publish_mode IN ('static', 'dynamic')),
-- accepted by PATCH /api/workspace, returned by /api/bootstrap, and surfaced
-- in the frontend WorkspaceConfig type. But routes/publish.ts never branched
-- on the value — every publish always took the static-export path. The
-- mocked value in httpRoutes.test.ts ('draft') would have failed the CHECK
-- if it had ever reached the DB. Pure overhead.
--
-- If a dynamic-publish mode is ever implemented, reintroduce the column with
-- the actual switch in publish.ts at the same time.

ALTER TABLE workspaces DROP COLUMN IF EXISTS publish_mode;
