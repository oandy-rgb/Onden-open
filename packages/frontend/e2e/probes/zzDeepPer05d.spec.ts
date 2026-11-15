// Feature-audit deepening (2026-10-09, tick 50): PER-05 — how long until a tag
// applied / removed elsewhere shows in an open note's tag chips (the row under
// the title, scoped so the sidebar tag list can't match; the inspector no
// longer lists tags, one tag row under the title does).
import { test } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("PER-05: remote tag apply/remove reaches an open note", async ({ page }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `P05d ${s}`, markdown: "x" } })).json();
  const tag = (await (await req.post("/api/tags/resolve-path", { ...H, data: { path: `p05d${s}` } })).json()).leaf_id as string;
  const chip = async () => (await page.locator(".note-document .title-tag-row .prop-tag-name").filter({ hasText: `p05d${s}` }).count()) > 0;
  const until = async (want: boolean) => { const t0 = Date.now(); for (let i = 0; i < 60; i++) { if ((await chip()) === want) return Date.now() - t0; await page.waitForTimeout(500); } return null; };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    out.before = await chip();
    const runs: Array<{ applyMs: number | null; removeMs: number | null }> = [];
    for (let k = 0; k < 3; k++) {
      await req.put(`/api/nodes/${note.id}/tags/${tag}`, H); const applyMs = await until(true);
      await req.delete(`/api/nodes/${note.id}/tags/${tag}`, H); const removeMs = await until(false);
      runs.push({ applyMs, removeMs });
    }
    out.runs = runs;
  } finally {
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    await req.delete(`/api/nodes/${tag}`, H).catch(() => {});
    console.log("PER05D " + JSON.stringify(out));
  }
});
