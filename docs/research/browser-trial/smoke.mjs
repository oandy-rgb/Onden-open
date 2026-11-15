// 最小原型（Node）：在 Node 裡用 PGlite 跑真正的 Hono app，打幾個 API。
// 用法：node build-node.mjs && node smoke.mjs
process.env.NODE_ENV = "test"; // 跳過 index.ts 的伺服器開機（我們自己開機）；注意：test 模式會開 native bypass，所以 Node 版另外用 smoke-real-auth 證明不靠 bypass
process.env.LOG_LEVEL = "warn";
const t00 = performance.now();
const { app, auth, boot, stats, createBridge } = await import("./dist/backend-node.mjs");
const importMs = Math.round(performance.now() - t00);
const t1 = performance.now();
const b = await boot();
console.log(JSON.stringify({ importMs, bootMs: Math.round(performance.now() - t1), migrationsMs: Math.round(b.migrationsMs), applied: b.applied }));
const { runScenario } = await import("./scenario.mjs");
const bridge = createBridge(app, auth.api, { email: "trial@onden.local", password: crypto.randomUUID() + crypto.randomUUID(), name: "試用者" });
await runScenario(bridge);
console.log("pg shim stats:", stats, "rssMB:", Math.round(process.memoryUsage().rss / 1048576));
process.exit(0);
