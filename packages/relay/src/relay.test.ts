import { acceptInvite, completeOnPage, completeOnPhone, createInvite, decryptFile, describeItem, encryptFileChunks, FinalManifest, ManifestWriter, MIN_CHUNK_BYTES, tokenHash } from "@onden/pairing";
import { describe, expect, it } from "vitest";
import { hashToken } from "./crypto.ts";
import { MAX_NEW_SESSIONS_PER_HOUR_PER_IP, MAX_OBJECT_BYTES, MAX_OBJECTS_PER_SESSION, MAX_REQUESTS_PER_MINUTE_PER_IP, MiB, SESSION_IDLE_TTL_MS, SESSION_MAX_BYTES } from "./limits.ts";
import { createMemoryRelay } from "./memory.ts";

const BASE = "https://relay.test/v1/s";
const OCTET = "application/octet-stream";
const sid = (n: number) => `S${String(n).padStart(21, "0")}`;
const token = (c: string) => c.repeat(43);
const WRITE = token("w");
const READ = token("r");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

type Init = { method?: string; token?: string; body?: Uint8Array | string; type?: string | null; readHash?: string; ip?: string };
function call(relay: { handler: (r: Request) => Promise<Response> }, path: string, init: Init = {}) {
  const headers = new Headers();
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.type !== null && init.body !== undefined) headers.set("content-type", init.type ?? OCTET);
  if (init.readHash) headers.set("x-read-token-hash", init.readHash);
  headers.set("cf-connecting-ip", init.ip ?? "198.51.100.1");
  return relay.handler(new Request(`${BASE}/${path}`, { method: init.method ?? "GET", headers, body: init.body as BodyInit | undefined }));
}
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);
const text = async (r: Response) => r.text();

