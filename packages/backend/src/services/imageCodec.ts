// What media.ts needs from an image library, behind one interface: recognising what an image really is, and the
// WebP re-encode an upload gets. The Node server uses sharp (the default below); the browser app, where sharp does not
// exist, installs one built on createImageBitmap + OffscreenCanvas (browser/imageCodec.ts) with `useImageCodec`.

import sharp from "sharp";

/** What a decoder says an image is. `format` uses sharp's names ("jpeg", "png", "webp", "gif", "tiff", "heif", "svg");
 *  `compression` is only set for "heif" ("av1" = AVIF, "hevc" = a camera's HEIC). */
export type ImageInfo = { format: string; compression?: string };

export interface ImageCodec {
  /** What `bytes` decode as; rejects when they do not decode at all. */
  inspect(bytes: Buffer): Promise<ImageInfo>;
  /** `bytes` at most `maxWidth` wide (never enlarged), upright (EXIF orientation applied), re-encoded smaller and
   *  stripped of metadata: WebP where the codec can write it. `ext` names what was written. */
  reencode(bytes: Buffer, maxWidth: number): Promise<{ bytes: Buffer; ext: ".webp" | ".png" | ".jpg" }>;
}

const sharpCodec: ImageCodec = {
  async inspect(bytes) {
    const metadata = await sharp(bytes).metadata();
    return { format: metadata.format ?? "", compression: metadata.compression };
  },
  async reencode(bytes, maxWidth) {
    return { bytes: Buffer.from(await sharp(bytes).resize(maxWidth, undefined, { withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()), ext: ".webp" };
  },
};

let installed: ImageCodec | undefined;

export function useImageCodec(codec: ImageCodec): void {
  installed = codec;
}

export function imageCodec(): ImageCodec {
  return installed ?? sharpCodec;
}
