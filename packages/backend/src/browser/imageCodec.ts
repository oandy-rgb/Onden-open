// The browser app's image codec (services/imageCodec.ts): what sharp does on the server, with the browser's own
// decoder — createImageBitmap and OffscreenCanvas, both available in a Worker.
//  - inspect: the format is read from the file's signature (so a PNG named .jpg is still a PNG), then the browser must
//    be able to decode it. SVG is text, not decoded: sanitiseSvg has already rebuilt it and a Worker cannot decode one.
//  - reencode: scaled down to `maxWidth` (never up), drawn upright (the camera's EXIF rotation is applied by the
//    decoder: `imageOrientation: "from-image"`), and written as WebP. A browser that cannot write WebP (Safari's
//    canvas) gets JPEG for a photo and PNG for anything else; the extension says which one was written.
//    Metadata (location, camera) does not survive a canvas, as it does not survive sharp.

import { MEDIA_TYPES } from "@onden/markdown";
import type { ImageCodec, ImageInfo } from "../services/imageCodec.js";

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** The format by signature (sharp's names), or "" when it is none this codec knows. Exported for tests. */
export function sniffImageFormat(bytes: Uint8Array): ImageInfo {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { format: "jpeg" };
  if (ascii(bytes, 0, 4) === "GIF8") return { format: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { format: "webp" };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { format: "tiff" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    // The major brand and the compatible brands: "avif"/"avis" are AV1; a camera's HEIC says heic/heix/hevc…
    const brands = ascii(bytes, 8, Math.min(bytes.length, 8 + 64));
    return { format: "heif", compression: /avif|avis/.test(brands) ? "av1" : "hevc" };
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { format: "svg" };
  return { format: "" };
}

// Which formats are which MIME types is @onden/markdown's table (mediaTypes.ts); TIFF is not an upload type there.
const MIME_OF = (ext: string) => MEDIA_TYPES[ext]!.mime;
const [PNG, JPEG, WEBP] = [MIME_OF(".png"), MIME_OF(".jpg"), MIME_OF(".webp")];
const FORMAT_TYPES: Record<string, string> = { png: PNG, jpeg: JPEG, gif: MIME_OF(".gif"), webp: WEBP, tiff: "image/tiff", heif: MIME_OF(".avif") };

export const canvasImageCodec: ImageCodec = {
  async inspect(bytes) {
    const info = sniffImageFormat(bytes);
    if (!info.format) throw new Error("not an image this browser can read");
    if (info.format === "svg") return info;
    // Decoding is the proof that the file is the image it claims to be (and not, say, a truncated download).
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: FORMAT_TYPES[info.format] }));
    bitmap.close();
    return info;
  },
  async reencode(bytes, maxWidth) {
    const source = sniffImageFormat(bytes).format;
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: FORMAT_TYPES[source] }), { imageOrientation: "from-image" });
    try {
      const scale = Math.min(1, maxWidth / bitmap.width);
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas to draw on");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const webp = await canvas.convertToBlob({ type: WEBP, quality: 0.85 });
      if (webp.type === WEBP) return { bytes: Buffer.from(await webp.arrayBuffer()), ext: ".webp" as const };
      // This browser's canvas cannot write WebP (it hands back PNG): a photo has no transparency to keep, so JPEG.
      if (source === "jpeg") {
        const jpeg = await canvas.convertToBlob({ type: JPEG, quality: 0.85 });
        if (jpeg.type === JPEG) return { bytes: Buffer.from(await jpeg.arrayBuffer()), ext: ".jpg" as const };
      }
      return { bytes: Buffer.from(await (await canvas.convertToBlob({ type: PNG })).arrayBuffer()), ext: ".png" as const };
    } finally {
      bitmap.close();
    }
  },
};
