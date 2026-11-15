import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { extname } from "path";
import { MAX_MEDIA_REQUEST_BYTES, capMegabytes, isMediaId } from "@onden/markdown";
import { MIME, capFor } from "../services/mediaStore.js";
import { mediaFiles } from "../services/mediaFiles.js";
import { parseMediaRange } from "../services/mediaRange.js";
import { storeMedia } from "../services/media.js";
import { getWorkspaceId } from "../services/workspaceId.js";
import { canReadMedia } from "../services/mediaAccess.js";
import { canWriteSomewhere } from "../services/spaces.js";
import type { ActorCtx } from "../types.js";

/** Cache-Control for media an anonymous visitor may read: short-lived and
 *  revalidated, so a takedown applies within minutes (see the GET route). */
export const PUBLIC_MEDIA_CACHE = "public, max-age=300, must-revalidate";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

/** A refused upload: over its type's cap, or (no file read yet) over the
 *  request cap. `max_bytes` lets the app state the cap in its own words. */
export function fileTooLargeBody(maxBytes: number) {
  return { error: "file_too_large", detail: `file exceeds ${capMegabytes(maxBytes)} MB limit`, max_bytes: maxBytes };
}

// The request cap is nginx's for this route (docker/nginx/nginx.conf
// `location = /api/media`, the same constant); held here too so a request
// that reaches the backend another way is refused before parseBody, which
// reads the whole multipart body into memory.
router.post("/", bodyLimit({
  maxSize: MAX_MEDIA_REQUEST_BYTES,
  onError: (c) => c.json(fileTooLargeBody(MAX_MEDIA_REQUEST_BYTES), 413),
}), async (c) => {
  // Uploading is a content write — the same bar as creating a note: someone
  // who can write in some space (every member can, in their personal space).
  // Without a gate an actor with no writable space could put up to a 500MB
  // file on disk (unaudited, off-spine). Bearer tokens are already confined
  // to /api/mcp/*.
  const actor = c.get("actor");
  if (!actor || !(await canWriteSomewhere(actor))) {
    return c.json({ error: "forbidden", detail: "uploading media needs a space you can write in" }, 403);
  }
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return c.json({ error: "no file" }, 400);
  const ext = extname(file.name).toLowerCase();
  if (!MIME[ext]) return c.json({ error: "unsupported type" }, 400);

  // The per-type cap, checked before the arrayBuffer() copy. parseBody has
  // already buffered the body, bounded by the request cap above.
  const cap = capFor(ext);
  const tooLarge = () => c.json(fileTooLargeBody(cap), 413);
  if (((file as { size?: number }).size ?? 0) > cap) return tooLarge();

  // Validation, SVG sanitising, the WebP re-encode, the write and the
  // uploader record are storeMedia's (services/media.ts).
  // A storage that is full (the browser app's quota, a full disk) throws MediaStorageFull: nothing was kept, and the
  // shared boundary answers 507 insufficient_storage.
  const stored = await storeMedia(Buffer.from(await file.arrayBuffer()), ext, {
    actor, workspaceId: await getWorkspaceId(), origin: "upload",
  });
  if (!stored.ok) {
    if (stored.reason === "too_large") return tooLarge();
    return c.json({ error: stored.reason === "unsupported" ? "unsupported type" : "unreadable file" }, 400);
  }
  return c.json({ url: stored.url });
});

router.get("/:filename", async (c) => {
  // Only a media id (@onden/markdown isMediaId: one segment, never `.`/`..`
  // or a dot-file) names a file: an encoded `..` would otherwise reach
  // the media directory itself and 500, and storeMedia's `.store-*.tmp`
  // temporaries must never be served.
  const filename = c.req.param("filename");
  if (!isMediaId(filename)) return c.json({ error: "not found" }, 404);
  const stored = await mediaFiles().info(filename);
  if (!stored) return c.json({ error: "not found" }, 404);
  // Per-node read gate: this asset is owned by the nodes that embed it. If the
  // caller can't read any of them it's invisible — 404 (not 403), matching the
  // node read gate so a restricted asset's existence isn't disclosed. Unattached
  // assets and published-page assets stay readable (see canReadMedia).
  const workspaceId = await getWorkspaceId();
  const actor = c.get("actor");
  if (!(await canReadMedia(actor, filename, workspaceId))) {
    return c.json({ error: "not found" }, 404);
  }
  const mime = MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
  // Caching must not outlive the read gate above (GAP-232). A response an
  // anonymous visitor was allowed to get is public, but only for five minutes
  // before it must be revalidated: a takedown (un-publish, hide, trash — the
  // site is the latest snapshot minus takedowns, W38a) reaches browsers and
  // CDNs within that window instead of a year later. Anything an actor needed
  // to be signed in for is private (no shared proxy keeps it) and revalidated
  // on every use, so locking the embedding note hides the image from browsers
  // that already saw it. The ETag keeps revalidation cheap: the gate runs,
  // then a 304 skips re-sending the bytes.
  const st = { size: stored.size };
  const etag = `"${stored.size.toString(36)}-${Math.floor(stored.modifiedMs).toString(36)}"`;
  const cacheControl = actor ? "private, no-cache" : PUBLIC_MEDIA_CACHE;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    ETag: etag,
    // Players seek and resume with Range requests; without this a stalled
    // <audio>/<video> can only restart from the beginning.
    "Accept-Ranges": "bytes",
    // Media is served under the app origin — never let a browser re-sniff an
    // upload into a scriptable type.
    "X-Content-Type-Options": "nosniff",
  };
  if (mime === "image/svg+xml") {
    // Belt over sanitizeSvg()'s braces: the sanitizer is an allowlist rebuild, so
    // a parser-differential bypass is conceivable. CSP `sandbox` + no sources
    // means even a script that survives sanitization cannot execute or reach
    // the app origin when the SVG is opened as a top-level document. Inline
    // <img> rendering ignores CSP sandbox, so images keep working.
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  // The read gate above has passed; only now do bytes leave. An If-Range that
  // no longer names this version means the client's partial copy is stale, so
  // it gets the whole file instead of a mismatched slice.
  const ifRange = c.req.header("if-range");
  const range = ifRange !== undefined && ifRange !== etag
    ? { kind: "full" as const }
    : parseMediaRange(c.req.header("range"), st.size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${st.size}` } });
  }
  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : st.size - 1;
  headers["Content-Length"] = String(st.size === 0 ? 0 : end - start + 1);
  if (range.kind === "partial") headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  // HEAD: Hono runs this handler and drops the body without cancelling its
  // stream, so a stream opened here would leave the file open. Callers (the
  // feed's podcast enclosures, static builds) only want the size and type.
  if (c.req.method === "HEAD") return new Response(null, { status: range.kind === "partial" ? 206 : 200, headers });
  // Streamed, not read whole: a 500 MB video must not sit in memory.
  const body = st.size === 0 ? null : mediaFiles().open(filename, { start, end });
  return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
});

export default router;