/** Hello then first write, the way the page does it. */
async function openSession(relay: ReturnType<typeof createMemoryRelay>, id: string, readHash?: string) {
  const hello = await call(relay, `${id}/hello`, { method: "PUT", body: bytes(33, 9) });
  expect(hello.status).toBe(201);
  const first = await call(relay, `${id}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(10), readHash: readHash ?? (await hashToken(READ)) });
  expect(first.status).toBe(201);
}

describe("normal flow, with real pairing and encryption", () => {
  it("carries an encrypted file from page to phone and deletes it afterwards", async () => {
    const relay = createMemoryRelay();
    const page = createInvite("https://relay.test");
    const id = page.invite.sessionId;
    const { phone, hello } = acceptInvite(page.invite);

    // Phone leaves its key; page fetches it and derives everything.
    expect((await call(relay, `${id}/hello`, { method: "PUT", body: hello })).status).toBe(201);
    const fetched = new Uint8Array(await (await call(relay, `${id}/hello`)).arrayBuffer());
    const pageKeys = completeOnPage(page, fetched);
    const phoneKeys = completeOnPhone(phone);
    expect(pageKeys.confirmationCode()).toBe(phoneKeys.confirmationCode());

    // Page uploads: chunks, then the final list. First write registers the read-token hash.
    const data = Uint8Array.from({ length: MIN_CHUNK_BYTES + 5 }, (_, i) => i & 255);
    const item = describeItem({ id: "f1", kind: "file", name: "slides.pdf", size: data.length, chunkSize: MIN_CHUNK_BYTES });
    const readHash = tokenHash(phoneKeys.readToken());
    let index = 0;
    for (const chunk of encryptFileChunks(pageKeys, "f1", data, MIN_CHUNK_BYTES)) {
      const res = await call(relay, `${id}/o/c.f1.${index++}`, { method: "PUT", token: pageKeys.writeToken(), body: chunk, readHash });
      expect(res.status).toBe(201);
    }
    await call(relay, `${id}/o/final`, { method: "PUT", token: pageKeys.writeToken(), body: new ManifestWriter(pageKeys).final([item]) });

    // Phone lists, fetches, decrypts.
    const list = (await (await call(relay, `${id}/o`, { token: phoneKeys.readToken() })).json()) as { objects: { name: string; size: number }[] };
    expect(list.objects.map((o) => o.name)).toEqual(["c.f1.0", "c.f1.1", "final"]);
    const get = async (name: string) => new Uint8Array(await (await call(relay, `${id}/o/${name}`, { token: phoneKeys.readToken() })).arrayBuffer());
    const final = new FinalManifest(phoneKeys, await get("final"));
    const restored = decryptFile(phoneKeys, final.items[0]!, [await get("c.f1.0"), await get("c.f1.1")]);
    expect(Buffer.compare(restored, data)).toBe(0);

    // Phone confirms: everything is gone.
    expect((await call(relay, id, { method: "DELETE", token: phoneKeys.readToken() })).status).toBe(204);
    expect((await call(relay, `${id}/o`, { token: phoneKeys.readToken() })).status).toBe(404);
    expect((await call(relay, `${id}/hello`)).status).toBe(404);
    expect(relay.sessions.get(id)!.storage.blobs.size).toBe(0);
  });

  it("uses the same token hash as the pairing module", async () => {
    expect(await hashToken("abc")).toBe(tokenHash("abc"));
  });
});

describe("tokens", () => {
  it("rejects a missing, malformed or wrong token, and the page's token cannot read", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    expect((await call(relay, `${sid(1)}/o`)).status).toBe(401);
    expect((await call(relay, `${sid(1)}/o`, { token: "short" })).status).toBe(401);
    expect((await call(relay, `${sid(1)}/o`, { token: token("x") })).status).toBe(404);
    expect((await call(relay, `${sid(1)}/o`, { token: WRITE })).status).toBe(404);
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: READ, body: bytes(1) })).status).toBe(404);
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: token("x"), body: bytes(1) })).status).toBe(404);
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(200);
  });

  it("registers the tokens on the first write only", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const other = await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: token("z"), body: bytes(1), readHash: await hashToken(token("z")) });
    expect(other.status).toBe(404);
    expect((await call(relay, `${sid(1)}/o`, { token: token("z") })).status).toBe(404);
  });

  it("answers a wrong token on a real session exactly like any request on a session that does not exist", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const real = await call(relay, `${sid(1)}/o/m.progress`, { token: token("x") });
    const ghost = await call(relay, `${sid(2)}/o/m.progress`, { token: token("x") });
    expect([real.status, await text(real)]).toEqual([ghost.status, await text(ghost)]);
    const realList = await call(relay, `${sid(1)}/o`, { token: token("x") });
    const ghostList = await call(relay, `${sid(2)}/o`, { token: token("x") });
    expect([realList.status, await text(realList)]).toEqual([ghostList.status, await text(ghostList)]);
    const realPut = await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: token("x"), body: bytes(1), readHash: "0".repeat(64) });
    const ghostPut = await call(relay, `${sid(2)}/o/c.a.0`, { method: "PUT", token: token("x"), body: bytes(1), readHash: "0".repeat(64) });
    expect([realPut.status, await text(realPut)]).toEqual([ghostPut.status, await text(ghostPut)]);
  });

  it("refuses everything for a session that was never registered", async () => {
    const relay = createMemoryRelay();
    expect((await call(relay, `${sid(5)}/hello`)).status).toBe(404);
    expect((await call(relay, `${sid(5)}/o`, { token: READ })).status).toBe(404);
    expect((await call(relay, `${sid(5)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(1), readHash: "0".repeat(64) })).status).toBe(404);
    expect((await call(relay, sid(5), { method: "DELETE", token: READ })).status).toBe(404);
    expect(relay.sessions.get(sid(5))?.storage.meta).toBeUndefined();
  });

  it("registers a session that has a hello but no write yet as unreadable", async () => {
    const relay = createMemoryRelay();
    await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33) });
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(404);
  });
});

