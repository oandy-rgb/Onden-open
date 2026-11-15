#!/usr/bin/env node
// 桌面版冒煙測試（真的 Electron）：啟動 → 建帳號 → 新增一篇筆記 → 關掉重開 → 筆記還在、仍是登入狀態。
//   xvfb-run -a node test/smoke.mjs        （npm run test:smoke）
// 不在預設整套裡（要 Electron 與虛擬螢幕，約一分鐘）。需要先 `npm run stage`（或 desktop:build）。
// 以 root 跑（容器、CI）時 Chromium 要 --no-sandbox；一般使用者不加，維持真實的沙箱設定。
import { _electron as electron } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, "..", "src", "main.mjs");
const userData = mkdtempSync(join(tmpdir(), "onden-desktop-smoke-"));
const keep = process.argv.includes("--keep");
// --app <執行檔>：測打包後的版本（例如 release/linux-unpacked/onden 複製到 repo 外面）；不給就測 `electron .`。
const appFlag = process.argv.indexOf("--app");
const packagedExecutable = appFlag > 0 ? process.argv[appFlag + 1] : undefined;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function launch() {
  const args = [...(packagedExecutable ? [] : [main]), `--user-data-dir=${userData}`, "--lang=zh-TW"];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  const t0 = Date.now();
  const app = await electron.launch({ ...(packagedExecutable ? { executablePath: packagedExecutable } : {}), args, env: { ...process.env, LANG: "zh_TW.UTF-8", ELECTRON_ENABLE_LOGGING: "0" }, timeout: 60_000 });
  const lines = [];
  app.process().stdout?.on("data", (d) => lines.push(String(d)));
  const page = await app.firstWindow();
  return { app, page, t0, lines };
}

/** 登入表單或已登入的主畫面，先出現哪個。 */
async function waitForAppUi(page) {
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
  const login = page.locator("input[type=email]");
  const shell = page.locator(".cm-content, [data-testid=sidebar], nav").first();
  await login.or(shell).first().waitFor({ timeout: 60_000 });
  return (await login.count()) > 0 ? "login" : "app";
}

const search = (page, q) =>
  page.evaluate(async (query) => (await (await fetch(`/api/nodes/search?q=${encodeURIComponent(query)}`)).json()).length, q);

async function until(page, probe, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

const title = `桌面冒煙 ${Date.now()}`;
const needle = "雙擊就能用的測試筆記";
let first;
let second;
try {
  // ── 第一次：冷啟動、建帳號、寫筆記 ──
  first = await launch();
  const state = await waitForAppUi(first.page);
  const coldMs = Date.now() - first.t0;
  check("第一次啟動後出現登入畫面", state === "login", `${coldMs} ms（含第一次建資料庫）`);
  const url1 = first.page.url();
  check("只綁在 127.0.0.1", /^http:\/\/127\.0\.0\.1:\d+\//.test(url1), url1);
  check("沒有 Node 權限給頁面（nodeIntegration 關）", (await first.page.evaluate(() => typeof require === "undefined" && typeof process === "undefined")) === true);

  await first.page.getByRole("button", { name: /沒有帳號|註冊/ }).click();
  await first.page.getByPlaceholder("名稱").fill("桌面測試");
  await first.page.getByPlaceholder("電子郵件").fill("me@onden.local");
  await first.page.getByPlaceholder("密碼").fill("correct-horse-battery");
  await first.page.getByRole("button", { name: "建立帳號", exact: true }).click();
  await first.page.locator("input[type=email]").waitFor({ state: "detached", timeout: 30_000 });
  check("用既有的建立帳號畫面註冊成功", true);

  // 新增一篇筆記：走 App 自己的「建立」流程。
  await first.page.getByRole("button", { name: "建立", exact: true }).first().click();
  await first.page.getByRole("dialog").getByRole("button", { name: "建立", exact: true }).click();
  const editor = first.page.locator(".cm-content").first();
  await editor.waitFor({ timeout: 30_000 });
  // 新筆記的編輯器剛掛上時可能還在換內容：打字後確認字真的進了編輯器，沒有就再試。
  const body = `# ${title}\n\n這是一則${needle}。`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await editor.click();
    await first.page.keyboard.type(body, { delay: 15 });
    if ((await editor.innerText()).includes(needle)) break;
    await first.page.waitForTimeout(1000);
    await first.page.keyboard.press("Control+A");
    await first.page.keyboard.press("Delete");
  }
  const found = await until(first.page, async () => (await search(first.page, needle)) > 0);
  check("新筆記已存進後端的資料庫", found);
  if (!found) await first.page.screenshot({ path: join(here, "failed-first.png") }).catch(() => {});

  // 圖片上傳會用 sharp 重新編碼：Electron 內建的 Node 在 Linux 上會讓 sharp 當掉（所以後端用打包的 Node），這裡實際走一次。
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const upload = await first.page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "dot.png", { type: "image/png" }));
    const res = await fetch("/api/media", { method: "POST", body: form });
    return { status: res.status, body: res.ok ? await res.json() : await res.text() };
  }, png);
  const uploaded = upload.status === 200 || upload.status === 201;
  check("上傳圖片成功（sharp 在打包的 Node 下可用）", uploaded, `HTTP ${upload.status}`);
  // 失敗時把回應與後端最後幾行印出來，不用重跑才知道原因。
  if (!uploaded) console.log(`      回應：${String(upload.body).slice(0, 300)}\n      後端：\n${first.lines.join("").split("\n").slice(-15).join("\n")}`);

  const child = first.lines.join("").match(/backend ready in (\d+) ms/);
  console.log(`INFO  後端就緒 ${child?.[1] ?? "?"} ms；視窗可用 ${coldMs} ms`);
  await first.app.close();
  first = null;

  // ── 第二次：同一份資料夾，筆記還在、還在登入狀態 ──
  second = await launch();
  const state2 = await waitForAppUi(second.page);
  const warmMs = Date.now() - second.t0;
  check("重開後直接進主畫面（登入狀態保留）", state2 === "app", `${warmMs} ms`);
  check("重開後埠不變（瀏覽器端的本機資料才認得）", second.page.url().startsWith(url1.replace(/\/$/, "").split("/").slice(0, 3).join("/")));
  check("重開後筆記還在", (await search(second.page, needle)) > 0);
  await second.app.close();
  second = null;
} catch (error) {
  check("冒煙測試沒有丟出例外", false, String(error?.message ?? error).split("\n")[0]);
  await first?.page?.screenshot({ path: join(here, "failed.png") }).catch(() => {});
  await first?.app.close().catch(() => {});
  await second?.app.close().catch(() => {});
} finally {
  if (!keep) rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 項失敗` : "\n全部通過");
process.exit(failed.length ? 1 : 0);
