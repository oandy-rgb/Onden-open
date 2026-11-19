import { Hono } from "hono";
import { z } from "zod";
import { StatusError } from "../../statusError.js";
import { readJsonBody, uuidParam } from "../../routes/params.js";
import { getWorkspaceId } from "../../db.js";
import { mutatePersonal, requireActor } from "../../spine/mutate.js";
import { assertMayReachOut } from "../../spine/authority.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { drainOutbox } from "../../services/outbox.js";
import type { ActorCtx } from "../../types.js";
import { fetchPageHtml } from "./fetch.js";
import { getSource, assertSourceWritable, enqueueRssFetch, SOURCE_VOICES, SOURCE_DISPLAY_MODES } from "./sources.js";
import { feedUrl } from "./feedUrl.js";
import { subscribe, unsubscribe, updateSource, changeSource, importOpml, exportOpml, subscriptionList } from "./subscriptions.js";
import { parsePage } from "../../services/paging.js";
import { absolutizeUrls, extractArticleHtml, htmlToText } from "./sanitize.js";
import { markSeen, replaceStagingBody } from "./staging.js";
import { gateItem, type StagingRow } from "./items.js";
import { listStagedItems } from "./itemList.js";
import { saveItem } from "./save.js";
import { answerArticleLink } from "./links.js";
import { cleanKeyword, endMute, listMutes, muteKeyword, muteSource, MUTE_MAX_DAYS } from "./mutes.js";
import { changeSourceSpace, previewMovableSources, SourceSpaceError } from "./sourceSpace.js";

// RSS module routes — the reader/subscription surface.
//
// A SOURCE is a row of rss_subscriptions (sources.ts): a setting that lives in
// a space, not a note. An ARTICLE is a row in rss_staging — the inbound boundary buffer — and is NOT a node
// until the human saves it (POST /items/:id/save): the stream is triage (skim / save /
// skip — skippable, aged out by the retention sweep), the library is nodes.
// NODE_CREATED fires at the save, authored by the human; nothing about an
// unsaved article enters the event log or the governance queue.
//
// READ POLICY (iron law): sources are gated by the space rule
// (readableSpaceScopeSql / canReadSource); staging rows are gated THROUGH their
// source (an article is readable iff its subscription is) — every list below
// scopes rss_staging by readable source ids, every single-item read gates on
// the row's subscription_id. A restricted source's articles never leak.

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

// Continuation-style pages (the Google-Reader-API lineage default is 20).
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** First http(s) image in an article body: the list's thumbnail. */
export function firstImageUrl(html: string): string | null {
  const m = /<img\b[^>]*?\ssrc\s*=\s*["'](https?:\/\/[^"'\s]+)["']/i.exec(html ?? "");
  return m ? m[1]! : null;
}

