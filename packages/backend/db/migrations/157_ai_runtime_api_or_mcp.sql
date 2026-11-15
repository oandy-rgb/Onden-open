-- 157_ai_runtime_api_or_mcp.sql
--
-- AI 角色只剩兩種跑法（業主 2026-11-01）：API（伺服器用使用者的金鑰呼叫模型）與 MCP（使用者自己的 AI 用戶端連進來，
-- 可以手動開，也可以放在某台機器上自動領排隊中的工作）。原本的「訂閱執行程式」本質上就是一個自動跑的 MCP 用戶端，併進 MCP。
--
-- 角色與 session 的 runtime 'subscription' 一律改成 'mcp'。角色金鑰、排隊中的 session、runner 的上次連線時間
-- （agent_runners.runner_seen_at）都不動；領工作的路徑（/api/mcp/sessions/pending 與 claim）不看 runtime 是哪一種，
-- 已經在跑的 runner 不用改設定。

ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_default_runtime_check;
UPDATE agent_runners SET default_runtime = 'mcp' WHERE default_runtime = 'subscription';
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_default_runtime_check CHECK (default_runtime IN ('api', 'mcp'));
ALTER TABLE agent_runners ALTER COLUMN default_runtime SET DEFAULT 'mcp';

ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_runtime_check;
UPDATE agent_sessions SET runtime = 'mcp' WHERE runtime = 'subscription';
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_runtime_check CHECK (runtime IN ('api', 'mcp'));
ALTER TABLE agent_sessions ALTER COLUMN runtime SET DEFAULT 'mcp';
