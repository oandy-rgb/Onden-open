// GET /api/media/:filename Range support. The read gate (canReadMedia) is
// mocked so this runs without a database; the gate's own policy is covered by
// mediaAuthority.integration.test.ts. What is checked here is the HTTP side:
// Range → 206/416, If-Range, 304, and that a refused reader gets a 404 even
// when it asks for a Range.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const gate = vi.hoisted(() => ({ allowed: true }));
vi.mock("../db.js", () => ({ getWorkspaceId: async () => "ws", q: async () => ({ rows: [] }) }));
vi.mock("../services/mediaAccess.js", () => ({ canReadMedia: async () => gate.allowed }));
vi.mock("../services/spaces.js", () => ({ canWriteSomewhere: async () => true }));
vi.mock("../services/media.js", () => ({ storeMedia: async () => ({ ok: false, reason: "unsupported" }) }));

import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { parseMediaRange } from "../services/mediaRange.js";

const app = new Hono();
app.route("/api/media", mediaRouter);

const name = `${Date.now()}-range.mp3`;
const content = "0123456789abcdefghij"; // 20 bytes
const get = (headers: Record<string, string> = {}) => app.request(`/api/media/${name}`, { headers });

beforeAll(() => {
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(join(MEDIA_DIR, name), content);
});
afterAll(() => rmSync(join(MEDIA_DIR, name), { force: true }));

describe("GET /api/media/:filename ranges", () => {
  it("without Range: 200, whole file, advertises Accept-Ranges and Content-Length", async () => {
    gate.allowed = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("20");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(content);
  });

  it("bytes=0-9 → 206 with Content-Range and only that slice", async () => {
    const res = await get({ Range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/20");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("0123456789");
  });

  it("bytes=10- runs to the end; bytes=-5 is the last five bytes", async () => {
    const open = await get({ Range: "bytes=10-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 10-19/20");
    expect(await open.text()).toBe("abcdefghij");
    const suffix = await get({ Range: "bytes=-5" });
    expect(suffix.headers.get("content-range")).toBe("bytes 15-19/20");
    expect(await suffix.text()).toBe("fghij");
  });

  it("an end past the file is clamped", async () => {
    const res = await get({ Range: "bytes=15-999" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 15-19/20");
  });

  it("out of range or malformed single range → 416 with bytes */size", async () => {
    for (const range of ["bytes=20-", "bytes=30-40", "bytes=9-3", "bytes=-0", "bytes=abc", "bytes=-"]) {
      const res = await get({ Range: range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe("bytes */20");
    }
  });

  it("multiple ranges or another unit are ignored: 200 whole file", async () => {
    for (const range of ["bytes=0-1,4-5", "items=0-3"]) {
      const res = await get({ Range: range });
      expect(res.status, range).toBe(200);
      expect(await res.text()).toBe(content);
    }
  });

  it("If-Range that is not the current ETag → 200 whole file; matching → 206", async () => {
    const etag = (await get()).headers.get("etag")!;
    const stale = await get({ Range: "bytes=0-9", "If-Range": '"stale"' });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(content);
    const fresh = await get({ Range: "bytes=0-9", "If-Range": etag });
    expect(fresh.status).toBe(206);
  });

  it("If-None-Match still wins with 304 and no body", async () => {
    const etag = (await get()).headers.get("etag")!;
    const res = await get({ "If-None-Match": etag, Range: "bytes=0-9" });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("a reader the gate refuses gets 404 even with a Range", async () => {
    gate.allowed = false;
    const res = await get({ Range: "bytes=0-9" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).not.toContain("0123");
    gate.allowed = true;
  });
});

describe("parseMediaRange", () => {
  it("an empty file has no satisfiable range", () => {
    expect(parseMediaRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseMediaRange("bytes=-5", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseMediaRange(undefined, 0)).toEqual({ kind: "full" });
  });
  it("a suffix longer than the file is the whole file", () => {
    expect(parseMediaRange("bytes=-99", 20)).toEqual({ kind: "partial", start: 0, end: 19 });
  });
});
