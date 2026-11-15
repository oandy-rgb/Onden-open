// 宿主三：瀏覽器版（packages/frontend/dist-browser，後端跑在頁面 worker 的 PGlite）。
// Chromium 開靜態網址，劇本的每個請求在頁面內 `fetch`（走同一座 fetch 橋，跟 App 一樣）。
// 圖片、zip 這類位元組不經 page.evaluate：進去的由同源 /__parity/in/<id> 提供，出來的由頁面 POST 到 /__parity/out/<id>。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../../browser-app/serve.mjs";

const requirePlaywright = (repo) => {
  const require = createRequire(import.meta.url);
  for (const base of [join(repo, "packages/frontend/e2e/package.json"), join(repo, "packages/frontend/package.json"), join(repo, "package.json")]) {
    try { return createRequire(base)("playwright"); } catch { /* 下一個 */ }
  }
  try { return require("playwright"); } catch { /* 下一個 */ }
  return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright"));
};

export async function startHost({ repo }) {
  const root = join(repo, "packages/frontend/dist-browser");
  if (!existsSync(join(root, "index.html"))) throw new Error("packages/frontend/dist-browser 還沒建好；先跑 npm run build:browser");
  const files = new Map(); // 進去的位元組
  const outbox = new Map(); // 出來的位元組
  const site = await serve(root, {
    async handle(request, response, path) {
      if (path.startsWith("/__parity/in/")) {
        const bytes = files.get(path.slice(13));
        response.writeHead(bytes ? 200 : 404, { "content-type": "application/octet-stream" });
        response.end(bytes);
        return true;
      }
      if (path.startsWith("/__parity/out/") && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        outbox.set(path.slice(14), Buffer.concat(chunks));
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    },
  });
  const playwright = requirePlaywright(repo);
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...playwright.devices["Desktop Chrome"], locale: "zh-TW", timezoneId: "UTC" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(site.base);
  const end = Date.now() + 120_000;
  let up = false;
  while (Date.now() < end && !up) {
    up = await page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } });
    if (!up) await page.waitForTimeout(500);
  }
  if (!up) throw new Error(`瀏覽器版的 worker 120 秒內沒有就緒${errors.length ? `（頁面錯誤：${errors[0]}）` : ""}`);
  let seq = 0;
  return {
    label: "瀏覽器版（Chromium + PGlite worker）",
    notes: [],
    async request({ method, path, json, upload, binary, headers, raw }) {
      const id = `f${++seq}`;
      if (upload) files.set(id, upload.bytes);
      if (raw) files.set(id, raw.bytes);
      const result = await page.evaluate(async ({ method, path, json, upload, binary, id, headers, raw }) => {
        const init = { method, headers: { ...headers } };
        if (raw) {
          init.headers["content-type"] = raw.type;
          init.body = await (await fetch(`/__parity/in/${id}`)).blob();
        } else if (upload) {
          const blob = await (await fetch(`/__parity/in/${id}`)).blob();
          const form = new FormData();
          form.append("file", new File([blob], upload.name, { type: upload.type }));
          init.body = form;
        } else if (json !== undefined) {
          init.headers["content-type"] = "application/json";
          init.body = JSON.stringify(json);
        }
        const res = await fetch(path, init);
        const contentType = res.headers.get("content-type")?.split(";")[0] ?? null;
        if (binary) {
          await fetch(`/__parity/out/${id}`, { method: "POST", body: await res.blob() });
          return { status: res.status, contentType, binary: true };
        }
        const text = await res.text();
        let body = text;
        if (contentType?.includes("json")) { try { body = JSON.parse(text); } catch { /* 留文字 */ } }
        return { status: res.status, contentType, body };
      }, { method, path, json, upload: upload && { name: upload.name, type: upload.type }, binary, id, headers, raw: raw && { type: raw.type } });
      files.delete(id);
      if (binary) { result.bytes = outbox.get(id) ?? Buffer.alloc(0); outbox.delete(id); }
      return result;
    },
    async close() {
      await browser.close().catch(() => {});
      site.close();
    },
  };
}