describe("hello", () => {
  it("is first-writer-wins, and the same answer again is a harmless retry", async () => {
    const relay = createMemoryRelay();
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33, 1) })).status).toBe(201);
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33, 1) })).status).toBe(200);
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33, 2) })).status).toBe(409);
    expect(new Uint8Array(await (await call(relay, `${sid(1)}/hello`)).arrayBuffer())).toEqual(bytes(33, 1));
  });
  it("only accepts a small body", async () => {
    const relay = createMemoryRelay();
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(65) })).status).toBe(413);
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(0) })).status).toBe(413);
  });
});

describe("limits", () => {
  it("rejects one object over the per-object limit, by header and by actual length", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const tooBig = bytes(MAX_OBJECT_BYTES + 1);
    expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: tooBig })).status).toBe(413);
    const streamed = new Request(`${BASE}/${sid(1)}/o/c.a.1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": OCTET, "cf-connecting-ip": "198.51.100.1" },
      body: new ReadableStream({ start(c) { c.enqueue(tooBig.subarray(0, 3 * MiB)); c.enqueue(tooBig.subarray(3 * MiB)); c.close(); } }),
      // @ts-expect-error duplex is required for streaming bodies in Node
      duplex: "half",
    });
    expect((await relay.handler(streamed)).status).toBe(413);
    expect(relay.sessions.get(sid(1))!.storage.meta!.objects["c.a.0"]).toBeUndefined();
  });

  it("stops at 200 MB per session and counts replaced progress lists once", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1)); // 10 bytes of progress list already stored
    const four = 4 * MiB;
    const filled = Math.floor((SESSION_MAX_BYTES - 10) / four);
    for (let i = 0; i < filled; i++) expect((await call(relay, `${sid(1)}/o/c.a.${i}`, { method: "PUT", token: WRITE, body: bytes(four) })).status).toBe(201);
    const rest = SESSION_MAX_BYTES - 10 - filled * four;
    expect((await call(relay, `${sid(1)}/o/c.b.0`, { method: "PUT", token: WRITE, body: bytes(rest + 1) })).status).toBe(413);
    expect((await call(relay, `${sid(1)}/o/c.b.0`, { method: "PUT", token: WRITE, body: bytes(rest) })).status).toBe(201);
    expect(relay.sessions.get(sid(1))!.storage.meta!.totalBytes).toBe(SESSION_MAX_BYTES);
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(11) })).status).toBe(413);
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(5) })).status).toBe(200); // shrinking a replaceable object frees room
  }, 60_000);

  it("limits the number of objects in a session", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const clockless = relay.sessions.get(sid(1))!.storage;
    for (let i = 1; i < MAX_OBJECTS_PER_SESSION - 1; i++) clockless.meta!.objects[`c.fill.${i}`] = 0; // fast-forward to one below the limit
    expect((await call(relay, `${sid(1)}/o/c.last.0`, { method: "PUT", token: WRITE, body: bytes(1) })).status).toBe(201);
    expect((await call(relay, `${sid(1)}/o/c.last.1`, { method: "PUT", token: WRITE, body: bytes(1) })).status).toBe(413);
  });

  it("accepts only application/octet-stream bodies", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    for (const type of ["application/json", "text/plain", "multipart/form-data"]) {
      expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: "x", type })).status).toBe(415);
    }
    expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(1), type: null })).status).toBe(415);
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: "x", type: "text/plain" })).status).toBe(415);
    expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(1), type: "application/octet-stream; charset=binary" })).status).toBe(201);
  });

  it("only serves the documented paths, names and methods", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    for (const path of ["short/o", `${sid(1)}/o/../x`, `${sid(1)}/o/c.a`, `${sid(1)}/o/anything`, `${sid(1)}/other`, `${sid(1)}/o/c.a.0/x`]) {
      expect((await call(relay, path, { token: READ })).status).toBe(404);
    }
    expect((await call(relay, `${sid(1)}/o`, { method: "PUT", token: WRITE, body: bytes(1) })).status).toBe(405);
    expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "DELETE", token: READ })).status).toBe(405);
  });

  it("rejects a malformed read-token hash before touching any session", async () => {
    const relay = createMemoryRelay();
    await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33) });
    expect((await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(1), readHash: "nothex" })).status).toBe(400);
    expect((await call(relay, `${sid(2)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(1), readHash: "nothex" })).status).toBe(400);
  });
});

