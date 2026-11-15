// Runs the real Worker and Durable Object classes in Cloudflare's local runtime (workerd, via Miniflare).
// No account, no network: everything is local. The platform-independent rules are covered in relay.test.ts;
// this file proves the adapter (storage pieces, alarms, RPC between objects) works in the real runtime.
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MiB, STORAGE_PART_BYTES } from "./limits.ts";

let mf: Miniflare;
const base = "http://relay.local/v1/s";
const sid = (c: string) => c.repeat(22);
const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, "0")).join("");
const WRITE = "w".repeat(43);
const READ = "r".repeat(43);

async function send(path: string, init: { method?: string; token?: string; body?: Uint8Array; readHash?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "198.51.100.1" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body) headers["content-type"] = "application/octet-stream";
  if (init.readHash) headers["x-read-token-hash"] = init.readHash;
  return mf.dispatchFetch(`${base}/${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, external: ["cloudflare:workers"],
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0]!.text,
    compatibilityDate: "2026-07-01",
    durableObjects: { SESSIONS: { className: "SessionObject", useSQLite: true }, LIMITERS: { className: "LimiterObject", useSQLite: true }, REGISTRY: { className: "RegistryObject", useSQLite: true } },
    // Keep state in memory only; nothing is written next to the repo.
    durableObjectsPersist: false,
  });
  await mf.ready;
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("real Workers runtime", () => {
  it("runs the whole flow with a chunk bigger than one storage piece", async () => {
    const id = sid("A");
    expect((await send(`${id}/hello`, { method: "PUT", body: new Uint8Array(33).fill(5) })).status).toBe(201);
    const big = new Uint8Array(3 * MiB + 123).map((_, i) => (i * 7) & 255);
    expect(big.length).toBeGreaterThan(2 * STORAGE_PART_BYTES);
    const put = await send(`${id}/o/c.f.0`, { method: "PUT", token: WRITE, body: big, readHash: await sha(READ) });
    expect(put.status).toBe(201);
    expect((await send(`${id}/o/c.f.0`, { method: "PUT", token: WRITE, body: big })).status).toBe(200); // retry
    const list = (await (await send(`${id}/o`, { token: READ })).json()) as { objects: { name: string; size: number }[] };
    expect(list.objects).toEqual([{ name: "c.f.0", size: big.length }]);
    const got = new Uint8Array(await (await send(`${id}/o/c.f.0`, { token: READ })).arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(got.every((v, i) => v === big[i])).toBe(true);
    expect((await send(`${id}/o`, { token: "x".repeat(43) })).status).toBe(404);
    expect((await send(id, { method: "DELETE", token: READ })).status).toBe(204);
    expect((await send(`${id}/o`, { token: READ })).status).toBe(404);
  }, 60_000);

  it("limits new sessions per source address through the limiter object", async () => {
    const hello = () => new Uint8Array(33).fill(1);
    for (let i = 0; i < 10; i++) expect((await send(`${String.fromCharCode(97 + i).repeat(22)}/hello`, { method: "PUT", body: hello(), ip: "203.0.113.77" })).status).toBe(201);
    expect((await send(`${"z".repeat(22)}/hello`, { method: "PUT", body: hello(), ip: "203.0.113.77" })).status).toBe(429);
    expect((await send(`${"z".repeat(22)}/hello`, { method: "PUT", body: hello(), ip: "203.0.113.78" })).status).toBe(201);
  });
});
