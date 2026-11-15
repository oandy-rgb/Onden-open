// 宿主二：桌面版（packages/desktop，Electron + 打包進去的 Node 跑後端，PGlite）。
// Playwright `_electron` 開「打包後、複製到 repo 外」的執行檔，用 App 自己的建立帳號畫面註冊（同 desktop/test/smoke.mjs），
// 之後從 Node 端帶那個視窗的 cookie 與 origin 呼叫它的本機網址。需要螢幕（沒有就由 run.mjs 包 xvfb-run）。
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cookieClient, PARITY_USER } from "./common.mjs";

export async function startHost({ repo, flag }) {
  const desktopDir = join(repo, "packages/desktop");
  const { copyPackagedApp } = await import(pathToFileURL(join(desktopDir, "test/packagedApp.mjs")).href);
  const { _electron: electron } = createRequire(join(desktopDir, "package.json"))("playwright-core");
  const given = flag("desktop-app") ?? process.env.PARITY_DESKTOP_APP;
  const copy = given ? null : copyPackagedApp(desktopDir);
  const executable = given ?? copy.executable;
  const userData = mkdtempSync(join(tmpdir(), "onden-parity-desktop-"));
  const args = [`--user-data-dir=${userData}`, "--lang=zh-TW"];
  if (process.getuid?.() === 0) args.push("--no-sandbox"); // 容器／CI 以 root 跑時 Chromium 才起得來
  const app = await electron.launch({ executablePath: executable, args, env: { ...process.env, LANG: "zh_TW.UTF-8", ELECTRON_ENABLE_LOGGING: "0", TZ: "UTC" }, timeout: 60_000 });
  const cleanup = async () => { await app.close().catch(() => {}); rmSync(userData, { recursive: true, force: true }); copy?.cleanup(); };
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
    await page.locator("input[type=email]").waitFor({ timeout: 90_000 });
    await page.getByRole("button", { name: /沒有帳號|註冊/ }).click();
    await page.getByPlaceholder("名稱").fill(PARITY_USER.name);
    await page.getByPlaceholder("電子郵件").fill(PARITY_USER.email);
    await page.getByPlaceholder("密碼").fill(PARITY_USER.password);
    await page.getByRole("button", { name: "建立帳號", exact: true }).click();
    await page.locator("input[type=email]").waitFor({ state: "detached", timeout: 30_000 });
    const origin = new URL(page.url()).origin;
    const cookie = (await app.context().cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const client = cookieClient(origin, origin, cookie);
    return {
      label: "桌面版（Electron + PGlite，打包後）",
      notes: [`執行檔：${given ? "指定的 " : "複製到 repo 外的 "}${executable}`],
      request: (req) => client.request(req),
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
