#!/usr/bin/env node
// The AI conversation in its two frames (browser app, real engine):
//   node e2e/browser-app/phoneAiPanel.mjs [--dir dist-browser] [--shots <folder>]
// 400px wide (touch): open a note, open the AI from the top bar's ✦, ask with a starter, collapse to the bar, type in the
// note, tap the bar, and the turn is still there; full ↔ half ↔ bar by the header, by Esc and by dragging; the Info screen has no AI tab.
// 1280px: the AI is the right panel's tab, the composer at its bottom, the same conversation.
// The AI service is a stand-in: the page's /api/ai/panel-chat* calls are answered here (the browser app has no AI role),
// as an AI that connects by itself (no streaming): the question waits, then the test answers it. Nothing else is faked.
// The window is a 400×800 phone-sized touch window, not a phone: the on-screen keyboard is not emulated.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const flag = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const site = await serve(resolve(here, "../..", flag("--dir") ?? "dist-browser"));
const shots = flag("--shots");
if (shots) mkdirSync(shots, { recursive: true });
const browser = await playwright.chromium.launch();
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

// Installed before the app: whatever the app puts on window.fetch (its bridge to the worker) is wrapped, so the
// stand-in AI answers its own paths and everything else goes through untouched.
const STAND_IN = () => {
  const state = { turns: [], n: 0 };
  window.__ai = state;
  window.__answer = (reply) => { const last = state.turns[state.turns.length - 1]; last.status = "completed"; last.reply = reply; };
  const roles = { roles: [{ actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "mcp", reason: null, model_name: null,
    runtimes: [{ kind: "mcp", available: true, unavailable_reason: null }] }] };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let real = window.fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    set(next) { real = next; },
    get() {
      return (input, init) => {
        const url = new URL(new Request(input, init).url, location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (url.pathname.startsWith("/api/ai/panel-chat")) {
          if (url.pathname.endsWith("/roles")) return Promise.resolve(json(roles));
          if (method === "POST") {
            const body = JSON.parse(init.body);
            state.turns.push({ session_id: `s${++state.n}`, text: body.text, status: "queued", fail_code: null, reply: null, runtime: "mcp", agent_name: "小助手",
              created_at: new Date().toISOString(), scope: { notes: [], tags: [] }, sources: [], suggestions: { pending: 0, accepted: 0, rejected: 0 }, pending: [] });
            return Promise.resolve(json({ session_id: `s${state.n}`, created: true }));
          }
          return Promise.resolve(json({ turns: state.turns }));
        }
        if (url.pathname.endsWith("/cancel") && url.pathname.startsWith("/api/agent-sessions/")) {
          const turn = state.turns.find((t) => url.pathname.includes(t.session_id));
          if (turn) turn.status = "cancelled";
          return Promise.resolve(json({ session: { status: "cancelled" }, changed: true }));
        }
        return real(input, init);
      };
    },
  });
};

