-- 159_ai_module.sql
--
-- AI 整個是可以關掉的模組（業主 2026-11-01）。模組 id 是 'ai'，屬於「第一次要同意」的那一類：
-- 新工作區預設關著，要擁有者同意一次才開（workspaces.modules_confirmed 裡有 'ai' 才算開）。
--
-- 更新前就已經在用 AI 的工作區（有 AI 角色、沒撤銷的 API 金鑰、或沒撤銷的 MCP 金鑰）一律記為「已同意」，
-- 這樣更新後 AI 不會突然不見。沒有的就維持關著。modules_off 不動（裡面沒有 'ai' 就是沒被擁有者關掉過）。
-- modules_confirmed 還是 NULL 的工作區不在這裡處理：開機的第一次 library 執行會用同一個判斷（modules/ai 的 inUse）補上。
-- 資料（角色、金鑰、歷史、建議）一律不動，可重複執行。

UPDATE workspaces w
   SET modules_confirmed = COALESCE(w.modules_confirmed, '[]'::jsonb) || '["ai"]'::jsonb
 WHERE w.modules_confirmed IS NOT NULL
   AND jsonb_typeof(w.modules_confirmed) = 'array'
   AND NOT (w.modules_confirmed ? 'ai')
   AND (EXISTS (SELECT 1 FROM agent_runners r WHERE r.workspace_id = w.id)
     OR EXISTS (SELECT 1 FROM ai_credentials c WHERE c.workspace_id = w.id AND c.revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE a.workspace_id = w.id AND t.revoked_at IS NULL));
