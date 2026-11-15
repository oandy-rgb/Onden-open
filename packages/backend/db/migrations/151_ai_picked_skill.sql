-- 151_ai_picked_skill.sql
--
-- Which skill the AI chose for itself in a session (the loadSkill tool,
-- docs/architecture/harness.md), kept for the suggestion card's header
-- 「AI 建議 · 自己挑了「X」」. A skill the person named stays skill_node_id;
-- these stay NULL then. The name is a snapshot (cut at 60), the reason is the
-- AI's own one-sentence note (cut at 200).
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS picked_skill_ref    text,
  ADD COLUMN IF NOT EXISTS picked_skill_name   text,
  ADD COLUMN IF NOT EXISTS picked_skill_reason text;
