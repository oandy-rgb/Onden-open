-- 188: 功能引用表 B2——已存檢視搬進 function_refs
-- （docs/architecture/proposals/function-references-2026-11-02.md §6、§8 B2）。
--
-- 每個已存檢視（content_nodes.collection_views 陣列的一個元素，標籤與筆記一樣，含白板／簡報分頁、
-- 垃圾桶裡的節點）變成 function_refs 的一列：
--   holder_node_id ＝ 檢視所在的節點
--   function_id    ＝ 版面（table／kanban／calendar／gallery／canvas／slides；舊的 'list' 當 'table'，
--                    與遷移 111 與讀取時的規則相同）
--   instance       ＝ 原檢視 id（保留，連結、釘選、事件歷史不斷）
--   config         ＝ 原元素去掉 id、layout、tag_id、node_id（後兩者由引用者推得）；名稱、篩選、排序、
--                    group_by、visible_fields、layout_config（含 opens_first、hidden）、pin_order、
--                    created_at、updated_at 原樣保留
-- 同一節點內的順序用 created_at 的微秒差保留（沒有別的排序欄位；讀取時照 created_at 排回原陣列順序）。
--
-- 不丟任何檢視：形狀異常的元素（不是物件、沒有字串 id、沒有 1–64 字的字串版面、同一節點 id 重複）
-- 不搬，留在原欄位原處，數量與節點 id 用 NOTICE 印在遷移紀錄。collection_views 欄位這一批不刪、
-- 搬完不再被讀寫（要能回退；下一步經業主確認才刪）。
-- 可重跑：IF NOT EXISTS ＋ ON CONFLICT DO NOTHING。注意：搬完之後欄位已凍結，重跑會把「已在引用表被刪掉」的
-- 檢視再搬回來；migrate() 每個檔只跑一次，所以只有人為重跑才會發生。
-- drill: allows note-bodies

-- 讀某節點的檢視（每個畫面載入都要）。B1 的唯一索引是 COALESCE(holder…) 運算式，這種條件用不到它。
CREATE INDEX IF NOT EXISTS function_refs_holder_node_idx ON function_refs (holder_node_id) WHERE holder_node_id IS NOT NULL;
-- 一個節點的一個檢視 id 只有一列（跨版面也一樣）：讀取、改名、刪除都以 (節點, 檢視 id) 找，不能有兩列。
CREATE UNIQUE INDEX IF NOT EXISTS function_refs_view_instance_unique ON function_refs (holder_node_id, instance) WHERE instance <> '' AND holder_node_id IS NOT NULL;

WITH elements AS (
  SELECT n.id AS node_id, n.workspace_id, v.value AS element, v.ord,
         row_number() OVER (PARTITION BY n.id, v.value->>'id' ORDER BY v.ord) AS nth
    FROM content_nodes n,
         LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views ELSE '[]'::jsonb END)
           WITH ORDINALITY AS v(value, ord)
   WHERE jsonb_typeof(v.value) = 'object'
     AND jsonb_typeof(v.value->'id') = 'string' AND char_length(v.value->>'id') >= 1
     AND jsonb_typeof(v.value->'layout') = 'string' AND char_length(v.value->>'layout') BETWEEN 1 AND 64
)
INSERT INTO function_refs (workspace_id, function_id, instance, config, holder_node_id, created_at, updated_at)
SELECT e.workspace_id,
       CASE WHEN e.element->>'layout' = 'list' THEN 'table' ELSE e.element->>'layout' END,
       e.element->>'id',
       e.element - 'id' - 'layout' - 'tag_id' - 'node_id',
       e.node_id,
       now() + e.ord * interval '1 microsecond',
       now() + e.ord * interval '1 microsecond'
  FROM elements e
 WHERE e.nth = 1
ON CONFLICT DO NOTHING;

-- 月曆檢視需要的設定是「用哪個日期欄位」，現在由功能宣告、存在 layout_config.date_field，不再於畫面上依欄位名稱猜。
-- 還沒有 date_field 的舊「標籤」月曆檢視：在「看得到的欄位」裡取第一個名稱像日期、而且標籤宣告它是日期型別的欄位
-- （名稱規則與舊畫面相同，少了「值要大多是日期」那一步，因為遷移不執行檢視）。名稱像但型別不是日期的、
-- 沒有這樣的欄位的、以及筆記的月曆（欄位來自子筆記的標籤，遷移無從知道）都維持沒有——畫面用最後編輯日期，
-- 和舊畫面在這些情形下的結果一樣。其他設定一字不動。
UPDATE function_refs r
   SET config = jsonb_set(r.config, '{layout_config}',
         COALESCE(CASE WHEN jsonb_typeof(r.config->'layout_config') = 'object' THEN r.config->'layout_config' END, '{}'::jsonb)
         || jsonb_build_object('date_field', guess.field))
  FROM (
    SELECT c.id,
           (SELECT f.value FROM jsonb_array_elements_text(c.config->'visible_fields') WITH ORDINALITY AS f(value, ord)
             WHERE f.value NOT IN ('updated_at', 'created_at', 'title', 'slug')
               AND f.value ~* '(date|due|start|when|\yday\y|sched|publish|deadline)'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.tag_schema->'fields') = 'array' THEN h.tag_schema->'fields' ELSE '[]'::jsonb END) fl
                            WHERE fl->>'name' = f.value AND fl->>'type' = 'date')
             ORDER BY f.ord LIMIT 1) AS field
      FROM function_refs c JOIN content_nodes h ON h.id = c.holder_node_id AND h.node_type = 'class_tag'
     WHERE c.function_id = 'calendar' AND c.instance <> '' AND jsonb_typeof(c.config->'visible_fields') = 'array'
  ) guess
 WHERE r.id = guess.id AND guess.field IS NOT NULL
   AND NOT COALESCE(jsonb_typeof(r.config->'layout_config') = 'object'
                    AND jsonb_typeof(r.config->'layout_config'->'date_field') = 'string'
                    AND r.config->'layout_config'->>'date_field' <> '', false);

DO $$
DECLARE
  leftover_count integer;
  leftover_nodes text;
BEGIN
  -- 沒搬的：欄位不是陣列的，以及陣列裡形狀異常或 id 重複（後面的那個）的元素。
  SELECT count(*), string_agg(DISTINCT node_id::text, ', ')
    INTO leftover_count, leftover_nodes
    FROM (
      SELECT n.id AS node_id
        FROM content_nodes n
       WHERE n.collection_views IS NOT NULL AND jsonb_typeof(n.collection_views) NOT IN ('null', 'array')
      UNION ALL
      SELECT e.node_id
        FROM (
          SELECT n.id AS node_id, v.value AS element,
                 row_number() OVER (PARTITION BY n.id, v.value->>'id' ORDER BY v.ord) AS nth
            FROM content_nodes n,
                 LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS v(value, ord)
        ) e
       WHERE NOT (jsonb_typeof(e.element) = 'object'
                  AND jsonb_typeof(e.element->'id') = 'string' AND char_length(e.element->>'id') >= 1
                  AND jsonb_typeof(e.element->'layout') = 'string' AND char_length(e.element->>'layout') BETWEEN 1 AND 64)
          OR e.nth > 1
    ) x;
  IF leftover_count > 0 THEN
    RAISE NOTICE '[188] % saved view(s) of malformed shape were left in content_nodes.collection_views (nodes: %)', leftover_count, leftover_nodes;
  END IF;
END $$;
