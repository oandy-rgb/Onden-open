-- Drop legacy site_pages table. Pages are content_nodes now (commit 8e79df8).
-- Per-page layout overrides will live as node_attributes when needed; defaults
-- come from the workspace-config node (default_layout, default_sidebar_ratio).
DROP TABLE IF EXISTS site_pages CASCADE;
