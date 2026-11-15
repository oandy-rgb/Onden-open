#!/usr/bin/env node
// 往下捲不抽動: a note with a tall photo, caret at the end, keyboard up (browser app, real editor):
//   node e2e/browser-app/scrollJitter.mjs [mobile-chrome]
// A. Scrolling down by hand: the picture's box never changes height (0 → 600 jumps) and the scroll never moves back.
// B. The browser panning the visual viewport (offsetTop moves, height stays) during a hand scroll must not pull the page back to the caret.
// Keyboard and pan are simulated by replacing window.visualViewport (what useVirtualKeyboard reads). NOT a phone: no real IME or compositor.
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const device = playwright.devices["Pixel 5"];
const KEYBOARD = 300;

/** A W×H PNG (noisy gradient, so it takes a moment to decode). */
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = (x * 255 / w) | 0; raw[o + 2 + x * 3] = (y * 255 / h) | 0; raw[o + 3 + x * 3] = (x * y) & 255; }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const image = png(1200, 1600);

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
await context.addInitScript(() => {
  const target = new EventTarget();
  const vv = Object.assign(target, { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__setKeyboard = (px) => { vv.height = window.innerHeight - px; vv.dispatchEvent(new Event("resize")); };
  // What Android does while the person scrolls: the visual viewport pans (offsetTop moves, height does not).
  window.__pan = (top) => { vv.offsetTop = top; vv.dispatchEvent(new Event("scroll")); };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);
  const open = async (id) => {
    for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
    await page.goto(`${site.base}?view=notes&node=${id}`);
    await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
  };
  const para = (n) => `第 ${n} 段：` + "這是一段用來撐高頁面的中文文字，內容不重要。".repeat(6);
  // The browser app's Service Worker answers /api/media, so the picture goes in through the upload route.
  const upload = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData(); form.append("file", new File([bytes], "photo.png", { type: "image/png" }));
    const r = await fetch("/api/media", { method: "POST", body: form });
    return { status: r.status, ...(await r.json()) };
  }, image.toString("base64"));
  check("photo uploaded", upload.status === 200 || upload.status === 201, JSON.stringify(upload).slice(0, 120));
  const markdown = [para(1), `![照片](${upload.url})`, para(2), para(3), ...Array.from({ length: 40 }, (_, i) => para(i + 4))].join("\n\n");
  const note = await api("/api/nodes", "POST", { title: `大圖筆記 ${Date.now()}`, markdown });
  await open(note.json.id);
  await page.waitForTimeout(1500); // the picture loads once
  if (process.env.DEBUG_DOM) console.log(await page.evaluate(() => [...document.querySelectorAll(".cm-embed")].map((e) => e.outerHTML.slice(0, 300) + " h=" + e.getBoundingClientRect().height + " top=" + e.getBoundingClientRect().top).join("\n")));

  // Caret at the end, keyboard up (the writing position of the owner's report).
  const last = page.locator(".md-editor-cm .cm-line").last();
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.evaluate((p) => window.__setKeyboard(p), KEYBOARD);
  await page.waitForTimeout(800);
  // Back to the top, then scroll down by hand in small steps, one per frame; record every frame.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const trace = await page.evaluate(() => new Promise((done) => {
    const frames = [];
    // CodeMirror redraws the widget when it comes back near the viewport: the picture's box right after each redraw.
    window.__redraws = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n instanceof HTMLElement && n.querySelector?.(".cm-md-image")) window.__redraws.push(Math.round(n.querySelector(".cm-md-images").getBoundingClientRect().height));
      }
    }).observe(document.querySelector(".md-editor-cm .cm-content"), { childList: true, subtree: true });
    let step = 0;
    const tick = () => {
      window.scrollBy(0, step < 350 ? 10 : -10);
      const img = document.querySelector(".cm-md-image");
      if (step === 350) window.__dir = -1;
      const r = img?.getBoundingClientRect();
      const wrap = document.querySelector(".cm-md-images")?.parentElement?.getBoundingClientRect();
      frames.push({ y: Math.round(window.scrollY * 10) / 10, imgH: r ? Math.round(r.height) : -1, boxH: wrap ? Math.round(wrap.height) : -1, docH: document.documentElement.scrollHeight });
      if (++step < 700) requestAnimationFrame(tick); else done(frames);
    };
    requestAnimationFrame(tick);
  }));
  let backwards = 0, heightChanges = 0, lastBox = null;
  for (let i = 1; i < trace.length; i++) {
    const expect = i < 350 ? 1 : -1;
    if ((trace[i].y - trace[i - 1].y) * expect < -0.5 || (trace[i].y - trace[i - 1].y) * expect > 10.5) backwards++;
    if (trace[i].boxH !== trace[i - 1].boxH && trace[i].boxH > 0 && trace[i - 1].boxH > 0) heightChanges++;
  }
  const docJumps = trace.filter((f, i) => i > 0 && Math.abs(f.docH - trace[i - 1].docH) > 0).length;
  const redraws = await page.evaluate(() => window.__redraws);
  console.log(`A: picture redrawn ${redraws.length} times; its box right after each redraw (px): ${JSON.stringify(redraws)}`);
  check("A: a redrawn picture has its real height at once", redraws.length > 0 && redraws.every((h) => h > 400), `${JSON.stringify(redraws)}`);
  const jumpFrames = trace.map((f, i) => (i > 0 && f.docH !== trace[i - 1].docH ? `#${i}: ${trace[i - 1].docH}→${f.docH} (scrollY ${trace[i - 1].y}→${f.y})` : null)).filter(Boolean);
  const heights = [...new Set(trace.map((f) => f.boxH))];
  const docHs = [...new Set(trace.map((f) => f.docH))];
  console.log(`A trace: frames ${trace.length}, box heights seen ${JSON.stringify(heights)}, document heights seen ${docHs.length}`);
  console.log(`A: document height changed on ${docJumps} frames ${jumpFrames.join("; ")}; box heights ${JSON.stringify(heights)}`);
  check("A: the scroll never moves back", backwards === 0, `${backwards} backward frames`);
  check("A: the picture's box height never changes while scrolling", heightChanges === 0 && !heights.includes(0), `heights ${JSON.stringify(heights)}`);

  // B. A pan during a hand scroll: scroll up from the caret, then the browser pans the visual viewport.
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(500);
  const pan = await page.evaluate(() => new Promise((done) => {
    const frames = [];
    let step = 0;
    const tick = () => {
      window.scrollBy(0, 10);
      // The pan swings back and forth like the URL bar sliding, every few frames.
      if (step % 4 === 0) window.__pan(step % 8 === 0 ? 0 : 56);
      frames.push(Math.round(window.scrollY * 10) / 10);
      if (++step < 60) requestAnimationFrame(tick); else done(frames);
    };
    requestAnimationFrame(tick);
  }));
  await page.waitForTimeout(500);
  const panBack = pan.filter((y, i) => i > 0 && y < pan[i - 1] - 0.5).length;
  console.log(`B trace: ${pan.slice(0, 20).join(", ")} …`);
  check("B: a pan of the visual viewport does not pull a hand scroll back", panBack === 0, `${panBack} backward frames`);
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`mobile-chrome: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
