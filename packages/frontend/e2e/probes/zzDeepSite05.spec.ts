// Feature-audit deepening (2026-10-09, tick 14): SITE-05 — custom CSS:
// does the single-pass `</style` removal hold against a nested payload
// (`</sty</stylele>`)? Checked on the SSR public site (anonymous and the
// signed-in owner), the single-note HTML export and the export preview; plus
// invalid CSS and the 50 000-char cap. (The desktop Design tab this once also read
// back is gone: the home studio's site CSS is checked in siteStudioHome.spec.ts.)
import { test } from "@playwright/test";
import { BASE, H, publishRequest } from "../fullstack/helpers";


test("SITE-05: custom CSS escape, invalid CSS, cap", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const req = page.request; const s = Date.now();
  const cfg = async () => { const j = await (await req.get("/api/workspace/config")).json().catch(() => ({})); return (j.config ?? j) as Record<string, unknown>; };
  const css0 = (await cfg()).custom_css ?? "";
  const payload = `body{color:#111}</sty</stylele><script>window.__cssEscape=${s}</script><style>`;
  const setCss = (css: string) => req.patch("/api/workspace/config", { ...H, data: { config: { custom_css: css } } });
  const publish = async () => (await publishRequest(req, {})).status();
  try {
    const post = (await (await req.post("/api/nodes", { ...H, data: { title: `S05 ${s}`, markdown: "css test" } })).json()) as { id: string; slug: string };
    await req.put(`/api/nodes/${post.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    out.setPayload = (await setCss(payload)).status();
    out.stored = String((await cfg()).custom_css).includes("</sty</stylele>");
    out.publish = await publish();
    const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const ap = await anon.newPage();
    for (const path of ["/site/", `/site/${post.slug}`]) {
      await ap.goto(`${BASE}${path}`); await ap.waitForTimeout(1500);
      out[`anon ${path === "/site/" ? "home" : "post"}`] = { executed: await ap.evaluate(() => (window as unknown as { __cssEscape?: number }).__cssEscape ?? null), scriptTags: await ap.evaluate((v) => Array.from(document.scripts).filter((x) => x.textContent?.includes(`__cssEscape=${v}`)).length, s) };
    }
    await anon.close();
    // Signed-in owner visiting the public site (same origin as the app).
    await page.goto(`${BASE}/site/${post.slug}`); await page.waitForTimeout(1500);
    out.ownerVisit = { executed: await page.evaluate(() => (window as unknown as { __cssEscape?: number }).__cssEscape ?? null), sameOriginApiFromScript: await page.evaluate(async () => (await fetch("/api/actors", { credentials: "include" })).status) };
    // Single-note export and preview.
    const exp = await (await req.get(`/api/nodes/${post.id}/export.html`)).text();
    out.exportHtml = { hasScript: exp.includes(`<script>window.__cssEscape=${s}</script>`), hasStyleClose: /<\/style><script>window.__cssEscape/.test(exp) };
    const prev = await (await req.post(`/api/nodes/${post.id}/export-preview`, { ...H, data: { title: "x", markdown: "y" } })).json().catch(() => ({}));
    out.exportPreview = { hasScript: String(prev.html ?? "").includes(`<script>window.__cssEscape=${s}</script>`) };

    // Invalid CSS: the site still renders.
    await setCss("body { color: ; }}} @media { .x { ");
    await publish();
    const r = await page.request.get(`/site/${post.slug}`);
    out.invalidCss = { status: r.status(), hasBody: (await r.text()).includes("css test") };
    // Cap: 60 000 chars.
    const big = "/*" + "x".repeat(59_990) + "*/";
    out.bigSet = (await setCss(big)).status();
    out.bigStored = String((await cfg()).custom_css ?? "").length;
  } finally {
    await setCss(String(css0)).catch(() => {});
    await publish().catch(() => {});
    console.log("SITE05 " + JSON.stringify(out, null, 2));
  }
});
