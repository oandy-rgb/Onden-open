// Feature-audit deepening (2026-10-08): REV-05 media permission — a second
// editor reviews an image card; the image must load for them while the card is
// readable, and both the card and its image must disappear once the note moves
// to a space B is not in. A card is a child, so it moves with its deck (children
// share their parent's space). Media referenced only from a hidden note is
// checked too.
import { test } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";

// Two distinct 1×1 PNGs (different pixel) so the uploads get different hashes.
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

test("REV-05e: review card media permission for a second editor", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const upload = async (name: string, buf: Buffer) => {
    const r = await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name, mimeType: "image/png", buffer: buf } } });
    return ((await r.json().catch(() => ({}))) as { url?: string }).url ?? "";
  };
  const urlA = await upload(`r05e-a-${stamp}.png`, PNG_A);
  const urlB = await upload(`r05e-b-${stamp}.png`, PNG_B);
  out.urls = [urlA, urlB];
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r05e${stamp}`, fields: [] } })).json();
  const space_id = await defaultSpaceId(req); // B must see root notes
  const mk = async (title: string, markdown: string, parent?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, ...(parent ? { parent_id: parent } : { space_id }) } })).json()).id as string;
  const deck = await mk(`R05e Deck ${stamp}`, "deck");
  const card = await mk(`R05e card ${stamp}`, `Image card\n\n![pic](${urlA})`, deck);
  const secret = await mk(`R05e secret ${stamp}`, `Secret image\n\n![s](${urlB})`);
  await Promise.all([req.put(`/api/nodes/${card}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, card)]);
  await hideFromOthers(req, secret);

  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await ctx.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R05E ${stamp}`, email: `r05e-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await req.post("/api/actors", { ...H, data: { name: `R05E ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(req, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const b = ctx.request;
  out.bMediaA = (await b.get(urlA)).status();
  out.bMediaSecret = (await b.get(urlB)).status();
  out.ownerMediaSecret = (await req.get(urlB)).status();
  out.bQueueBefore = ((await (await b.get(`/api/review/queue?root=${deck}`)).json()) as { cards?: unknown[] }).cards?.length ?? "?";

  const p = await ctx.newPage();
  await ready(p, `/?view=notes&node=${deck}`);
  await p.keyboard.press("Control+k");
  await p.locator(".palette-input-wrap input").fill(">Review cards");
  await p.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
  await p.locator(".review-reveal").waitFor({ timeout: 10_000 });
  await p.locator(".review-reveal").click();
  await p.waitForTimeout(1500);
  out.bUiImage = await p.locator(".review-card-body img").first().evaluate((i) => ({ ok: (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0 })).catch((e) => String(e).slice(0, 80));

  // Hide the card (with its deck) while B has it open.
  await hideFromOthers(req, deck);
  out.bMediaAAfter = (await b.get(urlA)).status();
  out.bQueueAfter = ((await (await b.get(`/api/review/queue?root=${deck}`)).json()) as { cards?: unknown[] }).cards?.length ?? "?";
  out.bGradeLocked = (await b.post(`/api/review/${card}/grade`, { ...H, data: { rating: 3 } })).status();
  // B grades from the still-open UI.
  await p.locator(".review-grades button").filter({ hasText: "Good" }).first().click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(2500);
  out.bUiAfterGrade = (await p.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  out.bToasts = (await p.locator(".toast, [role=status], [role=alert]").allInnerTexts().catch(() => [])).map((s) => s.slice(0, 120)).slice(0, 4);
  await p.reload();
  await p.waitForTimeout(3000);
  out.bUiAfterReload = (await p.locator(".review-panel").innerText().catch(() => "(no panel)")).replace(/\s+/g, " ").slice(0, 220);
  await ctx.close();
  console.log("REV05E " + JSON.stringify(out, null, 2));
});
