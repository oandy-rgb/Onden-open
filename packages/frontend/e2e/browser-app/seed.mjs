// The seed of a randomized e2e script: the value of `env` to replay a run, otherwise a fresh one every run
// (owner 2026-11-18 「種子都隨機」). The seed is printed first, so a red run can be replayed.
export function runSeed(script, env = "SEED") {
  const given = Number(process.env[env]);
  const seed = Number.isInteger(given) && given > 0 ? given : 1 + Math.floor(Math.random() * (2 ** 31 - 2));
  console.log(`[${script}] seed=${seed} (replay: ${env}=${seed})`);
  return seed;
}
