// Diagnose warm-reload latency in a large workspace: request timeline and
// when the gate lifts / the opened note's text appears.
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
test("reload trace", async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const id: string = await page.evaluate(async () => (await (await fetch("/api/bootstrap?bodies=none", { credentials: "include" })).json()).nodes.filter((n: { node_type: string; body_len?: number }) => n.node_type === "content" && (n.body_len ?? 0) > 0)[300].id);
  const title = (await (await page.request.get(`/api/nodes/${id}`)).json()).title as string;
  for (let round = 0; round < 2; round++) {
    const ev: string[] = []; let s = 0;
    const onReq = (r: { url(): string; method(): string }) => { if (/\/api\//.test(r.url())) ev.push(`${Date.now() - s} > ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "").replace(/[0-9a-f-]{36}/g, ":id").slice(0, 60)}`); };
    const onRes = (r: { url(): string; status(): number }) => { if (/\/api\//.test(r.url())) ev.push(`${Date.now() - s} < ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "").replace(/[0-9a-f-]{36}/g, ":id").slice(0, 60)}`); };
    page.on("request", onReq); page.on("response", onRes);
    s = Date.now();
    await page.goto(`/?view=notes&node=${id}`);
    ev.push(`${Date.now() - s} goto resolved (load)`);
    await page.waitForFunction((t) => document.querySelector<HTMLInputElement>(".obsidian-title-input")?.value === t, title, { timeout: 60_000 });
    ev.push(`${Date.now() - s} title shown`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
    ev.push(`${Date.now() - s} gate hidden`);
    await page.waitForTimeout(1500);
    page.off("request", onReq); page.off("response", onRes);
    console.log(`RELOAD${round}\n` + ev.sort((a, b) => parseInt(a) - parseInt(b)).join("\n"));
  }
});
