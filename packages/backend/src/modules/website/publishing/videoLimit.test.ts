import { describe, expect, it } from "vitest";
import type { BundleFile } from "./githubPages.js";
import { limitStaticVideos, oversizeVideoIds } from "./videoLimit.js";

const BIG = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4";
const SMALL = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4";
const page = (lang: string) => `<html lang="${lang}"><body><p><video src="../../media/${BIG}" controls preload="none"></video></p><p><video src="../../media/${SMALL}" controls></video></p></body></html>`;
const files = (): BundleFile[] => [
  { path: "site/a/index.html", content: page("zh-TW") },
  { path: `media/${BIG}`, content: Buffer.alloc(11) },
  { path: `media/${SMALL}`, content: Buffer.alloc(5) },
];
const sizes = (fs: readonly BundleFile[]) => fs.map((f) => ({ path: f.path, bytes: typeof f.content === "string" ? f.content.length : f.content.length }));
// The push decides from sizes and never reads the big file; this mirrors it.
const limit = (fs: BundleFile[], origin: string, max: number) => {
  const tooBig = oversizeVideoIds(sizes(fs), max);
  return { files: limitStaticVideos(fs.filter((f) => !(f.path.startsWith("media/") && tooBig.has(f.path.slice(6)))), origin, tooBig), leftOut: [...tooBig] };
};

describe("limitStaticVideos", () => {
  it("leaves a video over the limit out and links its page back to the original site", () => {
    const { files: out, leftOut } = limit(files(), "https://notes.example/", 10);
    expect(leftOut).toEqual([BIG]);
    expect(out.map((f) => f.path)).toEqual(["site/a/index.html", `media/${SMALL}`]);
    const html = out[0]!.content as string;
    expect(html).toContain(`<a class="md-video-toolarge" href="https://notes.example/api/media/${BIG}" target="_blank" rel="noreferrer">這部影片太大，在原站觀看</a>`);
    expect(html).toContain(`<video src="../../media/${SMALL}"`); // the small one is untouched
    expect(html).not.toContain(`src="../../media/${BIG}"`); // no player for the big one
  });

  it("uses the page's language, with English as the fallback", () => {
    const en = [{ path: "site/a/index.html", content: page("en") }, files()[1]!];
    expect(limit(en, "https://n.example", 10).files[0]!.content).toContain("This video is too large — watch it on the original site");
  });

  it("a site with no address says so instead of linking nowhere", () => {
    const html = limit(files(), "", 10).files[0]!.content as string;
    expect(html).toContain("這部影片太大，這個版本無法播放");
    expect(html).not.toContain("<a class=\"md-video-toolarge\"");
  });

  it("nothing over the limit: the files are returned as they are", () => {
    const { files: out, leftOut } = limit(files(), "https://n.example", 100);
    expect(leftOut).toEqual([]);
    expect(out).toEqual(files());
  });

  it("only videos count: a big image or audio file is kept", () => {
    const big = [{ path: "media/cccccccccccccccccccccccccccccccc.webp", content: Buffer.alloc(50) }, { path: "media/dddddddddddddddddddddddddddddddd.mp3", content: Buffer.alloc(50) }];
    expect(limit(big, "https://n.example", 10).leftOut).toEqual([]);
  });
});
