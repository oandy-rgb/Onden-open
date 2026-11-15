import { attachmentHeaders } from "../../downloadHeaders.js";
import { Hono } from "hono";
import { z } from "zod";
import { DIAGRAM_LIMITS } from "@onden/markdown";
import archiver from "archiver";
import { getWorkspaceId, withTransaction } from "../../db.js";
import { getDiff } from "../../git.js";
import type { ActorCtx } from "../../types.js";
import { requireActor, mutate } from "../../spine/mutate.js";
import { withIdempotencyClaim } from "../../spine/idempotency.js";

// Routes only — the publishing machinery lives behind modules/website/publishing/'s
// one entry (index.ts).
import {
  ensureSiteBundle,
  readSearchIndexFile,
  storedSiteBundle,
  StaticSiteUnavailable,
  buildAndEnqueueSnapshot,
  warmHandwritingPages,
  listSnapshots,
  buildPublishPreview,
  leftOutNotes,
  loadServedSite,
  servedSiteVersion,
  publishedUrlFor,
  noteSiteState,
} from "./publishing/index.js";
import { assertAuthority } from "../../spine/authority.js";
import { setNodeAttribute } from "../../services/attributeWrites.js";
import { AttributeWriteError } from "../../services/attributeChange.js";
import { keepSubtreeOffSite } from "../../services/siteDefault.js";
import { PUBLISHED_KEY } from "../../services/systemAttributes.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { parseBody, uuidParam } from "../../routes/params.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

/** The site's back office (publishing, snapshots, the static
 *  export, backup diffs) is the workspace owner's: the current actor must be
 *  the principal admin (spine/authority.ts), so a delegated admin-role token
 *  or another member gets 403. Returns the current actor. */
async function siteAdmin(identity: ActorCtx | null, workspaceId: string): Promise<ActorCtx> {
  const current = await resolveCurrentActor(requireActor(identity), workspaceId);
  await assertAuthority(current, { kind: "principal_admin" });
  return current;
}

router.post("/preview", async (c) => {
  const workspaceId = await getWorkspaceId();
  await mutate({
    actor: requireActor(c.get("actor")), workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "PREVIEW_GENERATED", targetType: "workspace", targetId: workspaceId, payload: {} },
    apply: async () => {},
  });
  return c.json({ url: "/preview", generated_at: new Date().toISOString() });
});

const publishInput = z.object({
  title: z.string().min(1).default("Onden Site"),
  home_node_id: z.string().uuid().optional(),
  // Still accepted so an old client does not fail, but the design is never
  // read from here: it is the saved one (snapshot.ts buildCandidate).
  presentation: z.record(z.string(), z.unknown()).optional(),
  side_effects: z.record(z.string(), z.unknown()).optional(),
  // Layouts of the notes' mermaid blocks made in the publisher's browser. Only
  // their envelope is checked here; each layout is checked against its block
  // in publishing/diagrams.ts, and one that fails is left out, never stored.
  diagrams: z.array(z.object({
    source: z.string().max(DIAGRAM_LIMITS.sourceChars),
    layout: z.unknown(),
  })).max(DIAGRAM_LIMITS.perPublish).optional(),
});

// W38b: the candidate a publish with the same body would store, with its diff
// against the live site, private links, blocked media and hash. Read-only;
// the same owner-only gate as publishing.
router.post("/publish/preview", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = await siteAdmin(c.get("actor"), workspaceId);
  const input = await parseBody(c, publishInput, { optional: true });
  return c.json(await buildPublishPreview(workspaceId, {
    title: input.title,
    homeNodeId: input.home_node_id,
    presentation: input.presentation,
    sideEffects: input.side_effects,
    diagrams: input.diagrams,
    // Query blocks are evaluated as the publisher, as the publish will (D113).
    actor,
  }));
});