async function open(viewport, label, mobile) {
  const context = await browser.newContext({ viewport, locale: "zh-TW", deviceScaleFactor: 2, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(STAND_IN);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const note = (await api("/api/nodes", "POST", { title: `AI 面板 ${label}`, markdown: "這是一則用來試問 AI 的筆記。" })).json;
  await api("/api/workspace/modules", "PATCH", { module: "ai", imported: true });
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  await page.goto(`${site.base}?view=notes&node=${note.id}`);
  await page.locator(".obsidian-title-input").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(800);
  const shot = (name) => shots ? page.screenshot({ path: join(shots, `${label}-${name}.png`) }) : null;
  return { page, context, errors, shot, note };
}
const LONG = "## 標題小錯\n\n**重點**：" + "這是一段很長的回答，用來確認對話只在自己的區域裡捲動。".repeat(6) + "\n\n" + Array.from({ length: 14 }, (_, i) => `- 第 ${i + 1} 項建議`).join("\n") + "\n\n最後一行：成建議，讓你逐項審核。";
// The conversation scrolls inside its own area: between what is above it (the tab row / the panel's header) and the box,
// never under either, and a long answer makes that area scroll instead of the page or the box.
async function checkThreadArea(page, name, aboveSelector) {
  const m = await page.evaluate((above) => {
    const r = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const thread = document.querySelector(".note-ai-thread");
    return { thread: r(".note-ai-thread"), composer: r(".note-ai-composer"), above: r(above), scrolls: thread.scrollHeight > thread.clientHeight + 4, turn: r(".note-ai-turn:last-of-type") };
  }, aboveSelector);
  check(`${name}: the conversation sits between the top row and the box, not under either`,
    m.thread && m.composer && m.above && m.thread.top >= m.above.bottom - 1 && m.thread.bottom <= m.composer.top + 1,
    `above ${Math.round(m.above?.bottom)}, thread ${Math.round(m.thread?.top)}–${Math.round(m.thread?.bottom)}, box ${Math.round(m.composer?.top)}`);
  check(`${name}: a long answer scrolls inside the conversation area and starts at its question`, m.scrolls && m.turn.top >= m.thread.top - 2 && m.turn.top < m.thread.top + 40);
}
const dock = (page) => page.locator(".ui-sheet-dock");
const height = (page) => dock(page).getAttribute("data-height").catch(() => null);

// ── 400px ─────────────────────────────────────────────────────────────────────
try {
  const { page, context, errors, shot } = await open({ width: 400, height: 800 }, "phone", true);
  const aiButton = page.getByRole("button", { name: "問 AI 這則筆記" });
  check("the ✦ button is in the note's top bar, not in a menu", await aiButton.isVisible() && await page.locator(".note-actions").getByRole("button", { name: "問 AI 這則筆記" }).count() === 1);
  check("no panel yet: the bar exists only after it was opened", await dock(page).count() === 0);
  await shot("0-note");
  await aiButton.tap();
  await dock(page).waitFor({ timeout: 30_000 });
  check("it opens at half height", (await height(page)) === "half");
  const box = await dock(page).boundingBox();
  const title = await page.locator(".obsidian-title-input").first().boundingBox();
  check("the note stays visible above the panel", !!title && title.y + title.height < box.y, `title bottom ${Math.round(title?.y + title?.height)}, panel top ${Math.round(box.y)}`);
  check("empty state: three starters, no MCP anywhere", (await dock(page).getByRole("list", { name: "可以這樣開始" }).getByRole("button").count()) === 3
    && !(await dock(page).innerText()).includes("MCP"));
  await shot("1-half-empty");
  await dock(page).getByRole("button", { name: "摘要這則筆記" }).tap();
  await dock(page).getByText("等你的電腦來接這個問題…").waitFor({ timeout: 15_000 });
  check("waiting says what it waits for, with a Cancel button", await dock(page).getByRole("button", { name: "取消" }).isVisible());
  await shot("2-waiting");
  await dock(page).getByRole("button", { name: "收起" }).or(dock(page).locator(".ui-sheet-header__actions button").last()).last().tap();
  await page.waitForFunction(() => document.querySelector(".ui-sheet-dock")?.getAttribute("data-height") === "bar");
  check("collapsing shows the bar with the short state", (await dock(page).innerText()).includes("等你的電腦"));
  await shot("3-bar-waiting");
  await page.evaluate(() => window.__answer("這則筆記很短：它是用來試問 AI 的。"));
  await dock(page).locator(".phone-ai-bar-text", { hasText: "這則筆記很短" }).waitFor({ timeout: 15_000 });
  check("the bar shows the first words of the answer", true);

  // The note above is still editable while the bar shows.
  const editor = page.locator(".md-editor-cm .cm-content").first();
  await editor.tap();
  await page.keyboard.type("，邊問邊寫");
  check("the note is editable while the bar shows", (await editor.innerText()).includes("邊問邊寫"));
  await shot("4-bar-editing");
  // With the editor focused its formatting row rides the keyboard and the bottom navigation is hidden: the bar sits on that row.
  const barBox = await dock(page).boundingBox();
  const row = await page.locator("[data-keyboard-bar]").first().boundingBox();
  check("with the editor focused the bar sits right above its formatting row", !!row && Math.abs(barBox.y + barBox.height - row.y) <= 2, `bar bottom ${Math.round(barBox.y + barBox.height)}, row top ${Math.round(row?.y)}`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(400);
  const barBox2 = await dock(page).boundingBox();
  const nav = await page.locator(".mobile-bottom-nav").boundingBox();
  check("with nothing focused the bar sits right above the bottom navigation", !!nav && Math.abs(barBox2.y + barBox2.height - nav.y) <= 2, `bar bottom ${Math.round(barBox2.y + barBox2.height)}, nav top ${Math.round(nav?.y)}`);

  await dock(page).locator(".phone-ai-bar-open").tap();
  await page.waitForTimeout(400);
  await dock(page).getByRole("textbox", { name: "問 AI" }).fill("給我完整建議");
  await dock(page).getByRole("button", { name: "送出問題" }).tap();
  await dock(page).getByText("等你的電腦來接這個問題…").waitFor({ timeout: 15_000 });
  await page.evaluate((reply) => window.__answer(reply), LONG);
  await dock(page).getByText("成建議，讓你逐項審核").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await checkThreadArea(page, "phone half", ".ui-sheet-header");
  await shot("5a-half-long-answer");
  check("tapping the bar opens half height with the turn still there", (await height(page)) === "half" && await dock(page).locator(".note-ai-text", { hasText: "這則筆記很短" }).count() > 0 && await dock(page).getByText("請幫我摘要這則筆記。").count() > 0);
  await shot("5-half-short-conversation");
  await dock(page).getByRole("button", { name: "全螢幕" }).tap();
  check("full screen on request", (await height(page)) === "full");
  await page.waitForTimeout(300);
  await checkThreadArea(page, "phone full", ".ui-sheet-header");
  await shot("6-full");
  await page.keyboard.press("Escape");
  check("Esc: full → half", (await height(page)) === "half");
  await page.keyboard.press("Escape");
  check("Esc: half → bar", (await height(page)) === "bar");
  await page.keyboard.press("Escape");
  check("Esc at the bar leaves it", (await height(page)) === "bar");

  // Drag the handle: up from the bar to half, to full, and back down.
  const drag = async (dy) => {
    const handle = await dock(page).locator(".ui-sheet-handle").boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + dy, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(350); // the height settles (0.16s) before the next drag measures the handle
  };
  await drag(-80); check("dragging the handle up: bar → half", (await height(page)) === "half");
  await drag(-80); check("dragging up again: half → full", (await height(page)) === "full");
  await drag(80); await drag(80); check("dragging down twice: back to the bar", (await height(page)) === "bar");

  // System Back (the browser's close request, which Playwright cannot send) is covered in src/test/phoneAiPanel.test.tsx.

  // The Info screen has no AI tab on a phone.
  await page.getByRole("button", { name: "資訊" }).first().tap();
  await page.getByRole("tab", { name: "功能" }).waitFor({ timeout: 15_000 });
  check("the Info screen has 功能 / 標籤 / 關係 and no AI tab", (await page.getByRole("tab", { name: "AI" }).count()) === 0 && (await page.getByRole("tab").count()) === 3);
  await shot("7-info");
  check("no page errors (400px)", errors.length === 0, errors.join(" | "));
  await context.close();
} catch (error) { check("the 400px run finished", false, String(error).slice(0, 300)); }

// ── 1280px ────────────────────────────────────────────────────────────────────
try {
  const { page, context, errors, shot } = await open({ width: 1280, height: 800 }, "desktop", false);
  await page.getByRole("tab", { name: "AI" }).first().click();
  await page.getByRole("textbox", { name: "問 AI" }).waitFor({ timeout: 30_000 });
  check("the AI is the info panel's tab; no bottom panel", (await dock(page).count()) === 0 && (await page.getByRole("button", { name: "問 AI 這則筆記" }).count()) === 0);
  const composer = await page.getByRole("textbox", { name: "問 AI" }).boundingBox();
  check("the composer sits at the bottom of the panel", composer.y > 800 * 0.7, `y ${Math.round(composer.y)}`);
  await shot("0-empty");
  await page.getByRole("button", { name: "找相關筆記" }).click();
  await page.getByText("等你的電腦來接這個問題…").waitFor({ timeout: 15_000 });
  await page.evaluate(() => window.__answer("沒有找到相關的筆記。"));
  await page.getByText("沒有找到相關的筆記。").waitFor({ timeout: 15_000 });
  await shot("1-answered");
  await page.getByRole("textbox", { name: "問 AI" }).fill("給我完整建議");
  await page.keyboard.press("Enter");
  await page.getByText("等你的電腦來接這個問題…").waitFor({ timeout: 15_000 });
  await page.evaluate((reply) => window.__answer(reply), LONG);
  await page.getByText("成建議，讓你逐項審核").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  const width = (await page.locator(".info-panel").boundingBox()).width;
  check("the side panel is about 380px wide", width < 460, `${Math.round(width)}px`);
  await checkThreadArea(page, "desktop side panel", ".info-panel-tabs");
  check("the answer is drawn as Markdown (heading, bold, list), not as typed", await page.locator(".note-ai-text h2").count() > 0 && await page.locator(".note-ai-text strong").count() > 0 && await page.locator(".note-ai-text li").count() >= 14 && !(await page.locator(".note-ai-text").last().innerText()).includes("**"));
  await shot("2-long-answer");
  await page.getByRole("textbox", { name: "問 AI" }).fill("再問一個");
  await page.keyboard.press("Enter");
  await page.getByText("再問一個").first().waitFor({ timeout: 15_000 });
  check("Enter sends on a keyboard device", await page.getByText("再問一個").count() > 0);
  check("no engine name is shown next to the hint (no MCP)", !(await page.locator(".info-panel").innerText()).includes("MCP"));
  check("no page errors (1280px)", errors.length === 0, errors.join(" | "));
  await context.close();
} catch (error) { check("the 1280px run finished", false, String(error).slice(0, 300)); }

await browser.close();
site.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
