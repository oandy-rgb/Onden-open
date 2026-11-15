// Diagnose note-open latency in a large workspace: does the stored body show
// before the server read returns, and where does the time go?
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
test("open trace", async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(8000); // let the background download finish
  const ids: string[] = await page.evaluate(async () => (await (await fetch("/api/bootstrap?bodies=none", { credentials: "include" })).json()).nodes.filter((n: { node_type: string; body_len?: number }) => n.node_type === "content" && (n.body_len ?? 0) > 0).slice(300, 306).map((n: { id: string }) => n.id));
  const bodies: Record<string, string> = {};
  const titles: Record<string, string> = {};
  for (const id of ids) { const n = await (await page.request.get(`/api/nodes/${id}`)).json(); bodies[id] = (n.markdown as string).replace(/\s+/g, " ").trim(); titles[id] = n.title; }
  console.log("SAMPLE " + JSON.stringify(ids.map((id) => [titles[id], bodies[id].slice(0, 30)])));
  const lines: string[] = [];
  for (const id of ids) {
    const ev: string[] = []; const s = Date.now();
    const onReq = (r: { url(): string }) => { if (r.url().endsWith(`/api/nodes/${id}`)) ev.push(`req@${Date.now() - s}`); };
    const onRes = (r: { url(): string }) => { if (r.url().endsWith(`/api/nodes/${id}`)) ev.push(`res@${Date.now() - s}`); };
    page.on("request", onReq); page.on("response", onRes);
    const shown = await page.evaluate(async ([nid, want]: readonly [string, readonly [string, string]]) => {
      const t0 = performance.now();
      history.pushState(null, "", `/?view=notes&node=${nid}`); window.dispatchEvent(new PopStateEvent("popstate"));
      return await new Promise<number>((resolve) => {
        const tick = () => { const ed = document.querySelector(".cm-content"); const ti = document.querySelector<HTMLInputElement>(".obsidian-title-input"); if (ed && ti && ti.value === want[0] && (ed.textContent ?? "").replace(/\s+/g, " ").trim() === want[1]) resolve(Math.round(performance.now() - t0)); else if (performance.now() - t0 > 10000) resolve(-1); else requestAnimationFrame(tick); };
        tick();
      });
    }, [id, [titles[id], bodies[id]]] as const);
    await page.waitForTimeout(600);
    page.off("request", onReq); page.off("response", onRes);
    lines.push(`textShown@${shown}ms ${ev.join(" ")}`);
  }
  console.log("TRACE\n" + lines.join("\n"));
});
