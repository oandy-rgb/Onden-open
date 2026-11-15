// Feature-audit deepening (2026-10-08): FIND-02 — the visible set across
// search, saved queries, suggested links, palette/sidebar search and direct
// read, for a second human (editor): in an owner-only space, trashed, hidden (inbox)
// and normal notes sharing one keyword; then revoke the normal note while the
// editor's page is open (cached results).
import { test } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H, PAGE } from "../fullstack/helpers";


test("FIND-02: search / query / suggestions / direct read agree", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const kw = `zqk${stamp}`;
  const out: Record<string, unknown> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `f02t${stamp}`, fields: [] } })).json();
  // Default space so the second human can read them, unless hidden below.
  const shared = await defaultSpaceId(page.request);
  const mk = async (name: string) => { const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `F02 ${name} ${stamp}`, markdown: `${kw} body of ${name}`, space_id: shared } })).json(); await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} }); return n.id as string; };
  const ids = { normal: await mk("Normal"), secret: await mk("Secret"), trashed: await mk("Trashed"), hidden: await mk("Hidden"), revoked: await mk("Revoked") };
  await hideFromOthers(page.request, ids.secret);
  await page.request.delete(`/api/nodes/${ids.trashed}`, { headers: PAGE });
  await page.request.patch(`/api/nodes/${ids.hidden}`, { ...H, data: { hidden: true } });
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `F02 ${stamp}`, email: `f02-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `F02 ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const names = (arr: Array<{ title?: string }>) => arr.map((r) => (r.title ?? "").replace(`F02 `, "").replace(` ${stamp}`, "")).sort();
  const surfaces = async (req: typeof page.request) => {
    const s = await (await req.get(`/api/nodes/search?q=${kw}`)).json();
    const q = await (await req.post("/api/query", { ...H, data: { tags: [`f02t${stamp}`] } })).json();
    const sug = await req.post(`/api/nodes/${ids.normal}/suggested-links`, { ...H, data: {} });
    const sugJ = await sug.json().catch(() => null);
    const boot = await (await req.get("/api/bootstrap?slim=1")).json();
    const direct: Record<string, number> = {};
    for (const [k, id] of Object.entries(ids)) direct[k] = (await req.get(`/api/nodes/${id}`)).status();
    return { search: names(Array.isArray(s) ? s : s.results ?? []), query: names(q.rows ?? []), suggestStatus: sug.status(), suggest: JSON.stringify(sugJ ?? "").match(/F02 (\w+)/g)?.map((x) => x.slice(4)) ?? [], bootstrap: names((boot.nodes as Array<{ title: string }>).filter((n) => n.title.includes(String(stamp)) && n.title.startsWith("F02"))), direct };
  };
  out.owner = await surfaces(page.request);
  out.editor = await surfaces(human.request);
  // Editor UI: palette search, then revoke while the page stays open.
  const hp = await human.newPage();
  await ready(hp, "/?view=notes"); await hp.waitForTimeout(2000);
  const palette = async () => { await hp.keyboard.press("Escape"); await hp.keyboard.press("Control+k"); await hp.locator(".palette-input-wrap input").fill(kw); await hp.waitForTimeout(1500); return (await hp.locator(".palette-item, [role=option]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).filter((t) => t.includes(String(stamp))).map((t) => t.match(/F02 (\w+)/)?.[1]); };
  out.editorPalette = await palette();
  await hideFromOthers(page.request, ids.revoked);
  await hp.waitForTimeout(4000);
  out.editorPaletteAfterRevoke = await palette();
  const revokedRow = hp.locator(".palette-item, [role=option]", { hasText: `F02 Revoked ${stamp}` }).first();
  if (await revokedRow.count()) { await revokedRow.click(); await hp.waitForTimeout(1500); out.openRevoked = { url: hp.url().replace(BASE, "").slice(0, 40), body: (await hp.locator(".cm-content").first().innerText().catch(() => "")).slice(0, 40) }; }
  out.editorAfterRevoke = (await surfaces(human.request)).search;
  await human.close();
  console.log("FIND02 " + JSON.stringify(out, null, 2));
});
