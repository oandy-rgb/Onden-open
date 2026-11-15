// GAP-20 fix check: a fully offline cold start opens the last verified
// account's local copy; an offline edit is queued and sent once online.
import { test } from "@playwright/test";
import { ready, BASE, H, pendingCount } from "../fullstack/helpers";


test("GAP-20 offline cold start", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `OffCold ${s}`, markdown: "start" } })).json();
  try {
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    out.remembered = await page.evaluate(() => localStorage.getItem("onden_verified_account"));
    await page.close();
    await context.setOffline(true);
    const p = await context.newPage();
    const errs: string[] = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    await p.goto(`${BASE}/?view=notes&node=${note.id}`).catch((e) => { out.gotoErr = String(e).slice(0, 80); });
    await p.waitForTimeout(8000);
    out.offlineBody = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    out.offlineEditor = await p.locator(".cm-content").first().innerText().catch(() => null);
    out.lockScreen = await p.getByText("Unable to check your sign-in status").count();
    if (out.offlineEditor !== null) {
      await p.locator(".cm-content").first().click({ force: true }); await p.keyboard.press("Control+End"); await p.keyboard.type(` cold-${s}`);
      await p.waitForTimeout(4000);
      out.pending = String(await pendingCount(p));
    }
    const patches: string[] = []; p.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) patches.push(r.url()); });
    await context.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event("online")));
    await p.waitForTimeout(12_000);
    const md = (await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string;
    out.afterOnline = { serverHasEdit: md.includes(`cold-${s}`), occurrences: md.split(`cold-${s}`).length - 1, patches: patches.length, pending: String(await pendingCount(p)), lock: await p.getByText("Unable to check your sign-in status").count() };
    out.errors = errs;
  } finally {
    await context.setOffline(false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("GAP20 " + JSON.stringify(out, null, 2));
  }
});
