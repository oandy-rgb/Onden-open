-- Semantic search becomes an optional library module, imported nowhere
-- (user, 2026-10-18: 「語意搜尋要關」). Its embed intents never succeeded on
-- the server it shipped to (the local model fails to load), so the outbox
-- holds hundreds of dead `embed` rows and a few pending ones that would keep
-- retrying. Remove both; done rows are history and other kinds are untouched.
-- Stored embeddings stay: removing a module keeps its data
-- (docs/architecture/module-library.md). A data repair outside the event log,
-- like 105–107 and 110. Repeatable.

DELETE FROM outbox WHERE effect_kind = 'embed' AND status IN ('dead', 'pending');
