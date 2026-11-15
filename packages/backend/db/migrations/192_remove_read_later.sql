-- 192: 稍後讀（read_later）整個移除（docs/architecture/proposals/function-refs-b3-2026-11-12.md §3，業主 2026-11-12）。
--
-- 後端模組、路由 /api/read-later、前端模組與文字都已拿掉。這個 migration 處理資料，而且不靜默丟棄：
--   1. 資料表 read_later_done（每人「讀完了」的記號）改名成 read_later_done_removed_192，內容原封不動，
--      下一版才刪；沒有任何程式讀寫它。
--   2. 稍後讀的模組標籤（tag_schema.module = 'read_later'，不分在用或已在垃圾桶）：
--        * 在用、沒被改過（名稱是預設值、沒有內文、沒有自訂顏色、沒有使用者加的欄位或說明、沒有已存檢視、
--          沒有子標籤）、而且沒有任何筆記掛著 → 進垃圾桶（deleted_at ＋ NODE_DELETED 事件，可從歷史復原）；
--        * 其餘留在原地，只去掉模組記號（module、behaviour.modules.read_later）變成普通標籤，筆記與標籤關聯一個都不動。
--   3. 函式引用表裡 function_id = 'read_later' 的列刪掉（它們只是「這個標籤有稍後讀功能」的記號，沒有別的資料）。
--   NOTICE 印出：掛著模組標籤的筆記數、模組標籤的節點 id（進垃圾桶的、留下的分開列）、被刪的引用列數、改名的資料表。
--   受影響的標籤各寫一個 TAG_MODULES_MIGRATED 事件（進垃圾桶的寫 NODE_DELETED），讓握有舊同步游標的客戶端重新讀到。
-- 可重跑：改名只在舊表存在且新名不存在時做；標籤靠記號找，處理過就沒有記號了；引用列處理過就不在。
-- 退版：還原升級前備份再切回舊映像（docs/agents/migrations.md）；資料表與內容都還在，所以備份之外也可以手動把表改回原名。
-- drill: allows note-bodies

DROP TABLE IF EXISTS pg_temp.m192_tags;

DO $$
BEGIN
  IF to_regclass('public.read_later_done') IS NOT NULL AND to_regclass('public.read_later_done_removed_192') IS NULL THEN
    ALTER TABLE public.read_later_done RENAME TO read_later_done_removed_192;
    RAISE NOTICE '[192] table read_later_done renamed to read_later_done_removed_192 (kept one release, then dropped)';
  END IF;
END $$;

CREATE TEMP TABLE m192_tags ON COMMIT DROP AS
SELECT t.id, t.workspace_id, t.title, (t.deleted_at IS NULL) AS live,
       (SELECT count(*) FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id AND n.deleted_at IS NULL
         WHERE nt.tag_id = t.id) AS live_notes,
       (SELECT count(*) FROM node_tags nt WHERE nt.tag_id = t.id) AS any_links,
       (    t.deleted_at IS NULL
        AND lower(t.title) IN ('read-later', 'toread', '稍後讀')
        AND COALESCE(btrim(t.markdown), '') = ''
        AND t.tag_color IS NULL
        AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' END), 0) = 0
        AND COALESCE(btrim(t.tag_schema->>'description'), '') = ''
        AND (t.tag_schema->'behaviour' IS NULL OR jsonb_typeof(t.tag_schema->'behaviour') <> 'object'
             OR (t.tag_schema->'behaviour') - 'modules' = '{}'::jsonb)
        AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.collection_views) = 'array' THEN t.collection_views END), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM function_refs v WHERE v.holder_node_id = t.id AND v.instance <> '')
        AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id AND c.node_type = 'class_tag' AND c.deleted_at IS NULL)
       ) AS untouched
  FROM content_nodes t
 WHERE t.node_type = 'class_tag' AND t.tag_schema->>'module' = 'read_later';

DO $$
DECLARE
  rec record;
  ev bigint;
  gone_ids text; kept_ids text; refs_deleted integer; note_total bigint;
BEGIN
  SELECT COALESCE(sum(live_notes), 0) INTO note_total FROM m192_tags;
  FOR rec IN SELECT * FROM m192_tags WHERE live AND untouched AND any_links = 0 ORDER BY id LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (rec.workspace_id, 'system', 'migration:192', 'NODE_DELETED', 'node', rec.id::text,
            jsonb_build_object('title', rec.title),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.remove_read_later'))
    RETURNING id INTO ev;
    UPDATE content_nodes
       SET deleted_at = now(), deleted_by_event_id = ev, updated_at = now(),
           tag_schema = (tag_schema - 'module') #- '{behaviour,modules,read_later}'
     WHERE id = rec.id AND deleted_at IS NULL;
  END LOOP;

  -- 其餘（被改過的、有筆記的、已在垃圾桶的）：只去掉記號。
  WITH rest AS (
    UPDATE content_nodes n
       SET tag_schema = (n.tag_schema - 'module') #- '{behaviour,modules,read_later}', updated_at = now()
      FROM m192_tags m
     WHERE n.id = m.id AND n.tag_schema->>'module' = 'read_later'
    RETURNING n.id, n.workspace_id, m.live
  )
  INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
  SELECT workspace_id, 'system', 'migration:192', 'TAG_MODULES_MIGRATED', 'tag', id::text,
         jsonb_build_object('migration', '192_remove_read_later'),
         jsonb_build_object('ui_context', 'migration.remove_read_later')
    FROM rest WHERE live;

  -- 其他標籤上的 read_later 功能引用，與（舊版 behaviour.modules 的）開關。
  WITH removed AS (
    DELETE FROM function_refs WHERE function_id = 'read_later' AND holder_node_id IS NOT NULL
    RETURNING holder_node_id, workspace_id
  ), holders AS (
    SELECT DISTINCT rm.holder_node_id AS id, rm.workspace_id
      FROM removed rm JOIN content_nodes c ON c.id = rm.holder_node_id AND c.deleted_at IS NULL
     WHERE rm.holder_node_id NOT IN (SELECT id FROM m192_tags)
  ), ev AS (
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    SELECT workspace_id, 'system', 'migration:192', 'TAG_MODULES_MIGRATED', 'tag', id::text,
           jsonb_build_object('migration', '192_remove_read_later'),
           jsonb_build_object('ui_context', 'migration.remove_read_later')
      FROM holders
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM removed) INTO refs_deleted;

  SELECT string_agg(id::text, ', ' ORDER BY id) INTO gone_ids FROM m192_tags WHERE live AND untouched AND any_links = 0;
  SELECT string_agg(id::text || ' (' || live_notes || ' notes' || CASE WHEN live THEN '' ELSE ', was in the trash' END || ')', ', ' ORDER BY id)
    INTO kept_ids FROM m192_tags WHERE NOT (live AND untouched AND any_links = 0);
  RAISE NOTICE '[192] read-later: % module tag(s); % note(s) carry one', (SELECT count(*) FROM m192_tags), note_total;
  IF gone_ids IS NOT NULL THEN RAISE NOTICE '[192] module tag(s) moved to the trash (untouched, no notes): %', gone_ids; END IF;
  IF kept_ids IS NOT NULL THEN RAISE NOTICE '[192] module tag(s) kept as ordinary tags (marker removed): %', kept_ids; END IF;
  RAISE NOTICE '[192] % read_later function reference(s) deleted', refs_deleted;
END $$;
