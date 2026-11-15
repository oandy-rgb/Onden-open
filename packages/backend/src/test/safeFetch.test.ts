// SSRF guard (audit #2): address-validation table + live mechanics against a
// local HTTP server. The server tests run with allowPrivateAddresses (the
// TESTS-ONLY escape hatch) to exercise redirects/size-cap/timeout; the
// default-deny tests prove loopback/private/metadata never connect.

import { describe, it, expect, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { isForbiddenAddress, safeFetch, SafeFetchError } from "../services/safeFetch.js";

describe("isForbiddenAddress", () => {
  const forbidden = [
    "127.0.0.1", "127.8.8.8", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.9.9",
    "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3",
    // HEX v4-mapped forms — the dotted-decimal-only regex used to let these
    // through straight to loopback / cloud metadata (audit 2026-06-20).
    "::ffff:7f00:1", "::ffff:7f00:0001", "::FFFF:7F00:1", "::ffff:a9fe:a9fe", "::ffff:a00:1",
    "[::ffff:7f00:1]".replace(/[[\]]/g, ""),
    // v4-compatible ::127.0.0.1, NAT64 64:ff9b::/96, 6to4 2002::/16 embeddings.
    "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::",
    "not-an-ip",
  ];
  const allowed = [
    "1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111",
    "::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::", "64:ff9b::808:808",
  ];
  it.each(forbidden)("refuses %s", (ip) => expect(isForbiddenAddress(ip)).toBe(true));
  it.each(allowed)("allows %s", (ip) => expect(isForbiddenAddress(ip)).toBe(false));
});

describe("safeFetch", () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const srv = createServer(handler);
    servers.push(srv);
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const addr = srv.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it("refuses loopback by default — the request never reaches the server", async () => {
    let hit = false;
    const base = await serve((_req, res) => { hit = true; res.end("nope"); });
    await expect(safeFetch(base)).rejects.toMatchObject({ code: "forbidden_address" });
    expect(hit).toBe(false);
  });

  it("env gate: SAFE_FETCH_ALLOW_PRIVATE allows private OUTSIDE production, never IN it", async () => {
    const base = await serve((_req, res) => res.end("ok"));
    try {
      // production: the flag is ignored — private stays blocked (footgun closed)
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SAFE_FETCH_ALLOW_PRIVATE", "1");
      await expect(safeFetch(base)).rejects.toMatchObject({ code: "forbidden_address" });
      // a non-production env (e.g. the e2e stack, NODE_ENV unset/e2e) + flag → allowed
      vi.stubEnv("NODE_ENV", "e2e");
      await expect(safeFetch(base)).resolves.toMatchObject({ status: 200 });
      // flag off → blocked even outside production
      vi.stubEnv("SAFE_FETCH_ALLOW_PRIVATE", "");
      await expect(safeFetch(base)).rejects.toMatchObject({ code: "forbidden_address" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses non-http protocols and metadata IP literals", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "bad_protocol" });
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "forbidden_address" });
  });

  it("refuses a HEX v4-mapped loopback literal before it connects (SSRF regression)", async () => {
    // The bracketed literal maps to 127.0.0.1; with the old dotted-only check it
    // sailed past the literal gate and reached a loopback listener. It must now be
    // refused at the literal check, before any socket is opened.
    let hit = false;
    const base = await serve((_req, res) => { hit = true; res.end("nope"); });
    const port = new URL(base).port;
    await expect(safeFetch(`http://[::ffff:7f00:1]:${port}/`)).rejects.toMatchObject({ code: "forbidden_address" });
    await expect(safeFetch(`http://[::ffff:a9fe:a9fe]/latest/meta-data/`)).rejects.toMatchObject({ code: "forbidden_address" });
    expect(hit).toBe(false);
  });

  it("follows redirects with per-hop validation and a hop cap", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/a") { res.writeHead(302, { location: "/b" }); res.end(); }
      else if (req.url === "/b") { res.end("landed"); }
      else { res.writeHead(302, { location: req.url ?? "/" }); res.end(); } // self-loop
    });
    const ok = await safeFetch(`${base}/a`, { allowPrivateAddresses: true });
    expect(ok.text).toBe("landed");
    await expect(safeFetch(`${base}/loop`, { allowPrivateAddresses: true, maxRedirects: 3 }))
      .rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("a redirect to a non-http protocol is refused mid-flight (per-hop validation)", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    await expect(safeFetch(`${base}/`, { allowPrivateAddresses: true })).rejects.toMatchObject({ code: "bad_protocol" });
  });

  it("destroys the socket past maxBytes", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      const chunk = "x".repeat(64 * 1024);
      const pump = () => { while (res.writable && res.write(chunk)) { /* fill until backpressure */ } };
      res.on("drain", pump);
      pump();
    });
    await expect(safeFetch(`${base}/big`, { allowPrivateAddresses: true, maxBytes: 128 * 1024 }))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("a peer that trickles bytes inside the idle window still hits the total deadline", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      const tick = setInterval(() => res.write("x"), 50); // never idle for 300 ms
      res.on("close", () => clearInterval(tick));
    });
    const started = Date.now();
    await expect(safeFetch(base, { allowPrivateAddresses: true, timeoutMs: 300, deadlineMs: 600 }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the deadline spans redirects, not each hop", async () => {
    const slow = await serve((_req, res) => { setTimeout(() => res.end("late"), 400); });
    const hop = await serve((_req, res) => { setTimeout(() => { res.writeHead(302, { location: slow }); res.end(); }, 400); });
    await expect(safeFetch(hop, { allowPrivateAddresses: true, timeoutMs: 1000, deadlineMs: 600 }))
      .rejects.toMatchObject({ code: "timeout" });
  });
});