const PLAYER_LINK = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch|embed)|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/\d)[^"'\s<>]*/i;

/** What plays in an article body, for the play button of a feed shown as 影音: a `<video>`/`<audio>` file
 *  ("video"/"audio", which plays in the list), or a YouTube/Vimeo player link ("embed": the reader's
 *  article shows that player, so the button opens the article). */
export function firstMedia(html: string): { kind: "video" | "audio" | "embed"; url: string } | null {
  const body = html ?? "";
  const file = /<(video|audio)\b[^>]*?\ssrc\s*=\s*["'](https?:\/\/[^"'\s]+)["']|<(video|audio)\b[^>]*>[\s\S]*?<source\b[^>]*?\ssrc\s*=\s*["'](https?:\/\/[^"'\s]+)["']/i.exec(body);
  if (file) return { kind: ((file[1] ?? file[3])!.toLowerCase()) as "video" | "audio", url: (file[2] ?? file[4])! };
  const player = PLAYER_LINK.exec(body);
  return player ? { kind: "embed", url: player[0] } : null;
}

function itemJson(row: StagingRow) {
  return {
    id: row.id,
    title: row.title,
    source_id: row.subscription_id,
    url: row.url,
    published_at: row.published_at,
    fetched_at: row.fetched_at,
    seen: row.seen,
    saved_node_id: row.saved_node_id,
    // For the reading list: a line of summary and a thumbnail.
    excerpt: htmlToText(row.body ?? "", 140),
    image: firstImageUrl(row.body ?? ""),
    media: firstMedia(row.body ?? ""),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// A save destination (存到): tags used like folders, and an optional parent
// NOTE (destination.ts checks it is a note, never a tag).
const destinationSchema = z.object({
  tag_ids: z.array(z.string().uuid()).max(20),
  parent_id: z.string().uuid().nullable(),
}).transform((d) => ({ tagIds: d.tag_ids, parentId: d.parent_id }));

const subscribeSchema = z.object({
  // http/https only (audit E3), normalised once (feedUrl.ts): feed:// becomes
  // https://; data:, javascript:, file: die at the boundary, not at fetch time.
  url: z.string().transform((u, ctx) => {
    const url = feedUrl(u);
    if (!url) ctx.addIssue({ code: "custom", message: "only http(s) URLs can be subscribed" });
    return url ?? z.NEVER;
  }),
  title: z.string().optional(),
  fetch_interval_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  auto_tag: z.string().min(1).max(64).optional(),
  embed: z.boolean().optional(),
  auto_dismiss_days: z.number().int().min(1).max(365).optional(),
  save_default: destinationSchema.optional(),
  voice: z.enum(SOURCE_VOICES).optional(),
});

// POST /api/rss/subscribe — validate the feed once inline, then create the
// source + first fetch intent (subscriptions.ts subscribe).
router.post("/subscribe", async (c) => {
  const input = subscribeSchema.parse(await readJsonBody(c, { optional: true }));
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const { status, body } = await subscribe(actor, workspaceId, {
    url: input.url,
    title: input.title,
    fetchIntervalMinutes: input.fetch_interval_minutes,
    autoTag: input.auto_tag,
    embed: input.embed,
    autoDismissDays: input.auto_dismiss_days,
    saveDefault: input.save_default,
    voice: input.voice,
  });
  return c.json(body, status);
});

// GET /api/rss/source-space/preview?space_id= — how many of the owner's
// subscriptions choosing that space for 訂閱放在 would move, and how many would
// stay because the space already follows the feed (owner only).
router.get("/source-space/preview", async (c) => {
  const spaceId = z.string().uuid().or(z.literal("")).parse(c.req.query("space_id") ?? "");
  try {
    return c.json(await previewMovableSources(c.get("actor"), await getWorkspaceId(), spaceId));
  } catch (error) {
    if (error instanceof SourceSpaceError) return c.json({ error: error.code }, error.status);
    throw error;
  }
});

// PUT /api/rss/source-space {space_id} — set 訂閱放在 ("" = each person's own
// space) and move the owner's subscriptions there, in one transaction (owner
// only; sourceSpace.ts changeSourceSpace).
router.put("/source-space", async (c) => {
  const input = z.object({ space_id: z.string().uuid().or(z.literal("")) }).strict().parse(await readJsonBody(c, { optional: true }));
  try {
    return c.json(await changeSourceSpace(c.get("actor"), await getWorkspaceId(), input.space_id));
  } catch (error) {
    if (error instanceof SourceSpaceError) return c.json({ error: error.code }, error.status);
    throw error;
  }
});

// PATCH /api/rss/sources/:id {save_default?, always_fulltext?} — a feed's
// settings: its own save default (a destination, or null to fall back) and
// 總是載入全文 (subscriptions.ts updateSource).
router.patch("/sources/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const input = z.object({ save_default: destinationSchema.nullable().optional(), always_fulltext: z.boolean().optional(), voice: z.enum(SOURCE_VOICES).optional(), display_mode: z.enum(SOURCE_DISPLAY_MODES).optional() })
    .parse(await readJsonBody(c, { optional: true }));
  const { status, body } = await updateSource(actor, workspaceId, uuidParam(c, "id"),
    { saveDefault: input.save_default, alwaysFulltext: input.always_fulltext, voice: input.voice, displayMode: input.display_mode });
  return c.json(body, status);
});

// POST /api/rss/sources/:id/refresh — re-file the fetch intent now. The fetch
// rewrites the source's feed state and stages its articles: that is an edit of
// the source, so a member who may only view it cannot start one.
router.post("/sources/:id/refresh", async (c) => {
  const id = uuidParam(c, "id");
  const workspaceId = await getWorkspaceId();
  let outboxId = "";
  const { status, body } = await changeSource(requireActor(c.get("actor")), workspaceId, id, async () => {
    outboxId = await enqueueRssFetch(workspaceId, id);
    return { status: 200, body: { queued: true } };
  });
  if (outboxId) void drainOutbox({ id: outboxId }).catch(() => null);
  return c.json(body, status);
});

// POST /api/rss/sources/:id/unsubscribe — 取消訂閱: the subscription is deleted
// with its stream; articles already saved are notes and stay
// (subscriptions.ts unsubscribe).
router.post("/sources/:id/unsubscribe", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const { status, body } = await unsubscribe(actor, workspaceId, uuidParam(c, "id"));
  return c.json(body, status);
});

// GET /api/rss/sources — subscription list + per-source UNSEEN counts, both
// read-policy bounded (subscriptions.ts subscriptionList).
router.get("/sources", async (c) => {
  const workspaceId = await getWorkspaceId();
  return c.json(await subscriptionList(c.get("actor"), workspaceId));
});

// GET /api/rss/items?source=&voice=person&cursor=&limit= — the reading list (no
// bodies; the reader fetches one article at a time). Continuation-paged:
// ordered by COALESCE(published_at, fetched_at) DESC, cursor = "<ts>~<id>" of
// the last row. IRON LAW: scoped to readable source ids in SQL.
router.get("/items", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = c.get("actor");
  const sourceParam = c.req.query("source")?.trim() || undefined;
  const voiceParam = c.req.query("voice")?.trim() === "person" ? "person" as const : undefined;
  // services/paging.ts: the one limit grammar (bad → 400). The page itself is
  // a keyset cursor, not an offset, so it keeps `next_cursor`.
  const { limit } = parsePage({ limit: c.req.query("limit") }, { default: PAGE_DEFAULT, max: PAGE_MAX });

  const list = await listStagedItems(actor, workspaceId, {
    sourceId: sourceParam, voice: voiceParam, limit, cursor: c.req.query("cursor")?.trim(),
  });
  if ("badCursor" in list) return c.json({ error: "bad cursor" }, 400);
  return c.json({ items: list.rows.map(itemJson), next_cursor: list.nextCursor });
});

