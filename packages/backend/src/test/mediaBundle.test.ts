import { describe, it, expect } from "vitest";
import { bundleMedia } from "@onden/markdown";
import { MEDIA_BUNDLE_PREFIX } from "../modules/website/publishing/mediaBundle.js";

// The pass bundleSiteFiles makes over each page, for a root-level file.
const bundleMediaRefs = (text: string) => {
  const { content, ids } = bundleMedia(text, (file) => `${MEDIA_BUNDLE_PREFIX}/${file}`);
  return { content, filenames: ids };
};

describe("bundleMedia — make published media self-contained", () => {
  it("rewrites /api/media/<file> to bundle-relative media/<file> and reports filenames", () => {
    const site = JSON.stringify({
      payload: {
        nodes: [{ markdown: "# Hi\n\n![fig](/api/media/abc123.webp)" }],
        presentation: { site: { logo: "/api/media/logo.png" } },
      },
    });
    const { content, filenames } = bundleMediaRefs(site);
    expect(content).toContain(`${MEDIA_BUNDLE_PREFIX}/abc123.webp`);
    expect(content).toContain(`${MEDIA_BUNDLE_PREFIX}/logo.png`);
    expect(content).not.toContain("/api/media/");
    expect(filenames.sort()).toEqual(["abc123.webp", "logo.png"]);
  });

  it("dedupes a filename referenced multiple times", () => {
    const site = "![a](/api/media/x.webp) and again ![b](/api/media/x.webp)";
    const { content, filenames } = bundleMediaRefs(site);
    expect(filenames).toEqual(["x.webp"]);
    expect(content).toBe(`![a](${MEDIA_BUNDLE_PREFIX}/x.webp) and again ![b](${MEDIA_BUNDLE_PREFIX}/x.webp)`);
  });

  it("only captures a single safe path segment (cannot escape the media dir)", () => {
    // A media id is one segment (no '/') that never starts with '.', so the
    // copy target is always media/<segment>.
    for (const hostile of ["![x](/api/media/..)", "![x](/api/media/../x)", "![x](/api/media/.hidden)"]) {
      const { content, filenames } = bundleMediaRefs(hostile);
      expect(filenames).toEqual([]); // not collected, left as-is
      expect(content).toBe(hostile);
    }
    const { filenames: f2 } = bundleMediaRefs("![x](/api/media/sub/dir/file.png)");
    expect(f2).toEqual(["sub"]); // only the leading segment before the first '/'
  });

  it("rewrites a whole absolute media URL, not just its path", () => {
    const { content, filenames } = bundleMediaRefs('{"logo":"https://notes.example/api/media/logo.png?v=2"}');
    expect(content).toBe(`{"logo":"${MEDIA_BUNDLE_PREFIX}/logo.png?v=2"}`);
    expect(filenames).toEqual(["logo.png"]);
  });

  it("never half-rewrites a URL whose origin it cannot read", () => {
    expect(bundleMediaRefs("![](//h/api/media/a.png)").content).toBe(`![](${MEDIA_BUNDLE_PREFIX}/a.png)`);
    expect(bundleMediaRefs("![](https://u@h/api/media/a.png)").content).toBe(`![](${MEDIA_BUNDLE_PREFIX}/a.png)`);
    const sub = bundleMediaRefs("![](https://h/sub/api/media/a.png)");
    expect(sub).toEqual({ content: "![](https://h/sub/api/media/a.png)", filenames: [] });
  });

  it("leaves content with no media references untouched", () => {
    const site = '{"title":"No media here"}';
    const { content, filenames } = bundleMediaRefs(site);
    expect(content).toBe(site);
    expect(filenames).toEqual([]);
  });
});
