-- Outbox delivery lasts about a day (W27, unification audit round 5).
--
-- max_attempts defaulted to 8 with backoff 2^n seconds, so a row was buried
-- as dead about 4 minutes after its first failure: a 5-minute GitHub outage
-- lost every backup queued meanwhile, and nothing requeued dead rows. With
-- backoff capped at 1 hour (services/outbox.ts), 35 attempts span about 25
-- hours: 2+4+...+2048 s (11 attempts, ~68 min) then 24 hourly attempts.
ALTER TABLE outbox ALTER COLUMN max_attempts SET DEFAULT 35;

-- Rows still waiting take the new budget; finished rows keep their history.
UPDATE outbox SET max_attempts = 35
 WHERE max_attempts = 8 AND status IN ('pending', 'pending_approval');
