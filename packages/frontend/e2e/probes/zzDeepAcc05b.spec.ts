// Feature-audit deepening (2026-10-09, tick 48): ACC-05 — local DB worker not
// ready yet. A brand-new account; the SQLite wasm (/sql.js/*) is delayed 8 s;
// the user picks browser storage at once and types in today's note before
// the worker is up. Is the text kept (server, reload), and what is shown?
import { test } from "@playwright/test";
import { BASE, H, pendingCount } from "../fullstack/helpers";


test("ACC-05: worker not ready when the user starts writing", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now();
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 140))); p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 140)); });
  const su = await (await p.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Acc05w ${s}`, email: `acc05w-${s}@example.com`, password: `pw-${s}-x` } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `Acc05w ${s}`, type: "human", external_id: su.user.id } });
  const actor = ((await (await page.request.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Acc05w ${s}`)!;
  let wasmHits = 0;
  const delay = Number(process.env.WASM_DELAY ?? 8000);
  await ctx.route("**/sql.js/**", async (r) => { wasmHits++; await new Promise((x) => setTimeout(x, delay)); await r.continue(); });
  out.delay = delay;
  try {
    const t0 = Date.now();
    await p.goto(`${BASE}/?view=notes`);
    const choose = p.getByRole("button", { name: /Use browser storage/ });
    await choose.waitFor({ timeout: 60_000 });
    await choose.click();
    const ed = p.locator(".cm-content").first();
    await ed.waitFor({ timeout: 60_000 }).catch(() => {});
    out.editorReadyMs = Date.now() - t0;
    await ed.click({ force: true }).catch(() => {});
    await p.keyboard.type(` early-${s}`);
    out.typedAtMs = Date.now() - t0;
    out.atTypeTime = await p.evaluate(() => ({ gate: !!document.querySelector(".membership-gate"), inert: !!document.querySelector("[inert]"), focusedEditor: !!document.activeElement?.closest(".cm-content"), contentEditable: document.querySelector(".cm-content")?.getAttribute("contenteditable") }));
    out.textShownRightAway = (await ed.innerText().catch(() => "")).includes(`early-${s}`);
    await p.waitForTimeout(15_000);
    out.wasmHits = wasmHits;
    const title = await p.locator(".obsidian-title-input").first().inputValue().catch(() => null);
    out.afterWait = { title, editorHas: (await ed.innerText().catch(() => "")).includes(`early-${s}`), toasts: await p.locator(".toast-message").allInnerTexts(), pending: String(await pendingCount(p)) };
    const serverHit = async () => (await (await p.request.get(`/api/nodes/search?q=early-${s}`)).text()).includes(`early-${s}`);
    out.serverHas = await serverHit();
    await p.reload(); await p.waitForTimeout(15_000);
    out.afterReload = { editorHas: (await p.locator(".cm-content").first().innerText().catch(() => "")).includes(`early-${s}`), serverHas: await serverHit(), recovery: (await p.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).length };
    out.errors = [...new Set(errs)].slice(0, 6);
  } finally {
    await ctx.close();
    await page.request.delete(`/api/actors/${actor.id}`, H).catch(() => {});
    console.log("ACC05W " + JSON.stringify(out, null, 2));
  }
});
