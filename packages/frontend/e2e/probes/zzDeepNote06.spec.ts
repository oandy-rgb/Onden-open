// Feature-audit deepening (2026-10-08): NOTE-06 — Quick capture (phone bottom
// bar) online vs offline with the same "#word @tomorrow" line, a lost POST
// response then retry (same client id → no second note), and a capture whose
// @date task is refused (partial field failure). Since T10 (2026-10-16) the
// #word stays in the title/body as typed and no tag is applied (tags: 0),
// online and offline alike.
import { test, type Page } from "@playwright/test";
import { ready, openQuickCaptureByHotkey, BASE, H } from "../fullstack/helpers";


test("NOTE-06: capture online/offline, lost response retry, refused task", async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const tagName = `cap${stamp}`;
  await p.request.post("/api/tags/import", { ...H, data: { name: tagName, fields: [] } });
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const find = async (needle: string) => {
    const nodes = ((await (await p.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title.includes(needle));
    return Promise.all(nodes.map(async (n) => {
      const full = await (await p.request.get(`/api/nodes/${n.id}`)).json();
      const attrs = await (await p.request.get(`/api/nodes/${n.id}/attributes`)).json().catch(() => []);
      return { title: full.title, md: full.markdown, tags: (full.class_tag_ids ?? full.tag_ids ?? []).length, parent: full.parent_id ? "yes" : "no", due: (Array.isArray(attrs) ? attrs : attrs.attributes ?? []).find((a: { key: string }) => a.key === "due_date")?.value ?? null };
    }));
  };
  const capture = async (pg: Page, line: string) => {
    await openQuickCaptureByHotkey(pg);
    const ta = pg.locator(".quick-capture-textarea");
    await ta.waitFor({ timeout: 10_000 });
    await ta.fill(line);
    await ta.press("Control+Enter");
    await pg.waitForTimeout(2500);
    return { sheetOpen: await ta.isVisible().catch(() => false), kept: await ta.inputValue().catch(() => null), toast: (await pg.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 160) };
  };
  try {
  await ready(p, "/?view=notes");
  out.online = { ui: await capture(p, `OnCap ${stamp} #${tagName} @tomorrow\nsecond line`), server: await find(`OnCap ${stamp}`), expectDue: tomorrow };

  await p.waitForTimeout(1500);
  await ctx.setOffline(true);
  await p.waitForTimeout(800);
  out.offlineUi = await capture(p, `OffCap ${stamp} #${tagName} @tomorrow\nsecond line`);
  await ctx.setOffline(false);
  await p.waitForTimeout(10_000);
  out.offlineServer = await find(`OffCap ${stamp}`);

  // Lost response on the note POST, then the user retries.
  let lost = false;
  await p.route("**/api/nodes", async (r) => {
    if (r.request().method() !== "POST" || lost || !(r.request().postData() ?? "").includes(`LostCap ${stamp}`)) return r.continue();
    lost = true; await r.fetch(); return r.abort("connectionreset");
  });
  out.lostUi = await capture(p, `LostCap ${stamp}`);
  if (out.lostUi && (out.lostUi as { sheetOpen: boolean }).sheetOpen) {
    await p.locator(".quick-capture-textarea").press("Control+Enter");
    await p.waitForTimeout(2500);
  }
  await p.unroute("**/api/nodes");
  out.lostServer = (await find(`LostCap ${stamp}`)).length;

  // The @date task refused (403) after the note is created.
  await p.route("**/api/nodes/*/tasks", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  out.taskRefusedUi = await capture(p, `TaskRef ${stamp} #${tagName} @tomorrow`);
  await p.unroute("**/api/nodes/*/tasks");
  out.taskRefusedServer = await find(`TaskRef ${stamp}`);

  // Note POST refused (403): input kept, nothing created.
  await p.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  out.noteRefusedUi = await capture(p, `NoteRef ${stamp}`);
  await p.unroute("**/api/nodes");
  out.noteRefusedServer = (await find(`NoteRef ${stamp}`)).length;
  } finally {
    await ctx.setOffline(false).catch(() => {});
    console.log("NOTE06 " + JSON.stringify(out, null, 2));
    await ctx.close();
  }
});