// The preview's 「一起發布」: opt the home page's unpublished notes in with one
// call. Each is the note's own publish switch (the `_published` attribute,
// the same write PUT /api/nodes/:id/attributes/_published does), so a note the
// owner may not publish (its space's publish switch is off) is reported in
// `failed` and the rest are still published. The site changes only at the next
// publish; this just makes the notes publishable.
router.post("/publish/include", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = await siteAdmin(c.get("actor"), workspaceId);
  const { noteIds } = await parseBody(c, z.object({ noteIds: z.array(z.string().uuid()).min(1).max(100) }), { optional: true });
  const published: string[] = [];
  const failed: Array<{ noteId: string; error: string }> = [];
  for (const noteId of new Set(noteIds)) {
    try {
      await setNodeAttribute({
        workspaceId, actor, nodeId: noteId,
        attribute: { key: PUBLISHED_KEY, value: "true", value_type: "text", is_inheritable: false },
      });
      published.push(noteId);
    } catch (error) {
      if (!(error instanceof AttributeWriteError)) throw error;
      failed.push({ noteId, error: error.code });
    }
  }
  return c.json({ published, failed });
});

// 「不發布這則」 → 「一起不發布」: the note and every live note under it are kept
// off the site in one action (services/siteDefault.ts keepSubtreeOffSite: one
// undo, each note under its own authority). Like the note's own 「不發布」 the
// takedown is immediate; "only this one" is the ordinary attribute write.
router.post("/publish/keep-off-subtree", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = await siteAdmin(c.get("actor"), workspaceId);
  const { noteId } = await parseBody(c, z.object({ noteId: z.string().uuid() }), { optional: true });
  const { marked, rootEventId } = await keepSubtreeOffSite(actor, workspaceId, noteId);
  return c.json({ marked, event_id: rootEventId });
});

router.post("/publish", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = await siteAdmin(c.get("actor"), workspaceId);
  const input = await parseBody(c, publishInput.extend({
    // From POST /publish/preview: publish only that candidate (else 409 preview_stale). Required: under the by-space
    // rule a publish puts every note of a publishing space on the site, so nothing is published that was not shown.
    // (republishSite, the unpublish-triggered re-deploy, adds nothing: it rebuilds from what is already out.)
    preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
  }), { optional: true });

  // What goes public is decided by space (publishing/publishedSet.ts), and only what the preview showed (preview_hash).
  // The snapshot build + durable pages-push enqueue is the shared core (also used by
  // the unpublish-triggered re-deploy).
  // The request's Idempotency-Key is claimed in the snapshot's transaction, as
  // mutate() claims it for other writes: a retry after a lost response answers
  // {deduped:true} instead of storing and pushing a second snapshot.
  const snapshotOpts = {
    title: input.title,
    homeNodeId: input.home_node_id,
    presentation: input.presentation,
    sideEffects: input.side_effects,
    diagrams: input.diagrams,
  };
  // Handwriting pages are drawn here, before the transaction, not inside it
  // (a preview before this publish has drawn them already).
  await warmHandwritingPages(workspaceId, actor, snapshotOpts);
  const created = await withIdempotencyClaim(workspaceId, (claim) => withTransaction(async () => {
    await claim();
    return buildAndEnqueueSnapshot(workspaceId, actor, { ...snapshotOpts, expectedHash: input.preview_hash });
  }));
  // Marked notes this snapshot leaves out: a publish that is "successful" but
  // empty must say why (same list as the preview).
  return c.json({ snapshot: created, url: created.artifact_ref, queued: true, left_out: await leftOutNotes(workspaceId, actor) }, 201);
});

router.get("/git/diff/:hash", async (c) => {
  // `git show <hash>` returns full backup-commit markdown (every note body,
  // incl. read-restricted ones) with no per-node filtering possible at the git
  // layer — so any authenticated actor could reconstruct gated notes. Admin-only.
  // Reject bearer tokens too — a backup-diff dump is exactly what a delegated
  // agent must never reach. The live app's index.ts already confines tokens to
  // /api/mcp; this is defence in depth on the highest-risk dump endpoint.
  await siteAdmin(c.get("actor"), await getWorkspaceId());
  const hash = c.req.param("hash");
  const diff = await getDiff(hash).catch(() => "");
  return c.text(diff);
});

router.get("/snapshots", async (c) => {
  // Publish back-office metadata (titles, node counts, artifact refs) — admin-only,
  // matching the other manage surfaces on this router.
  const workspaceId = await getWorkspaceId();
  await siteAdmin(c.get("actor"), workspaceId);
  return c.json(await listSnapshots(workspaceId));
});