// GET /api/rss/items/:id — one article, body included (the reader pane).
router.get("/items/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const gated = await gateItem(actor, workspaceId, id);
  if (!gated.ok) return c.json({ error: gated.error }, gated.status);
  // Articles stored before relative URLs were resolved at fetch still carry
  // them: resolve on the way out too.
  return c.json({ ...itemJson(gated.row), body: absolutizeUrls(gated.row.body ?? "", gated.row.url) });
});

// GET /api/rss/items/:id/link?url= — a link clicked inside this article: another article of the same source, held
// already or fetched once, to read in place; else the browser (links.ts). A read: nothing is stored.
router.get("/items/:id/link", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const gated = await gateItem(actor, workspaceId, uuidParam(c, "id"));
  if (!gated.ok) throw new StatusError(gated.status, gated.error);
  const url = c.req.query("url")?.trim();
  if (!url) throw new StatusError(400, "url is required");
  return c.json(await answerArticleLink(actor, workspaceId, gated.row.subscription_id, url));
});

// POST /api/rss/items/:id/seen {seen?} — mark seen (default) or unseen.
// Plain buffer state, deliberately NOT "read": skimming past is a non-event,
// not a debt — and not a domain event either (nothing about your knowledge
// changed). Non-destructive and reversible.
router.post("/items/:id/seen", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const gated = await gateItem(actor, workspaceId, id);
  if (!gated.ok) return c.json({ error: gated.error }, gated.status);
  const body = await readJsonBody(c, { optional: true });
  const seen = (body as { seen?: boolean }).seen !== false;
  await mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => markSeen([id], current.id, seen) });
  return c.json({ id, seen });
});

// GET /api/rss/mutes — the caller's active mutes (少看這種 / 靜音一週).
// POST /api/rss/mutes {keyword} | {source_id} [, days] — mute a title keyword or
// a whole feed for a while (a week by default). DELETE /api/rss/mutes/:id ends
// one early. Personal buffer state like /seen: only the caller's own list
// changes, nothing is deleted, no domain event (mutes.ts).
router.get("/mutes", async (c) => {
  const workspaceId = await getWorkspaceId();
  return c.json({ mutes: await listMutes(requireActor(c.get("actor")), workspaceId) });
});

