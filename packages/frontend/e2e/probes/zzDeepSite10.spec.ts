// Feature-audit deepening (2026-10-07): SITE-10 — static export opened offline:
// unzip, file:// browsing, asset paths, content completeness, private-link
// redaction, and snapshot-vs-live comparison.
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BASE, H, publishRequest } from "../fullstack/helpers";

// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

test("SITE-10: exported zip opens offline with intact links and assets", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const up = await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `img-${stamp}.png`, mimeType: "image/png", buffer: PNG } } });
  const media = await up.json().catch(() => ({}));
  const imgUrl = media.url as string | undefined;
  const mk = async (title: string, markdown: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()).id as string;
  const pub = async (id: string, on: boolean) => page.request.put(`/api/nodes/${id}/attributes/_published`, { ...H, data: { value: on ? "true" : "false" } });
  const priv = await mk(`ExpPrivate${stamp}`, `private-body-${stamp}`);
  const b = await mk(`ExpB${stamp}`, `b-body-${stamp}`);
  const a = await mk(`ExpA${stamp}`, `a-original-${stamp}\n\n[[ExpB${stamp}]] and [[ExpPrivate${stamp}]]\n\n${imgUrl ? `![img](${imgUrl})` : ""}`);
  await pub(a, true); await pub(b, true);
  const snap = await publishRequest(page.request, { title: `Exp ${stamp}`, home_node_id: a });
  // After the snapshot: edit A live, and unpublish B.
  await page.request.patch(`/api/nodes/${a}`, { ...H, data: { markdown: `a-edited-after-snapshot-${stamp}` } });
  await pub(b, false);
  void priv;

  const res = await page.request.get("/api/export-static");
  const dir = `/tmp/pw-output/site10-${stamp}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/site.zip`, await res.body());
  execSync(`cd ${dir} && python3 -m zipfile -e site.zip out`);
  const files = walk(`${dir}/out`).map((f) => f.slice(`${dir}/out/`.length));
  const all = files.map((f) => readFileSync(`${dir}/out/${f}`, "utf8")).join("\n");
  const out: Record<string, string> = {
    upload: `${up.status()} url=${imgUrl ?? "none"}`, snapshot: String(snap.status()),
    files: JSON.stringify(files.slice(0, 15)),
    containsOriginalA: String(all.includes(`a-original-${stamp}`)), containsEditedA: String(all.includes(`a-edited-after-snapshot-${stamp}`)),
    containsUnpublishedB: String(all.includes(`b-body-${stamp}`)), containsPrivate: String(all.includes(`private-body-${stamp}`) || all.includes(`ExpPrivate${stamp}`)),
  };

  // Open offline from disk with the network disabled.
  const ctx = await browser.newContext({ offline: true });
  const p = await ctx.newPage();
  const failed: string[] = [];
  p.on("requestfailed", (r) => failed.push(r.url().slice(0, 100)));
  p.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 100)}`); });
  // The static copy opens on site/index.html (the root index.html only redirects to it).
  const index = files.find((f) => f === "site/index.html") ?? files.find((f) => /(^|\/)index\.html$/.test(f));
  out.index = index ?? "none";
  if (index) {
    await p.goto(`file://${dir}/out/${index}`);
    await p.waitForTimeout(1500);
    out.indexText = JSON.stringify((await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160));
    const hrefs = await p.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    out.hrefs = JSON.stringify(hrefs.slice(0, 12));
    const pageA = files.find((f) => f.includes(`expa${stamp}`) || f.toLowerCase().includes(`expa${stamp}`));
    out.pageA = pageA ?? "none";
    if (pageA) {
      await p.goto(`file://${dir}/out/${pageA}`);
      await p.waitForTimeout(1000);
      out.pageAText = JSON.stringify((await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200));
      const imgs = await p.locator("img").evaluateAll((els) => els.map((e) => ({ src: (e as HTMLImageElement).getAttribute("src"), ok: (e as HTMLImageElement).naturalWidth > 0 })));
      out.images = JSON.stringify(imgs);
    }
  }
  out.offlineFailures = JSON.stringify([...new Set(failed)].slice(0, 8));
  await ctx.close();
  console.log(`AUDIT SITE-10 ${JSON.stringify(out)}`);
});