describe("duplicates and concurrency", () => {
  it("accepts the same chunk again with the same bytes and refuses different bytes", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const put = (b: Uint8Array) => call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: b });
    expect((await put(bytes(100, 3))).status).toBe(201);
    expect((await put(bytes(100, 3))).status).toBe(200);
    expect((await put(bytes(100, 4))).status).toBe(409);
    expect(relay.sessions.get(sid(1))!.storage.meta!.totalBytes).toBe(110);
  });

  it("lets the progress list be replaced but never the final list", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(20, 7) })).status).toBe(200);
    const got = new Uint8Array(await (await call(relay, `${sid(1)}/o/m.progress`, { token: READ })).arrayBuffer());
    expect(got).toEqual(bytes(20, 7));
    expect((await call(relay, `${sid(1)}/o/final`, { method: "PUT", token: WRITE, body: bytes(5, 1) })).status).toBe(201);
    expect((await call(relay, `${sid(1)}/o/final`, { method: "PUT", token: WRITE, body: bytes(5, 2) })).status).toBe(409);
  });

  it("keeps every write when many arrive at once", async () => {
    const relay = createMemoryRelay();
    await openSession(relay, sid(1));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => call(relay, `${sid(1)}/o/c.p.${i}`, { method: "PUT", token: WRITE, body: bytes(100 + i) })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const meta = relay.sessions.get(sid(1))!.storage.meta!;
    expect(Object.keys(meta.objects)).toHaveLength(41);
    expect(meta.totalBytes).toBe(10 + Array.from({ length: 40 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0));
  });

  it("lets exactly one of two simultaneous first writers register its tokens", async () => {
    const relay = createMemoryRelay();
    await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33) });
    const attempt = async (c: string) => call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: token(c), body: bytes(1, c.charCodeAt(0)), readHash: await hashToken(token("r")) });
    const statuses = (await Promise.all([attempt("a"), attempt("b"), attempt("c")])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 404, 404]);
  });

  it("keeps the first of two simultaneous hellos", async () => {
    const relay = createMemoryRelay();
    const statuses = (await Promise.all([1, 2, 3].map((v) => call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33, v) })))).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });
});

describe("expiry", () => {
  it("deletes a session 2 hours after its last write, for real", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    await openSession(relay, sid(1));
    const storage = relay.sessions.get(sid(1))!.storage;
    expect(storage.alarmAt).toBe(t.now() + SESSION_IDLE_TTL_MS);

    t.advance(SESSION_IDLE_TTL_MS - 1000);
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(200); // reading does not extend
    await call(relay, `${sid(1)}/o/c.a.0`, { method: "PUT", token: WRITE, body: bytes(5) }); // writing does
    t.advance(SESSION_IDLE_TTL_MS - 1000);
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(200);

    t.advance(1000);
    await relay.runDueAlarms();
    expect(storage.meta).toBeUndefined();
    expect(storage.blobs.size).toBe(0);
    expect(storage.alarmAt).toBeNull();
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(404);
  });

  it("treats an expired session as gone even if the alarm has not run yet, and frees its registry slot", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now, maxActiveSessions: 1 });
    await openSession(relay, sid(1));
    expect((await call(relay, `${sid(2)}/hello`, { method: "PUT", body: bytes(33) })).status).toBe(503);
    t.advance(SESSION_IDLE_TTL_MS);
    expect((await call(relay, `${sid(1)}/o`, { token: READ })).status).toBe(404);
    expect(relay.sessions.get(sid(1))!.storage.meta).toBeUndefined();
    expect((await call(relay, `${sid(2)}/hello`, { method: "PUT", body: bytes(33) })).status).toBe(201);
  });

  it("ends a session that is written to forever after 24 hours", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    await openSession(relay, sid(1));
    for (let i = 0; i < 14; i++) {
      t.advance(100 * 60_000); // each write is inside the idle window, so the idle timer alone would never end it
      expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(3) })).status).toBe(200);
    }
    t.advance(60 * 60_000); // 24 h 20 min since creation, only 60 min since the last write
    expect((await call(relay, `${sid(1)}/o/m.progress`, { method: "PUT", token: WRITE, body: bytes(3) })).status).toBe(404);
  });

  it("lets the alarm reschedule itself when the session is not yet due", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    await openSession(relay, sid(1));
    const { core, storage } = relay.sessions.get(sid(1))!;
    t.advance(60_000);
    await core.onAlarm();
    expect(storage.meta).toBeDefined();
    expect(storage.alarmAt).toBe(storage.meta!.lastWriteAt + SESSION_IDLE_TTL_MS);
  });

  it("expires a session that only has a hello", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33) });
    t.advance(SESSION_IDLE_TTL_MS);
    await relay.runDueAlarms();
    expect(relay.sessions.get(sid(1))!.storage.meta).toBeUndefined();
  });
});

