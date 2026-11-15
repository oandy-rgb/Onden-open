// The browser app's image codec (browser/imageCodec.ts): what a file is by its signature, and the choices the
// re-encode makes, with the browser's decoder and canvas replaced by stand-ins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasImageCodec, sniffImageFormat } from "../browser/imageCodec.js";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe("sniffImageFormat", () => {
  it("reads the format from the signature, not the file name", () => {
    expect(sniffImageFormat(PNG).format).toBe("png");
    expect(sniffImageFormat(JPEG).format).toBe("jpeg");
    expect(sniffImageFormat(Uint8Array.from(ascii("GIF89a....."))).format).toBe("gif");
    expect(sniffImageFormat(Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")])).format).toBe("webp");
    expect(sniffImageFormat(Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 1, 2])).format).toBe("tiff");
  });
  it("tells AVIF from a camera's HEIC, which the server does not accept either", () => {
    const heif = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0, ...ascii(brand)]);
    expect(sniffImageFormat(heif("avif"))).toEqual({ format: "heif", compression: "av1" });
    expect(sniffImageFormat(heif("heic"))).toEqual({ format: "heif", compression: "hevc" });
  });
  it("recognises SVG text (with or without the XML line) and refuses everything else", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(sniffImageFormat(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).format).toBe("svg");
    expect(sniffImageFormat(text('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>')).format).toBe("svg");
    expect(sniffImageFormat(text("<html><svg></svg></html>")).format).toBe("");
    expect(sniffImageFormat(text("hello")).format).toBe("");
  });
});

describe("canvasImageCodec", () => {
  const closed = vi.fn();
  /** The decoder reports `width`×`height`; the canvas writes `types` and nothing else (a browser without WebP). */
  function stubBrowser(width: number, height: number, writes: string[]) {
    const decoded: unknown[] = [];
    const drawn: Array<[number, number]> = [];
    vi.stubGlobal("createImageBitmap", async (_blob: Blob, options?: unknown) => { decoded.push(options); return { width, height, close: closed }; });
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(public width: number, public height: number) { drawn.push([width, height]); }
      getContext() { return { drawImage: () => {} }; }
      async convertToBlob({ type }: { type: string }) { return new Blob(["x"], { type: writes.includes(type) ? type : "image/png" }); }
    });
    return { decoded, drawn };
  }
  afterEach(() => { vi.unstubAllGlobals(); closed.mockClear(); });

  it("a file the browser cannot decode is refused; one it can is described", async () => {
    vi.stubGlobal("createImageBitmap", async () => { throw new Error("cannot decode"); });
    await expect(canvasImageCodec.inspect(Buffer.from(PNG))).rejects.toThrow();
    await expect(canvasImageCodec.inspect(Buffer.from("not an image"))).rejects.toThrow();
    stubBrowser(10, 10, []);
    expect((await canvasImageCodec.inspect(Buffer.from(PNG))).format).toBe("png");
  });

  it("scales down to the width, never up, and asks the decoder to apply the camera's rotation", async () => {
    const { decoded, drawn } = stubBrowser(4800, 3200, ["image/webp"]);
    const big = await canvasImageCodec.reencode(Buffer.from(JPEG), 2400);
    expect(big.ext).toBe(".webp");
    expect(drawn.at(-1)).toEqual([2400, 1600]);
    expect(decoded.at(-1)).toEqual({ imageOrientation: "from-image" });
    stubBrowser(800, 600, ["image/webp"]);
    await canvasImageCodec.reencode(Buffer.from(PNG), 2400);
    expect(closed).toHaveBeenCalled();
  });

  it("writes JPEG for a photo and PNG for the rest when the canvas cannot write WebP, and says which", async () => {
    stubBrowser(100, 100, ["image/jpeg"]);
    expect((await canvasImageCodec.reencode(Buffer.from(JPEG), 2400)).ext).toBe(".jpg");
    stubBrowser(100, 100, []);
    expect((await canvasImageCodec.reencode(Buffer.from(PNG), 2400)).ext).toBe(".png");
  });
});
