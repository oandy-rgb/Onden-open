// The biggest video the static host (pagesPush) carries. A static host such as
// GitHub Pages has a soft size budget per site and rejects big blobs. A video
// over the limit is never read (its size is checked first) and is left out of the push and its page links back to the original site;
// the zip download and the live site keep every video.
//
// The publish preview names these videos beforehand (preview.ts large_videos),
// so the limit is never a surprise after the fact.

import { isMediaId, mediaTypeOf } from "@onden/markdown";
import type { BundleFile } from "./githubPages.js";
import { siteWords } from "./siteWords.js";

/** One video up to this size goes to the static host. */
export const STATIC_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export const isVideoName = (filename: string): boolean => mediaTypeOf(filename)?.kind === "video";

const VIDEO_ELEMENT = /<video\b[^>]*>[\s\S]*?<\/video>/gi;
const MEDIA_IN_SRC = /\bsrc="[^"]*\bmedia\/([^"/?#]+)(?:[?#][^"]*)?"/i;

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The ids of the videos over `maxBytes` among a copy's files (path + size, as
 *  siteBundle.bundleFileSizes lists them — decided before any file is read). */
export function oversizeVideoIds(
  sizes: ReadonlyArray<{ path: string; bytes: number }>, maxBytes: number = STATIC_VIDEO_MAX_BYTES,
): Set<string> {
  const tooBig = new Set<string>();
  for (const { path, bytes } of sizes) {
    const id = path.startsWith("media/") ? path.slice(6) : "";
    if (id && isMediaId(id) && isVideoName(id) && bytes > maxBytes) tooBig.add(id);
  }
  return tooBig;
}

/** `files` (the bundle about to be pushed) without the videos in `tooBig`
 *  (already left unread), whose `<video>` in each page becomes a link to the
 *  file on the live site (`liveOrigin`, or a plain sentence when the site has
 *  no address). Run on the final files, after the copy's address is applied:
 *  retargeting would turn that link into a copy path. */
export function limitStaticVideos(files: readonly BundleFile[], liveOrigin: string, tooBig: ReadonlySet<string>): BundleFile[] {
  if (tooBig.size === 0) return [...files];
  const origin = liveOrigin.replace(/\/+$/, "");
  return files
    .filter((f) => !(f.path.startsWith("media/") && tooBig.has(f.path.slice(6))))
    .map((f) => {
      if (typeof f.content !== "string" || !f.path.endsWith(".html")) return f;
      const words = siteWords(/<html[^>]*\slang="([^"]+)"/i.exec(f.content)?.[1]);
      const content = f.content.replace(VIDEO_ELEMENT, (video) => {
        const id = MEDIA_IN_SRC.exec(video)?.[1];
        if (!id || !tooBig.has(id)) return video;
        if (!origin) return `<span class="md-video-toolarge">${words.videoTooLargeNoLink}</span>`;
        return `<a class="md-video-toolarge" href="${escapeAttr(`${origin}/api/media/${id}`)}" target="_blank" rel="noreferrer">${words.videoTooLargeLink}</a>`;
      });
      return content === f.content ? f : { ...f, content };
    });
}