describe("rate limits", () => {
  it("limits requests per minute per source and resets in the next minute", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    for (let i = 0; i < MAX_REQUESTS_PER_MINUTE_PER_IP; i++) expect((await call(relay, `${sid(1)}/hello`, { ip: "203.0.113.7" })).status).toBe(404);
    const limited = await call(relay, `${sid(1)}/hello`, { ip: "203.0.113.7" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await call(relay, `${sid(1)}/hello`, { ip: "203.0.113.8" })).status).toBe(404); // another source is unaffected
    t.advance(60_000);
    expect((await call(relay, `${sid(1)}/hello`, { ip: "203.0.113.7" })).status).toBe(404);
  });

  it("limits new sessions per hour per source", async () => {
    const t = clock();
    const relay = createMemoryRelay({ now: t.now });
    for (let i = 0; i < MAX_NEW_SESSIONS_PER_HOUR_PER_IP; i++) expect((await call(relay, `${sid(i)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.7" })).status).toBe(201);
    expect((await call(relay, `${sid(99)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.7" })).status).toBe(429);
    expect(relay.sessions.has(sid(99))).toBe(false);
    expect((await call(relay, `${sid(99)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.9" })).status).toBe(201);
    t.advance(3_600_000);
    expect((await call(relay, `${sid(98)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.7" })).status).toBe(201);
  });

  it("limits live sessions across all sources, and a deleted session frees its slot", async () => {
    const relay = createMemoryRelay({ maxActiveSessions: 2 });
    await openSession(relay, sid(1));
    await call(relay, `${sid(2)}/hello`, { method: "PUT", body: bytes(33) });
    const full = await call(relay, `${sid(3)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.50" });
    expect(full.status).toBe(503);
    expect(relay.sessions.get(sid(3))?.storage.meta).toBeUndefined();
    expect((await call(relay, `${sid(1)}/hello`, { method: "PUT", body: bytes(33, 9) })).status).toBe(200); // an existing session is not counted twice
    await call(relay, sid(1), { method: "DELETE", token: READ });
    expect((await call(relay, `${sid(3)}/hello`, { method: "PUT", body: bytes(33), ip: "203.0.113.50" })).status).toBe(201);
  });
});

describe("CORS and headers", () => {
  it("answers preflight with only the methods and headers the relay uses", async () => {
    const relay = createMemoryRelay({ allowedOrigin: "https://app.example" });
    const res = await call(relay, `${sid(1)}/o/c.a.0`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, PUT, DELETE, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-read-token-hash");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("marks every answer uncacheable and sets the origin on errors too", async () => {
    const relay = createMemoryRelay();
    const res = await call(relay, `${sid(1)}/o`, { token: READ });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