router.post("/mutes", async (c) => {
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const input = z.object({
    keyword: z.string().optional(), source_id: z.string().uuid().optional(),
    days: z.number().int().min(1).max(MUTE_MAX_DAYS).optional(),
  }).refine((v) => (v.keyword === undefined) !== (v.source_id === undefined), { message: "send a keyword or a source_id" })
    .parse(await readJsonBody(c, { optional: true }));
  if (input.keyword !== undefined) {
    const keyword = cleanKeyword(input.keyword);
    if (!keyword) throw new StatusError(422, "bad keyword");
    return c.json({ id: await muteKeyword(actor, workspaceId, keyword, input.days) }, 201);
  }
  const id = await muteSource(actor, workspaceId, input.source_id!, input.days);
  if (!id) throw new StatusError(404, "source not found");
  return c.json({ id }, 201);
});

router.delete("/mutes/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  if (!(await endMute(requireActor(c.get("actor")), workspaceId, id))) throw new StatusError(404, "mute not found");
  return c.json({ id, ended: true });
});

// POST /api/rss/items/:id/save {node_id?, destination?} — THE moment an
// article becomes yours: one NODE_CREATED through the spine, authored by the
// CALLER (a human choosing, not a feed pretending to be an agent). The note
// lands at the chosen destination (tags + optional parent note), or at the
// source's save default when none is sent (destination.ts), and carries
// provenance attrs (_rss_guid/_rss_source/url/published_at). Tags go through
// attachTagInTx — a single human-initiated apply.
// Idempotent: an already-saved row returns its node; a client-minted node_id
// makes offline replays converge on one node.
router.post("/items/:id/save", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const input = z.object({ node_id: z.string().uuid().optional(), destination: destinationSchema.optional() })
    .parse(await readJsonBody(c, { optional: true }));
  const { status, body } = await saveItem(actor, workspaceId, id, input.node_id, input.destination);
  return c.json(body, status);
});

// POST /api/rss/items/:id/fulltext — 載入全文: one inline page fetch (user
// action, bookmark.ts posture), heuristic readability extraction, buffer body
// replaced in place. Buffer state — no event; if the article was already
// saved, the note owns the content now (edit the note instead).
router.post("/items/:id/fulltext", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  assertMayReachOut(actor); // the article's page is fetched below
  const gated = await gateItem(actor, workspaceId, id);
  if (!gated.ok) return c.json({ error: gated.error }, gated.status);
  if (gated.row.saved_node_id) return c.json({ error: "already saved as a note — load full text there" }, 409);
  // The staging body is shared by every reader of the feed: replacing it is an
  // edit of the source, not a per-reader preference.
  const source = await getSource(actor, workspaceId, gated.row.subscription_id);
  if (!source) return c.json({ error: "item not found" }, 404);
  await assertSourceWritable(await resolveCurrentActor(actor, workspaceId), source);
  const url = gated.row.url;
  if (!url) return c.json({ error: "article has no original URL" }, 409);

  let article: string;
  try {
    // The item's title and its current text steer the extractor: a heading that repeats the title goes, and the
    // result is never shorter than what the reader already has (sanitize.ts extractArticleHtml).
    article = extractArticleHtml(await fetchPageHtml(url), url, { title: gated.row.title, floorText: htmlToText(gated.row.body, Number.MAX_SAFE_INTEGER) });
  } catch (err) {
    return c.json({ error: `Failed to load the page: ${(err as Error).message}` }, 422);
  }
  if (!article.trim()) return c.json({ error: "could not extract an article from the page" }, 422);

  await replaceStagingBody(id, workspaceId, article);
  return c.json({ id, body: article });
});

// GET /api/rss/opml — export the (readable) subscription list.
router.get("/opml", async (c) => {
  const workspaceId = await getWorkspaceId();
  const xml = await exportOpml(c.get("actor"), workspaceId);
  return new Response(xml, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
});

// POST /api/rss/opml {opml} — import: a source per new feed, validated by
// its first fetch (subscriptions.ts importOpml).
router.post("/opml", async (c) => {
  const parsed = z.object({ opml: z.string().min(1) }).safeParse(await readJsonBody(c, { optional: true }));
  if (!parsed.success) return c.json({ error: "bad_request", detail: "send { opml: \"<xml…>\" }" }, 400);
  const workspaceId = await getWorkspaceId();
  const actor = requireActor(c.get("actor"));
  const { status, body } = await importOpml(actor, workspaceId, parsed.data.opml);
  return c.json(body, status);
});

export default router;
