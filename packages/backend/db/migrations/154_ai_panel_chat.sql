-- 154_ai_panel_chat.sql
--
-- 資訊欄「AI」分頁（kind = 'panel_chat'，提案 §5.3）：一則筆記上的一段對話＝這個人在這則筆記上
-- 的 panel_chat sessions 依時間串成的序列（不另建 conversation 表）。
--   scope_node_ids / scope_tag_ids  這一則提問額外帶入的筆記與標籤（預設範圍＝本則筆記，不存）
--   chat_cleared_at                 「清除這段對話」：之後的對話不再接這些 session，列表也不顯示
-- 全部是帳務／顯示用的事實，不進事件串流、不同步。
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS scope_node_ids  uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scope_tag_ids   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS chat_cleared_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_sessions_panel_chat_idx
  ON agent_sessions (workspace_id, node_id, initiator_id, created_at)
  WHERE kind = 'panel_chat';
