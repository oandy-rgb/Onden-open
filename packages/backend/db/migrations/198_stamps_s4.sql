-- 198: write stamps on personal settings (causal-stamps proposal §8, S4). Records only, and ADDITIVE: it creates triggers,
-- nothing else; it does not touch an existing row, table, column or function (190's sync_stamp_trigger() is used as it is).
--
-- Four tables whose rows the generic trigger (190, with 194's composite keys and workspace lookup) can identify:
--   rss_mutes            the keyword or feed muted, and until when
--   rss_subscriptions    the settings (title, address, space, interval, save defaults, voice, display); NOT the fetch state
--                        (etag, last_modified, last_fetched_at, last_error) - that belongs to the node that fetched, and an
--                        UPDATE of only those columns does not fire the trigger
--   external_calendars   name, color, switched on; NOT the sealed address or the fetch state
-- Their writes go through spine/mutate.ts (mutate / mutatePersonal), which stamps the transaction; a write that did not
-- is counted by the trigger exactly as for content_nodes (sync_clock.writes_without_mutate).
--
--   actor_module_settings  a person's own settings per tag (key actor_id/tag_id; the workspace is the tag note's: 'via:tag_id',
--                          194's lookup)
-- Not wired here, on purpose: review_states (its key is node_id OR block_id, and 194's composite key joins with '/', so a
-- NULL half would make the key NULL), actor_prefs and rss_seen (no workspace column and no note to look it up by). Their writes
-- already go through the entry (each transaction has a stamp); the rows get theirs when the trigger can name them.
-- syncClasses.json leaves them not `wired`.
--
-- actor_module_settings rows go when their tag note is purged (foreign key). That delete trigger then cannot find the workspace
-- through the note (194's 'via:' lookup) and records nothing, without error; the tag note's own tombstone covers it, and the
-- settings row's last stamp stays as it was (src/test/stampedPersonalWrites.integration.test.ts).
--
-- (This migration runs after 194, which replaces sync_stamp_trigger() with the 8-argument form; the 5-argument calls below are valid for it.)
--
-- Rolling back: DROP the twelve triggers (this migration creates nothing else); an older backend refuses to start on a database
-- with a migration it does not know, so the supported way is the pre-upgrade backup, as for 190.
--
-- Read-only preview before applying (counts only): rows that will start to carry stamps once written, none are rewritten now:
--   SELECT (SELECT count(*) FROM rss_mutes) AS rss_mutes, (SELECT count(*) FROM rss_subscriptions) AS rss_subscriptions,
--          (SELECT count(*) FROM external_calendars) AS external_calendars, (SELECT count(*) FROM actor_module_settings) AS actor_module_settings;

CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_insert AFTER INSERT ON rss_mutes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');
CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_update AFTER UPDATE ON rss_mutes FOR EACH ROW
  WHEN (OLD.keyword IS DISTINCT FROM NEW.keyword OR OLD.subscription_id IS DISTINCT FROM NEW.subscription_id
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');
CREATE OR REPLACE TRIGGER rss_mutes_sync_stamp_delete AFTER DELETE ON rss_mutes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_mutes', 'id', 'workspace_id', 'keyword=keyword,source=subscription_id,expires=expires_at', '');

CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_insert AFTER INSERT ON rss_subscriptions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');
CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_update AFTER UPDATE ON rss_subscriptions FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.url IS DISTINCT FROM NEW.url OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR OLD.fetch_interval_minutes IS DISTINCT FROM NEW.fetch_interval_minutes OR OLD.auto_tag_id IS DISTINCT FROM NEW.auto_tag_id
     OR OLD.embed IS DISTINCT FROM NEW.embed OR OLD.auto_dismiss_days IS DISTINCT FROM NEW.auto_dismiss_days
     OR OLD.default_tag_ids IS DISTINCT FROM NEW.default_tag_ids OR OLD.default_parent_id IS DISTINCT FROM NEW.default_parent_id
     OR OLD.always_fulltext IS DISTINCT FROM NEW.always_fulltext OR OLD.voice IS DISTINCT FROM NEW.voice
     OR OLD.display_mode IS DISTINCT FROM NEW.display_mode)
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');
CREATE OR REPLACE TRIGGER rss_subscriptions_sync_stamp_delete AFTER DELETE ON rss_subscriptions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('rss_subscriptions', 'id', 'workspace_id',
    'title=title,url=url,space=space_id,interval=fetch_interval_minutes,auto_tag=auto_tag_id,embed=embed,dismiss=auto_dismiss_days,default_tags=default_tag_ids,default_parent=default_parent_id,fulltext=always_fulltext,voice=voice,display=display_mode', '');

CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_insert AFTER INSERT ON external_calendars FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');
CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_update AFTER UPDATE ON external_calendars FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.color IS DISTINCT FROM NEW.color OR OLD.enabled IS DISTINCT FROM NEW.enabled)
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');
CREATE OR REPLACE TRIGGER external_calendars_sync_stamp_delete AFTER DELETE ON external_calendars FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('external_calendars', 'id', 'workspace_id', 'name=name,color=color,enabled=enabled', '');

CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_insert AFTER INSERT ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');
CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_update AFTER UPDATE ON actor_module_settings FOR EACH ROW
  WHEN (OLD.settings IS DISTINCT FROM NEW.settings)
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');
CREATE OR REPLACE TRIGGER actor_module_settings_sync_stamp_delete AFTER DELETE ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_module_settings', 'actor_id,tag_id', 'via:tag_id', 'settings=settings', '');
