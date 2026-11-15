// The logo and the site icon in the static copy (zip and Pages): the pages the
// renderer serves name them by their live address, /api/media/<file>; the copy
// must name the bundled file by a path relative to the page, and hold the file.
// staticSite.test.ts mocks the media pass; here it runs for real over a temp
// media folder, with the access rule answered per file (its database side is
// covered in pagesPush.integration.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const media = vi.hoisted(() => ({ dir: "", shown: new Set<string>() }));
vi.mock("../services/mediaStore.js", () => ({ get MEDIA_DIR() { return media.dir; } }));
vi.mock("../modules/website/publishing/servedSite.js", () => ({ siteShowsMedia: async (_ws: string, file: string) => media.shown.has(file) }));

import { buildStaticSite, liveOnlyRefs } from "../modules/website/publishing/staticSite.js";

beforeAll(async () => {
  media.dir = await mkdtemp(join(tmpdir(), "onden-static-media-"));
  await writeFile(join(media.dir, "logo.svg"), "<svg/>");
  await writeFile(join(media.dir, "icon.png"), "png");
  await writeFile(join(media.dir, "private.png"), "png");
  media.shown = new Set(["logo.svg", "icon.png"]);
});
afterAll(() => rm(media.dir, { recursive: true, force: true }));

const page = (title: string) =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>${title}</title>` +
  `<link rel="icon" href="/api/media/icon.png" /></head><body>` +
  `<a class="s-frame-brand" href="/site/"><img class="s-frame-brand__logo" src="/api/media/logo.svg" alt="My site" /></a>` +
  `</body></html>`;

function renderer(): typeof fetch {
  const routes: Record<string, string> = {
    "/site/static-pages.json": JSON.stringify({ pages: ["/site/", "/site/a/"], origin: "https://live.example", allowIndexing: true }),
    "/site/": page("Home"),
    "/site/a/": page("A"),
    "/site/_not-found_/": page("Not found"),
    "/site/feed.xml": "<rss/>",
    "/site/sitemap.xml": "<urlset/>",
  };
  return (async (input: string | URL | Request) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const body = routes[path];
    const status = path === "/site/_not-found_/" ? 404 : body === undefined ? 404 : 200;
    return new Response(body ?? "", { status, headers: { "content-type": path.endsWith(".json") ? "application/json" : "text/html" } });
  }) as typeof fetch;
}

describe("logo and site icon in the static copy", () => {
  it("every page names them by a path inside the copy, at every depth, and the files are in it", async () => {
    const { files } = await buildStaticSite({ workspaceId: "ws", ssrUrl: "http://frontend", fetchImpl: renderer() });
    const html = (path: string) => String(files.find((f) => f.path === path)?.content);

    expect(html("site/index.html")).toContain('<link rel="icon" href="../media/icon.png"');
    expect(html("site/index.html")).toContain('src="../media/logo.svg"');
    expect(html("404.html")).toContain('<link rel="icon" href="media/icon.png"');
    expect(html("site/a/index.html")).toContain('<link rel="icon" href="../../media/icon.png"');
    expect(html("site/a/index.html")).toContain('src="../../media/logo.svg"');
    for (const path of ["site/index.html", "site/a/index.html", "404.html"]) expect(html(path)).not.toContain("/api/media/");

    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(["media/logo.svg", "media/icon.png"]));
    expect(liveOnlyRefs(html("site/a/index.html"))).toEqual([]);
  });

  it("a file the site does not show to readers is not copied", async () => {
    media.shown = new Set(["logo.svg"]);
    try {
      const { files } = await buildStaticSite({ workspaceId: "ws", ssrUrl: "http://frontend", fetchImpl: renderer() });
      const paths = files.map((f) => f.path);
      expect(paths).toContain("media/logo.svg");
      expect(paths).not.toContain("media/icon.png");
      expect(paths).not.toContain("media/private.png");
    } finally { media.shown = new Set(["logo.svg", "icon.png"]); }
  });
});
