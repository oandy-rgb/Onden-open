-- The built-in API AI is gone (AI = the owner's own Claude through MCP), and
-- app_settings only ever held its provider key and model. Dropping the table
-- deletes those stored values with it.
DROP TABLE IF EXISTS app_settings;
