// POST /api/media stores through services/media.ts storeMedia, the same path
// the vault image import uses (D23): one validation (allowlist, size cap, SVG
// sanitising, content sniffing for images, PDFs and office documents), an
// atomic write and an uploader record. Before D23 the route trusted the
// extension: a .pdf/.gif/.docx of any bytes was stored, and a broken .png
// crashed sharp into a 500.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { MAX_MEDIA_REQUEST_BYTES, MEDIA_TYPES } from "@onden/markdown";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, q } from "../db.js";
import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

let actor: ActorCtx = { id: "", name: "Uploader", type: "human", role: "editor" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/media", mediaRouter);

const created: string[] = [];
async function upload(name: string, bytes: Buffer | string) {
  const form = new FormData();
  form.append("file", new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name));
  const res = await app.request("/api/media", { method: "POST", body: form });
  const body = await res.json() as { url?: string; error?: string };
  if (body.url) created.push(join(MEDIA_DIR, body.url.split("/").pop()!));
  return { status: res.status, ...body };
}
const stored = (url: string) => readFileSync(join(MEDIA_DIR, url.split("/").pop()!));

describe.skipIf(!isTestDatabase())("POST /api/media — storeMedia validation", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await getWorkspaceId();
    actor = await persistActor(ws, actor);
  });
  afterAll(() => { for (const p of created) if (existsSync(p)) rmSync(p, { force: true }); });

  it("re-encodes a real PNG to WebP and records the uploader", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).png().toBuffer();
    const res = await upload("dot.png", png);
    expect(res.status).toBe(200);
    expect(res.url).toMatch(/^\/api\/media\/[0-9a-f]{32}\.webp$/);
    expect((await sharp(stored(res.url!)).metadata()).format).toBe("webp");
    const owner = await q(`SELECT uploader_actor_id FROM media_uploads WHERE filename = $1 AND workspace_id = $2`,
      [res.url!.split("/").pop(), ws]);
    expect(owner.rows).toEqual([{ uploader_actor_id: actor.id }]);
  });

  it("accepts a raster image under another raster extension (it is re-encoded anyway)", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#0f0" } }).png().toBuffer();
    for (const name of ["saved-from-web.jpg", "photo.webp", "pic.avif"]) {
      const res = await upload(name, png);
      expect(res.status, name).toBe(200);
      expect(res.url, name).toMatch(/\.webp$/);
    }
  });

  it("keeps the strict match where bytes are stored as given (.gif)", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00f" } }).png().toBuffer();
    expect(await upload("really-png.gif", png)).toMatchObject({ status: 400, error: "unreadable file" });
  });

  it("refuses an image whose bytes are not that image (was a 500 from sharp)", async () => {
    expect(await upload("fake.png", "not a png")).toMatchObject({ status: 400, error: "unreadable file" });
  });

  it("refuses a .gif, .pdf or .docx that is something else (was stored as is)", async () => {
    for (const name of ["fake.gif", "fake.pdf", "fake.docx"]) {
      expect(await upload(name, "<html><script>alert(1)</script></html>"), name)
        .toMatchObject({ status: 400, error: "unreadable file" });
    }
  });

  it("keeps a real PDF's bytes", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const res = await upload("paper.pdf", pdf);
    expect(res.status).toBe(200);
    expect(stored(res.url!)).toEqual(pdf);
  });

  it("sanitises an SVG", async () => {
    const res = await upload("x.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`);
    expect(res.status).toBe(200);
    const text = stored(res.url!).toString("utf8");
    expect(text).not.toContain("<script");
    expect(text).toContain("<rect");
  });

  it("refuses an SVG that declares a DOCTYPE or an ENTITY", async () => {
    // Inert marker: the entity holds plain text, not markup. The class is what
    // is refused: an entity can expand to markup after a regex sanitiser ran.
    const withEntity = `<!DOCTYPE svg [<!ENTITY marker "inert">]><svg xmlns="http://www.w3.org/2000/svg"><text>&marker;</text></svg>`;
    expect(await upload("entity.svg", withEntity)).toMatchObject({ status: 400, error: "unreadable file" });
    expect(await upload("doctype.svg", `<!doctype svg><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`))
      .toMatchObject({ status: 400, error: "unreadable file" });
  });

  it("stores audio as given and refuses an extension off the allowlist", async () => {
    const res = await upload("clip.mp3", Buffer.from("ID3 audio"));
    expect(res.status).toBe(200);
    expect(stored(res.url!).toString()).toBe("ID3 audio");
    expect(await upload("tool.exe", "MZ")).toMatchObject({ status: 400, error: "unsupported type" });
    expect(await upload("empty.mp3", "")).toMatchObject({ status: 400, error: "unreadable file" });
  });

  // D35: the site's favicon picker offered .ico, which the allowlist did not
  // have (400), and .aac/.flac/.ogv played in every renderer but could not be
  // uploaded. One media table (@onden/markdown mediaTypes.ts) now feeds both.
  it("takes a real .ico favicon (served image/x-icon) and refuses one without the icon header", async () => {
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0]);
    const res = await upload("favicon.ICO", ico);
    expect(res.status).toBe(200);
    expect(res.url).toMatch(/^\/api\/media\/[0-9a-f]{32}\.ico$/);
    expect(stored(res.url!).equals(ico)).toBe(true);
    const served = await app.request(res.url!);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/x-icon");
    expect(await upload("fake.ico", "<svg onload=alert(1)>")).toMatchObject({ status: 400, error: "unreadable file" });
  });

  it("takes the audio/video the renderers play: .aac, .flac, .oga, .ogv", async () => {
    for (const [name, mime] of [["a.aac", "audio/aac"], ["a.flac", "audio/flac"], ["a.oga", "audio/ogg"], ["v.ogv", "video/ogg"]]) {
      const res = await upload(name, Buffer.from("media bytes"));
      expect(res.status, name).toBe(200);
      expect((await app.request(res.url!)).headers.get("content-type"), name).toBe(mime);
    }
  });

  // D65: the refusal names a code and the cap, so the app can say it in the
  // user's language; a request over the transport cap is refused before
  // parseBody buffers it.
  it("refuses a file over its type's cap with file_too_large and the cap", async () => {
    const svgCap = MEDIA_TYPES[".svg"].maxBytes;
    expect(await upload("big.svg", `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(svgCap)}</svg>`))
      .toMatchObject({ status: 413, error: "file_too_large", detail: "file exceeds 2 MB limit", max_bytes: svgCap });
  });

  it("refuses a request over MAX_MEDIA_REQUEST_BYTES before reading it", async () => {
    const form = new FormData();
    form.append("file", new File(["ID3"], "clip.mp3"));
    const res = await app.request("/api/media", {
      method: "POST", body: form, headers: { "content-length": String(MAX_MEDIA_REQUEST_BYTES + 1) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "file_too_large", detail: `file exceeds ${MAX_MEDIA_REQUEST_BYTES / 1024 / 1024} MB limit`, max_bytes: MAX_MEDIA_REQUEST_BYTES,
    });
  });

  it("GET serves only media ids: traversal and temporaries are 404", async () => {
    // The directory appears with the first stored upload; in a shuffled run on a fresh checkout this test can be first.
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(join(MEDIA_DIR, ".store-d23-probe.tmp"), "partial");
    created.push(join(MEDIA_DIR, ".store-d23-probe.tmp"));
    for (const path of ["%2e%2e", "..%2f..%2fetc", ".store-d23-probe.tmp", "a%20b.png"]) {
      expect((await app.request(`/api/media/${path}`)).status, path).toBe(404);
    }
    rmSync(join(MEDIA_DIR, ".store-d23-probe.tmp"), { force: true });
  });

  it("leaves no temporary file behind", async () => {
    // Its own uploads, one stored and one refused, compared with the
    // temporaries already there (the media directory is shared with every
    // other test and with earlier runs).
    const temporaries = () => (existsSync(MEDIA_DIR) ? readdirSync(MEDIA_DIR) : []).filter((f) => f.endsWith(".tmp"));
    const before = new Set(temporaries());
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00f" } }).png().toBuffer();
    expect((await upload("left.png", png)).status).toBe(200);
    expect((await upload("left.png", "not an image")).status).toBeGreaterThanOrEqual(400);
    expect(temporaries().filter((f) => !before.has(f))).toEqual([]);
  });
});
