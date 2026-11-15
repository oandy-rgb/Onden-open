// Composition of the cold-start /api/bootstrap?bodies=none (lean header, as the app sends it).
import { gzipSync } from "node:zlib";
const BASE = process.env.BASE || "http://localhost:5095";
const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
for (const lean of [true, false]) {
  const t0 = performance.now();
  const r = await fetch(BASE + "/api/bootstrap?bodies=none", { headers: { ...H, cookie, ...(lean ? { "x-onden-bootstrap": "lean" } : {}) } });
  const text = await r.text();
  const ms = Math.round(performance.now() - t0);
  const j = JSON.parse(text);
  const kb = (v) => (Buffer.byteLength(JSON.stringify(v)) / 1024).toFixed(0);
  console.log(`lean=${lean} ${ms}ms raw=${(text.length / 1024).toFixed(0)}KB(chars) gz=${(gzipSync(text).length / 1024).toFixed(0)}KB`);
  console.log("  keys:", Object.entries(j).map(([k, v]) => `${k}=${kb(v)}KB${Array.isArray(v) ? `(${v.length})` : ""}`).join(" "));
  if (Array.isArray(j.nodes) && j.nodes.length) {
    const fields = {};
    for (const n of j.nodes) for (const [k, v] of Object.entries(n)) fields[k] = (fields[k] ?? 0) + Buffer.byteLength(JSON.stringify(v)) + k.length + 4;
    console.log("  node fields:", Object.entries(fields).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${(v / 1024).toFixed(0)}KB`).join(" "));
  }
  if (Array.isArray(j.attributes)) {
    const byKey = {};
    for (const a of j.attributes) byKey[a.key] = (byKey[a.key] ?? 0) + Buffer.byteLength(JSON.stringify(a));
    console.log("  attributes by key:", Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${(v / 1024).toFixed(0)}KB`).join(" "));
  }
}
