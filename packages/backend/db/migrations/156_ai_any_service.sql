-- 156_ai_any_service.sql
--
-- AI 中立（業主 2026-11-01）：API 金鑰可以接任何服務。
--   • 金鑰多記「服務網址」與「格式」（/v1/messages 或 /v1/chat/completions）；選填的每百萬 token 價格由使用者自己填，
--     不再有以模型名列價的表。
--   • 月上限以 token 為準（monthly_cap_tokens）。
--
-- 既有金鑰都是第一方服務的金鑰：補上它當時固定使用的網址與格式，已存的金鑰與角色設定照樣能用。
-- 既有「有上限」的角色：舊上限是美元，無法精確換成 token；以最貴的舊價格（每百萬 token 50 美元）保守換算
-- （寧可早停，不超支），擁有者可到設定調整。

ALTER TABLE ai_credentials
  ADD COLUMN IF NOT EXISTS base_url           text,
  ADD COLUMN IF NOT EXISTS protocol           text CHECK (protocol IN ('v1_messages', 'v1_chat_completions')),
  ADD COLUMN IF NOT EXISTS price_input_per_m  numeric CHECK (price_input_per_m >= 0),
  ADD COLUMN IF NOT EXISTS price_output_per_m numeric CHECK (price_output_per_m >= 0);
UPDATE ai_credentials SET base_url = 'https://api.anthropic.com', protocol = 'v1_messages' WHERE base_url IS NULL;
ALTER TABLE ai_credentials
  ALTER COLUMN base_url SET NOT NULL,
  ALTER COLUMN protocol SET NOT NULL;
ALTER TABLE ai_credentials DROP CONSTRAINT IF EXISTS ai_credentials_prices_together;
ALTER TABLE ai_credentials ADD CONSTRAINT ai_credentials_prices_together
  CHECK ((price_input_per_m IS NULL) = (price_output_per_m IS NULL));

ALTER TABLE agent_runners ADD COLUMN IF NOT EXISTS monthly_cap_tokens bigint CHECK (monthly_cap_tokens > 0);
UPDATE agent_runners SET monthly_cap_tokens = GREATEST(1000, monthly_cap_micro_usd / 50)
 WHERE api_cap_choice = 'capped' AND monthly_cap_tokens IS NULL;
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_cap_matches_choice;
ALTER TABLE agent_runners DROP COLUMN IF EXISTS monthly_cap_micro_usd;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_cap_matches_choice
  CHECK (api_cap_choice IS DISTINCT FROM 'capped' OR monthly_cap_tokens IS NOT NULL);
