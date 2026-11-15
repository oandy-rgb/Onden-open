// Feature-audit deepening (2026-10-09, tick 26): PER-05 — two devices,
// properties and tags.
// 1. B changes property k1 (accepted); A changes k2 but the server refuses
//    (403). A must revert only k2 — not B's k1 — and say so; server keeps k1=B, k2=old.
// 2. Tag applied / removed elsewhere: how long until B's open note shows it.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


async function open(p: Page, id: string) {
  await ready(p, `/?view=notes&node=${id}`);
  await p.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const panel = p.locator(".attr-panel");
  await p.waitForTimeout(500);
}
const rowEl = (p: Page, k: string) => p.locator(".attr-panel .attr-row", { has: p.locator(".attr-key", { hasText: new RegExp(`\\b${k}$`) }) }).first();
// Read: the open input's value when editing, else the shown value.
const read = async (p: Page, k: string) => { const r = rowEl(p, k); if (await r.locator("input.attr-input--value").count()) return `editing:${await r.locator("input.attr-input--value").inputValue()}`; return (await r.locator(".attr-value").innerText().catch(() => "?")).trim(); };
const edit = async (p: Page, k: string, v: string) => { const r = rowEl(p, k); await r.locator(".attr-value--clickable").click(); const i = r.locator("input.attr-input--value"); await i.fill(v); await i.press("Enter"); };
const row = (p: Page, k: string) => ({ inputValue: () => read(p, k), fill: (v: string) => edit(p, k, v), press: async () => {} });

test("PER-05: refused property reverts only itself; tag display delay", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `P05b ${s}`, markdown: "body" } })).json();
  for (const [k, v] of [["k1", "a0"], ["k2", "b0"]]) await req.put(`/api/nodes/${note.id}/attributes/${k}`, { ...H, data: { value: v, value_type: "text" } });
  const tag = (await (await req.post("/api/tags/resolve-path", { ...H, data: { path: `p05b${s}` } })).json()).leaf_id as string;
  const server = async () => Object.fromEntries(((await (await req.get(`/api/nodes/${note.id}/attributes`)).json()) as Array<{ key: string; value: string }>).map((a) => [a.key, a.value]));
  const ctxB = await browser.newContext({ baseURL: BASE, storageState: test.info().project.use.storageState as string, viewport: { width: 1280, height: 800 } });
  const pb = await ctxB.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, note.id); await open(pb, note.id);
    out.panelVisible = { A: await page.locator(".attr-panel").isVisible(), B: await pb.locator(".attr-panel").isVisible(), A_k2: await row(page, "k2").inputValue().catch(() => null) };
    // 1. B: k1 → b1 (accepted)
    await row(pb, "k1").fill("b1"); await row(pb, "k1").press("Enter"); await pb.waitForTimeout(2500);
    out.afterB = { server: await server(), A_k1_seen: await row(page, "k1").inputValue().catch(() => null) };
    // A: k2 → a2, refused
    await page.route(`**/api/nodes/${note.id}/attributes/k2`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: "{\"error\":\"forbidden\"}" }) : r.continue());
    await row(page, "k2").fill("a2"); await row(page, "k2").press("Enter"); await page.waitForTimeout(3000);
    out.afterRefusal = {
      server: await server(),
      A_k1: await row(page, "k1").inputValue().catch(() => null),
      A_k2: await row(page, "k2").inputValue().catch(() => null),
      toasts: await page.locator(".toast-message").allInnerTexts(),
      recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 200)),
      B_k2: await row(pb, "k2").inputValue().catch(() => null),
    };
    await page.unroute(`**/api/nodes/${note.id}/attributes/k2`);
    await page.reload(); await open(page, note.id);
    out.afterReloadA = { k1: await row(page, "k1").inputValue().catch(() => null), k2: await row(page, "k2").inputValue().catch(() => null) };

    // 2. Tag applied elsewhere → B's chip
    // Scope to the note itself (editor column + Note info), not the sidebar tag list.
    const chip = async () => (await pb.locator("main, .overview-editor, .ov-panel, .obsidian-editor-wrap, [class*=inspector]").filter({ hasText: `p05b${s}` }).count()) > 0 ? 1 : 0;
    out.chipBefore = await chip();
    const t0 = Date.now();
    await req.put(`/api/nodes/${note.id}/tags/${tag}`, H);
    let appliedMs: number | null = null;
    for (let i = 0; i < 40; i++) { if (await chip()) { appliedMs = Date.now() - t0; break; } await pb.waitForTimeout(500); }
    const t1 = Date.now();
    await req.delete(`/api/nodes/${note.id}/tags/${tag}`, H);
    let removedMs: number | null = null;
    for (let i = 0; i < 40; i++) { if (!(await chip())) { removedMs = Date.now() - t1; break; } await pb.waitForTimeout(500); }
    out.tagDelay = { appliedMs, removedMs, limitMs: 20_000 };
    // And a property changed elsewhere: does B's input update?
    const t2 = Date.now();
    await req.put(`/api/nodes/${note.id}/attributes/k1`, { ...H, data: { value: "remote", value_type: "text" } });
    let propMs: number | null = null;
    for (let i = 0; i < 90; i++) { if ((await row(pb, "k1").inputValue().catch(() => "")) === "remote") { propMs = Date.now() - t2; break; } await pb.waitForTimeout(500); }
    out.propertyDelayB = propMs;
    out.headerLineB = (await pb.locator("text=/k1:/").first().locator("xpath=..").innerText().catch(() => null))?.replace(/\s+/g, " ").slice(0, 60);
    out.bodyEventReachesB = await (async () => { await req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: `P05b ${s} renamed` } }); for (let i = 0; i < 30; i++) { if ((await pb.locator(".obsidian-title-input").inputValue().catch(() => "")).includes("renamed")) return i * 500; await pb.waitForTimeout(500); } return null; })();
  } finally {
    await ctxB.close();
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    await req.delete(`/api/nodes/${tag}`, H).catch(() => {});
    console.log("PER05B " + JSON.stringify(out, null, 2));
  }
});
