// Publishes a small site (10 notes + home) on the local stack so the public-site page can be measured. usage: BASE=... node publish-site.mjs
const BASE = process.env.BASE || "http://localhost:5099"; const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const call = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...H, cookie }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); console.log(m, p, r.status, t.slice(0, 200)); try { return JSON.parse(t); } catch { return t; } };
const nodes = (await call("GET", "/api/bootstrap?bodies=none")).nodes ?? [];
const ids = ["效能短筆記", "效能五千字筆記", ...Array.from({ length: 8 }, (_, i) => `筆記 ${10 + i}`)].map((t) => nodes.find((n) => n.title === t)?.id).filter(Boolean);
await call("POST", "/api/publish/include", { noteIds: ids });
await call("POST", "/api/publish", { title: "Perf Site", home_node_id: ids[0] });
await new Promise((r) => setTimeout(r, 5000));
const r = await fetch(BASE + "/site/"); const t = await r.text(); console.log("site", r.status, t.length, "islands", (t.match(/astro-island/g) ?? []).length, "scripts", (t.match(/<script/g) ?? []).length);
