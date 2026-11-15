// getAttachment / getNode attachments without a database: the note lookup,
// read scope and media owner rule are stubbed, so this pins what the tool
// itself decides — which refs count, what comes back, size handling, and the
// MCP image block. The real read scope and owner rule run in
// getAttachment.integration.test.ts.

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const h = vi.hoisted(() => ({ dir: "", markdown: "" as string | null, found: true, mediaReadable: true }));

vi.mock("../services/mediaStore.js", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  h.dir = mkdtempSync(join(tmpdir(), "onden-att-"));
  return { MEDIA_DIR: h.dir };
});
vi.mock("../db.js", () => ({
  pool: { query: async () => ({ rows: h.found ? [{ markdown: h.markdown }] : [] }) },
}));
vi.mock("../services/readPolicy.js", () => ({ readableScopeSql: () => "TRUE" }));
vi.mock("../services/mediaAccess.js", () => ({ canReadMedia: async () => h.mediaReadable }));

import { getAttachment, ATTACHMENT_MAX_BYTES } from "../services/agentTools/getAttachment.js";
import { bodyMediaIds, refToMediaId } from "../services/agentTools/attachmentRefs.js";
import type { ActorCtx } from "../types.js";

const actor: ActorCtx = { id: "a", name: "Bot", role: "editor", type: "agent" };
const ctx = { actor, workspaceId: "w" };
const NODE = "11111111-1111-4111-8111-111111111111";
const call = (ref: string) => getAttachment.handler({ nodeId: NODE, ref }, ctx);

const IMG = "0123456789abcdef0123456789abcdef.png";
const DOC = "fedcba9876543210fedcba9876543210.pdf";
let png: Buffer;

afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

beforeEach(async () => {
  h.markdown = `bug\n\n![shot](/api/media/${IMG})\n\n[spec](/api/media/${DOC})`;
  h.found = true;
  h.mediaReadable = true;
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#f00" } }).png().toBuffer();
  writeFileSync(join(h.dir, IMG), png);
  writeFileSync(join(h.dir, DOC), "%PDF-1.4 x");
});

describe("reference parsing", () => {
  it("reads URL, origin URL, embed, markdown image and bare id; ignores query", () => {
    for (const ref of [`/api/media/${IMG}`, `https://onden.example/api/media/${IMG}?w=1`, `![[${IMG}]]`, `![x](/api/media/${IMG})`, IMG]) {
      expect(refToMediaId(ref)).toBe(IMG);
    }
    expect(refToMediaId("../etc/passwd")).toBeNull();
    expect(refToMediaId("")).toBeNull();
  });
  it("body ids: links, images and id embeds; a note embed names no file", () => {
    expect(bodyMediaIds(`![[${IMG}]] ![[Some note]] [a](/api/media/${DOC})`).sort()).toEqual([IMG, DOC].sort());
    expect(bodyMediaIds("![[Some note]] no files")).toEqual([]);
  });
});

describe("getAttachment", () => {
  it("returns an image as base64 with metadata", async () => {
    const r = await call(`/api/media/${IMG}`) as { mime: string; data_base64: string; size: number; kind: string };
    expect(r.mime).toBe("image/png");
    expect(r.kind).toBe("image");
    expect(Buffer.from(r.data_base64, "base64").equals(png)).toBe(true);
    expect(r.size).toBe(png.length);
  });

  it("accepts the bare id and an ![[embed]] ref", async () => {
    h.markdown = `![[${IMG}]]`;
    expect(((await call(IMG)) as { data_base64?: string }).data_base64).toBeTruthy();
    expect(((await call(`![[${IMG}]]`)) as { data_base64?: string }).data_base64).toBeTruthy();
  });

  it("non-image: metadata only, no data", async () => {
    const r = await call(DOC) as Record<string, unknown>;
    expect(r).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    expect(r.data_base64).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("refuses a media id the note's body does not reference", async () => {
    const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    writeFileSync(join(h.dir, other), png);
    expect(await call(other)).toMatchObject({ error: "not_referenced" });
    expect(await call("not-a-ref/../x")).toMatchObject({ error: "not_referenced" });
  });

  it("refuses a referenced file whose owner the caller cannot read", async () => {
    h.mediaReadable = false;
    expect(await call(IMG)).toMatchObject({ error: "not_referenced" });
  });

  it("note not readable / absent: null (same as getNode)", async () => {
    h.found = false;
    expect(await call(IMG)).toBeNull();
  });

  it("referenced but missing on disk: not_found", async () => {
    h.markdown = "![](/api/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png)";
    expect(await call("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png")).toMatchObject({ error: "not_found" });
  });

  it("oversized image is downscaled when it decodes", async () => {
    const big = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png().toBuffer();
    expect(big.length).toBeGreaterThan(ATTACHMENT_MAX_BYTES);
    writeFileSync(join(h.dir, IMG), big);
    const r = await call(IMG) as { downscaled?: boolean; mime: string; data_base64: string; size: number };
    expect(r).toMatchObject({ downscaled: true, mime: "image/webp", size: big.length });
    expect(Buffer.from(r.data_base64, "base64").length).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
  });

  it("oversized and not decodable: too_large with metadata, no data", async () => {
    writeFileSync(join(h.dir, IMG), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1));
    const r = await call(IMG) as Record<string, unknown>;
    expect(r).toMatchObject({ error: "too_large", max_bytes: ATTACHMENT_MAX_BYTES, size: ATTACHMENT_MAX_BYTES + 1, mime: "image/png" });
    expect(r.data_base64).toBeUndefined();
  });

  it("MCP: image block plus a text block without the base64", async () => {
    const r = await call(IMG);
    const blocks = getAttachment.mcpContent!(r);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect((blocks[0] as { text: string }).text).not.toContain("data_base64");
    expect(JSON.parse((blocks[0] as { text: string }).text)).toMatchObject({ mime: "image/png", name: IMG });
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    // errors and metadata-only results carry no image block
    expect(getAttachment.mcpContent!(await call(DOC))).toHaveLength(1);
    expect(getAttachment.mcpContent!(null)).toEqual([{ type: "text", text: "null" }]);
  });
});