router.get("/site", async (c) => {
  const workspaceId = await getWorkspaceId();
  // The latest snapshot minus takedowns (loadServedSite) — the SINGLE source
  // shared with the zip export and the static host push.
  const site = await loadServedSite(workspaceId);
  // The ETag is the served content's own version, so a takedown changes it and
  // no stale copy is ever confirmed. The SSR renderer sends it back and, on
  // 304, keeps its already-shaped copy instead of downloading and parsing the
  // whole site again for every page.
  const etag = `"${servedSiteVersion(site)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache"); // always ask; never reuse without asking
  if (ifNoneMatchHas(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json(site);
});

/** Whether an If-None-Match header lists `etag` (or is `*`); weak `W/` forms match. */
function ifNoneMatchHas(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => { const v = t.trim().replace(/^W\//, ""); return v === "*" || v === etag; });
}

// The live site's search: the files of the stored copy's Pagefind index
// (siteBundle.ts), the same ones the zip carries, so live and static search are
// one thing. The frontend proxies /site/search.idx/* here. The stored copy is
// looked up by the site as it is NOW, so a takedown stops its text being
// searchable at once, before the new copy exists. No copy yet: 404 (there is
// no index to read, and this path is public: no 5xx for a normal state) and one
// is started; the page hides its search box until it answers.
const SEARCH_INDEX_PREFIX = "/api/site/search.idx/";
router.get("/site/search.idx/*", async (c) => {
  const workspaceId = await getWorkspaceId();
  let name = c.req.path.slice(SEARCH_INDEX_PREFIX.length);
  try { name = decodeURIComponent(name); } catch { return c.json({ error: "not_found" }, 404); }
  const bundle = await storedSiteBundle({ workspaceId });
  if (!bundle) return c.json({ error: "site_search_building" }, 404);
  const file = await readSearchIndexFile(bundle, name);
  if (!file) return c.json({ error: "not_found" }, 404);
  // The files are named by their content or are tiny entry points; the browser
  // revalidates by the copy's key, so a new copy is picked up at the next search.
  const etag = `"${bundle.key}"`;
  const headers = { "Content-Type": file.type, "Cache-Control": "no-cache", ETag: etag };
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(file.bytes), { headers });
});

// A note's address on the published site, for the app's Copy link (D42):
// `/site/<served slug>`, read off the served snapshot by node id, or null when
// readers don't see the note there now. Signed-in only (index.ts gates every
// path but GET /api/site); the address is no secret — it is on the site.
router.get("/site/url/:nodeId", async (c) => {
  const nodeId = uuidParam(c, "nodeId");
  return c.json({ published_url: await publishedUrlFor(await getWorkspaceId(), nodeId) });
});

// Where one note stands on the site, for the note's Share menu (noteSiteState).
// Signed-in only, like the address above.
router.get("/site/status/:nodeId", async (c) => {
  const nodeId = uuidParam(c, "nodeId");
  return c.json({ state: await noteSiteState(await getWorkspaceId(), nodeId, c.get("actor")) });
});

router.get("/export-static", async (c) => {
  const workspaceId = await getWorkspaceId();
  // The whole site in one download: the owner's back office, like publishing.
  await siteAdmin(c.get("actor"), workspaceId);
  // The zip is the stored static copy (modules/website/publishing/siteBundle.ts): made
  // when the site was published or a takedown changed it, built here only if
  // none is stored yet (the first run after a deploy). Its pages are the ones
  // the live site serves, from the same served site — the latest snapshot minus
  // takedowns — so it can never show more than the site does. The GitHub Pages
  // push saves the same files.
  let bundle;
  try {
    bundle = await ensureSiteBundle({ workspaceId });
  } catch (e) {
    if (e instanceof StaticSiteUnavailable) return c.json({ error: "static_site_unavailable" }, 502);
    throw e;
  }

  const arc = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    arc.on("data", (chunk: Buffer) => chunks.push(chunk));
    arc.on("end", resolve);
    arc.on("error", reject);
    arc.directory(bundle.tree, false);
    void arc.finalize();
  });
  return new Response(Buffer.concat(chunks), {
    headers: {
      ...attachmentHeaders(`site-static-${Date.now()}.zip`, "application/zip"),
    },
  });
});

export default router;
