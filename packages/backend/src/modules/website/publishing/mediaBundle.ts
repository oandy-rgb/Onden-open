// Make a published site self-contained (D96): collect every `/api/media/<id>`
// reference in the site's files and rewrite it to the bundled copy's relative
// path, `media/<id>` from the bundle root, then copy each referenced blob the
// site may show into the bundle under that same `media/` prefix. Without this
// the static host re-requests every figure, PDF and the logo from the origin
// (404 whenever it is down, private, or the site is hosted elsewhere).
//
// bundleSiteFiles is the ONE pass both static copies make — the GitHub Pages
// push (pagesPush.ts) and the zip export (GET /api/export-static) — inside
// buildStaticSite (staticSite.ts), over the copy's HTML pages, so they cannot diverge.

// References are found with the one media grammar (@onden/markdown
// mediaRefs.ts): an id is a single path segment that is never `.`/`..`, so a
// copy into media/<id> cannot escape the media dir; a reference behind an
// origin is rewritten whole. The pass itself is bundleMedia, the same one the
// vault export (services/exportZip.ts) makes each exported file with.
import { bundleMedia } from "@onden/markdown";
import { mediaFiles } from "../../../services/mediaFiles.js";
import { siteShowsMedia } from "./servedSite.js";
import type { BundleFile } from "./githubPages.js";

// Bundle-relative prefix the rewritten references point at, and where
// bundleSiteFiles writes the copied blobs. Relative (no leading slash) so it
// resolves correctly under a Pages project subpath.
export const MEDIA_BUNDLE_PREFIX = "media";

/** `files` (the static copy's HTML pages)
 *  with every media reference rewritten to its bundled copy, relative to the
 *  file (`media/<id>` at the root, `../../media/<id>` from
 *  `site/<slug>/index.html`), followed by the copied blobs at `media/<id>`.
 *  Only what /api/media would serve an anonymous visitor is copied
 *  (servedSite.siteShowsMedia, the gate the self-hosted site applies): a
 *  published note may embed a file owned by a private note, which the site
 *  refuses, and copying it would publish it. A missing blob is skipped, not
 *  fatal: a stale reference shouldn't block the whole site. Never pass
 *  a script or stylesheet here — only content, whose references are data. */
export async function bundleSiteFiles(files: readonly BundleFile[], workspaceId: string): Promise<BundleFile[]> {
  const ids = new Set<string>();
  const rewritten = files.map((file) => {
    if (typeof file.content !== "string") return file;
    const up = "../".repeat(file.path.split("/").length - 1);
    const { content, ids: found } = bundleMedia(file.content, (id) => `${up}${MEDIA_BUNDLE_PREFIX}/${id}`);
    for (const id of found) ids.add(id);
    return { ...file, content };
  });
  const media: BundleFile[] = [];
  for (const id of ids) {
    if (!(await siteShowsMedia(workspaceId, id))) continue;
    // No bytes (purged/external): skip, bundle the rest.
    const content = await mediaFiles().read(id);
    if (content) media.push({ path: `${MEDIA_BUNDLE_PREFIX}/${id}`, content });
  }
  return [...rewritten, ...media];
}
