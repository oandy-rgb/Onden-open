// Feature-audit deepening (2026-10-08): CAN-06 — card content on a board:
// inline edit saved on blur, a real server 403 for a second human on a
// write-restricted note, task checkboxes toggled from the card preview, a
// very tall card, an image drop whose upload fails, and web embeds for unsafe
// or odd URLs.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, createSpace, moveToSpace, seedLayout, addToDefaultSpace, BASE, H, PNG_1X1_B64 } from "../fullstack/helpers";

const PNG_B64 = PNG_1X1_B64; // a real image: the server decodes uploads

test("CAN-06: card content — edit, real 403, tasks, tall card, failed drop, embeds", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  // Everything lives in the default space so the second human can open the
  // board; CLock moves to a space where that human is only a viewer.
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, markdown: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, space_id: shared } })).json()).id as string;
  const body = async (id: string) => (await (await page.request.get(`/api/nodes/${id}`)).json()).markdown as string;
  try {
  const E = await mk(`CEdit ${stamp}`, "start");
  const L = await mk(`CLock ${stamp}`, "locked body");
  const T = await mk(`CTask ${stamp}`, "- [ ] one\n- [ ] two");
  const tall = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n\n");
  const TL = await mk(`CTall ${stamp}`, tall);
  const W1 = await mk(`CWebJs ${stamp}`, "javascript:alert(1)");
  const W2 = await mk(`CWebHttp ${stamp}`, "http://example.invalid/page");
  const W3 = await mk(`CWebData ${stamp}`, "data:text/html,<script>alert(1)</script>");
  const lockSpace = await createSpace(page.request, `c06w${stamp}`);
  await moveToSpace(page.request, L, lockSpace);
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C06Board ${stamp}` } })).json();
  await moveToSpace(page.request, cv.id, shared); // a new board starts in the creator's personal space
  const place = [E, L, T, TL, W1, W2, W3].map((id, i) => ({ nodeId: id, x: 40 + (i % 3) * 320, y: 40 + Math.floor(i / 3) * 320, width: 280 }));
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: place } } });
  const open = async (p: Page) => { await ready(p, `/?view=notes&node=${cv.id}`); await p.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await p.waitForTimeout(1000); };
  const ids: Record<string, string> = { CEdit: E, CLock: L, CTask: T, CTall: TL, CWebJs: W1, CWebHttp: W2, CWebData: W3 };
  const card = (p: Page, t: string) => p.locator(`.react-flow__node[data-id="${ids[t.split(" ")[0]]}"]`);
  await open(page);

  // Inline edit, saved on blur (click the pane).
  await card(page, `CEdit ${stamp}`).dblclick({ position: { x: 140, y: 40 }, timeout: 5_000 }).catch((e) => { out.dblclickErr = String(e).slice(0, 200); });
  await page.waitForTimeout(500);
  out.editing = String(await page.locator(".card-node--editing").count());
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" plus typed");
  await page.locator(".react-flow__pane").click({ position: { x: 600, y: 120 }, force: true });
  await page.waitForTimeout(2500);
  out.inlineEdit = JSON.stringify(await body(E));

  // Task checkbox toggled in the card preview.
  const box = card(page, `CTask ${stamp}`).locator("[role=checkbox], input[type=checkbox]").first();
  out.taskBoxes = String(await card(page, `CTask ${stamp}`).locator("[role=checkbox], input[type=checkbox]").count());
  await box.click().catch(() => {});
  await page.waitForTimeout(2500);
  out.taskToggle = JSON.stringify(await body(T));

  // Tall card: rendered height and whether the last line is reachable.
  const tallCard = card(page, `CTall ${stamp}`);
  const tb = await tallCard.boundingBox();
  out.overlap = JSON.stringify(await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".react-flow__node")) as HTMLElement[];
    const r = els.map((e) => ({ t: (e.textContent ?? "").slice(0, 20), b: e.getBoundingClientRect() }));
    const pairs: string[] = [];
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i].b, c = r[j].b; if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) pairs.push(`${r[i].t.trim()} × ${r[j].t.trim()}`); }
    return pairs;
  }));
  out.tallCard = JSON.stringify(await tallCard.evaluate((el) => {
    const sc = Array.from(el.querySelectorAll("*")).find((n) => (n as HTMLElement).scrollHeight > (n as HTMLElement).clientHeight + 20 && /auto|scroll/.test(getComputedStyle(n as HTMLElement).overflowY)) as HTMLElement | undefined;
    if (sc) sc.scrollTop = sc.scrollHeight;
    return { scroller: sc ? sc.className : null, scrollH: sc?.scrollHeight ?? null, clientH: sc?.clientHeight ?? null, lastVisible: (el.textContent ?? "").includes("line 200") };
  }).catch(() => null));
  out.tallBox = tb ? `${Math.round(tb.width)}x${Math.round(tb.height)}` : "none";
  await page.waitForTimeout(500);
  out.tallLastInView = String(await tallCard.getByText("line 200", { exact: true }).isVisible().catch(() => false));

  // Embeds.
  out.embeds = JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node")).filter((n) => /CWeb/.test(n.textContent ?? "")).map((n) => ({
    t: (n.querySelector(".card-node-header")?.textContent ?? "").trim().slice(0, 30),
    embed: !!n.querySelector(".card-node-webembed"), iframe: (n.querySelector("iframe") as HTMLIFrameElement | null)?.getAttribute("src") ?? null,
    sandbox: (n.querySelector("iframe") as HTMLIFrameElement | null)?.getAttribute("sandbox") ?? null,
    links: Array.from(n.querySelectorAll("a")).map((a) => a.getAttribute("href")),
  }))));

  // Image drop with a failing upload.
  const panel = page.locator(".graph-panel");
  const nodesBefore = ((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data.nodes as unknown[]).length;
  await page.route("**/api/media**", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await page.route("**/api/upload**", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  const dt = await page.evaluateHandle((b64) => { const bin = atob(b64); const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([arr], "fail.png", { type: "image/png" })); return dt; }, PNG_B64);
  await panel.dispatchEvent("drop", { dataTransfer: dt, clientX: 600, clientY: 700 });
  await page.waitForTimeout(3000);
  const after = (await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data.nodes as unknown[];
  out.failedDrop = JSON.stringify({ placedDelta: after.length - nodesBefore, brokenImgs: await page.locator(".card-node-image img").count(), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 160), orphanNote: ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string; created_at?: string }>).filter((n) => /fail/i.test(n.title)).length });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Second human (editor) on the write-restricted card: real 403.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C06 ${stamp}`, email: `c06-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const humanActor = await (await page.request.post("/api/actors", { ...H, data: { name: `C06 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, humanActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  await page.request.put(`/api/spaces/${lockSpace}/members/${humanActor.id}`, { ...H, data: { permission: "view" } });
  out.apiEditor403 = String((await human.request.patch(`/api/nodes/${L}`, { ...H, data: { markdown: "x" } })).status());
  const hp = await human.newPage();
  const statuses: number[] = [];
  hp.on("response", (r) => { if (r.request().method() === "PATCH" && r.url().includes(`/api/nodes/${L}`)) statuses.push(r.status()); });
  await open(hp);
  await card(hp, `CLock ${stamp}`).dblclick({ position: { x: 140, y: 40 }, timeout: 5_000 }).catch((e) => { out.hpDblclickErr = String(e).slice(0, 200); });
  await hp.waitForTimeout(500);
  await hp.keyboard.press("Control+End");
  await hp.keyboard.type(" editor tried");
  await hp.locator(".react-flow__pane").click({ position: { x: 600, y: 120 }, force: true });
  await hp.waitForTimeout(3000);
  out.uiEditor403 = JSON.stringify({
    statuses, server: await body(L),
    cardText: (await card(hp, `CLock ${stamp}`).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80),
    recovery: (await hp.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160),
    toast: (await hp.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 160),
  });
  await hp.reload(); await hp.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await hp.waitForTimeout(1500);
  out.editor403AfterReload = (await card(hp, `CLock ${stamp}`).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
  await human.close();
  } finally {
    console.log("CAN06 " + JSON.stringify(out, null, 2));
  }
});
