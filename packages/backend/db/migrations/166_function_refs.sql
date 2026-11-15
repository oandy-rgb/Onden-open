-- 166: 功能引用表 B1（docs/architecture/proposals/function-references-2026-11-02.md §3.2、§8）。
--
-- function_refs: 一列＝「某個引用者引用某個功能」。B1 只有標籤層（holder_node_id 指向 class_tag 節點）；
-- holder_space_id 先建好，B4 才開放寫入。沒有 owner_actor_id（B3）、沒有 holder_block_id（B5）。
--
-- 回填：每個 live 標籤的「有效功能」逐一轉成它自己的一列——自己的模組標籤（tag_schema.module）、
-- 舊開關（behaviour.modules.<id>.enabled）、以及沿 tag_schema.extends 取得的（廣度優先、最近者勝，
-- 與舊的 effectiveTagModules 同一規則）。extends 指向使用者自己標籤的項目照業主 2026-11-02 第 1 題「攤平」：
-- 這個標籤直接得到被延伸標籤的功能列，之後不再隨被延伸者改變。
-- config.source_tag_id＝設定來自哪個標籤（舊 effectiveTagModules 回傳的來源；與列的標籤相同時省略）。
-- 視角功能（table／kanban／calendar／gallery）是 B2，不在這裡；它們仍由 extends 表示。
-- 舊欄位（tag_schema.module／extends／behaviour.modules）這批不刪（刪除放在本批最後一個遷移、上線一版後）。
-- 可重跑：IF NOT EXISTS ＋ ON CONFLICT DO NOTHING。

CREATE TABLE IF NOT EXISTS function_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  function_id text NOT NULL CHECK (char_length(function_id) BETWEEN 1 AND 64),
  -- 同一個引用者可多次引用同一功能時的區分（視角 id）；單例功能為空字串。
  instance text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  holder_node_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  holder_space_id uuid REFERENCES spaces(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT function_refs_one_holder CHECK ((holder_node_id IS NULL) <> (holder_space_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS function_refs_holder_unique
  ON function_refs (COALESCE(holder_node_id, holder_space_id), function_id, instance);
CREATE INDEX IF NOT EXISTS function_refs_function_idx ON function_refs (workspace_id, function_id);

WITH RECURSIVE
tags AS (
  SELECT id, workspace_id, tag_schema FROM content_nodes
   WHERE node_type = 'class_tag' AND deleted_at IS NULL
),
edges AS (
  SELECT t.id AS child, p.value::uuid AS parent, min(p.ord) AS ord
    FROM tags t,
         LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' THEN t.tag_schema->'extends' ELSE '[]'::jsonb END)
           WITH ORDINALITY AS p(value, ord)
   WHERE p.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM tags x WHERE x.id = p.value::uuid)
   GROUP BY t.id, p.value::uuid
),
walk AS (
  SELECT id AS tag_id, id AS node_id, 0 AS depth, ARRAY[]::bigint[] AS path, ARRAY[id] AS seen FROM tags
  UNION ALL
  SELECT w.tag_id, e.parent, w.depth + 1, w.path || e.ord, w.seen || e.parent
    FROM walk w JOIN edges e ON e.child = w.node_id
   WHERE NOT (e.parent = ANY(w.seen)) AND w.depth < 32
),
reach AS (
  SELECT DISTINCT ON (tag_id, node_id) tag_id, node_id, depth, path FROM walk ORDER BY tag_id, node_id, depth, path
),
provides AS (
  SELECT id AS node_id, tag_schema->>'module' AS function_id FROM tags
   WHERE jsonb_typeof(tag_schema->'module') = 'string' AND char_length(tag_schema->>'module') BETWEEN 1 AND 64
  UNION
  SELECT t.id, m.key FROM tags t,
         LATERAL jsonb_each(CASE WHEN jsonb_typeof(t.tag_schema->'behaviour'->'modules') = 'object' THEN t.tag_schema->'behaviour'->'modules' ELSE '{}'::jsonb END) AS m(key, value)
   WHERE jsonb_typeof(m.value) = 'object' AND m.value->'enabled' = 'true'::jsonb AND char_length(m.key) BETWEEN 1 AND 64
),
effective AS (
  SELECT DISTINCT ON (r.tag_id, p.function_id) r.tag_id, p.function_id, r.node_id AS source_id
    FROM reach r JOIN provides p ON p.node_id = r.node_id
   ORDER BY r.tag_id, p.function_id, r.depth, r.path
)
INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config)
SELECT t.workspace_id, e.function_id, e.tag_id,
       CASE WHEN e.source_id = e.tag_id THEN '{}'::jsonb ELSE jsonb_build_object('source_tag_id', e.source_id) END
  FROM effective e JOIN tags t ON t.id = e.tag_id
 WHERE e.function_id NOT IN ('table', 'kanban', 'calendar', 'gallery')
ON CONFLICT DO NOTHING;
