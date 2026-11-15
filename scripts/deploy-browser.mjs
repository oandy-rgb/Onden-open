#!/usr/bin/env node
// npm run deploy:browser -- --to <資料夾> [--path <子路徑>] [--tag <版本標籤>] [--from <建置資料夾>] [--build] [--dry-run]
//
// 把瀏覽器版的建置結果（packages/frontend/dist-browser）放進你指定的資料夾，準備好給 GitHub Pages 這類純靜態主機。
// 這個腳本只複製檔案：不 commit、不 push、不碰任何遠端；資料夾是不是 git repo 它不管，之後怎麼發布由你決定。
//
//   --to <資料夾>      目的地（必填）。會在它的根目錄寫 .nojekyll（GitHub Pages 才不會跳過 _ 開頭的檔案）。
//   --path <子路徑>    放在目的地裡的哪一層，例如 onden → <資料夾>/onden/（網址就是 https://…/onden/）。預設放在資料夾根目錄。
//   --tag <標籤>       版本標籤：放在 <子路徑>/<標籤>/，不覆蓋其他版本；說明頁的回報資訊也會寫這個標籤（要搭配 --build）。
//   --from <資料夾>    建置結果在別處時指定（預設 packages/frontend/dist-browser）。
//   --build            先跑 npm run build:browser（有 --tag 就一併帶進去；--report-url=<網址> 會加到說明頁）。
//   --dry-run          只掃描、只說明會做什麼，什麼都不寫。
//
// 順序：（建置）→ 發布前掃描（金鑰樣式、內部網址、IP、email、機器路徑；有發現就停，一個檔案都不複製）→ 清掉目的地
// 那一層舊的建置 → 複製 → 寫 .nojekyll。建置副產品（*.meta.json）不會被複製。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { notPublished, reportFindings, scanFolder } from "./browserReleaseScan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const options = { dryRun: false, build: false };
  const flags = new Set(["dry-run", "build"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`不認得的參數：${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (flags.has(name)) { options[name === "dry-run" ? "dryRun" : name] = true; continue; }
    if (!["to", "path", "tag", "from", "report-url"].includes(name)) throw new Error(`不認得的參數：--${name}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} 需要一個值`);
    options[name === "report-url" ? "reportUrl" : name] = value;
  }
  return options;
}

/** 子路徑與標籤只准英數字、點、底線、連字號（子路徑可用 / 分層），不准 .. 或絕對路徑：資料只會寫進 --to 底下。 */
export function safeSegment(value, what) {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${what}「${value}」不合法：只能用英數字、點、底線、連字號（子路徑可以用 / 分層），不能有 ..`);
  }
  return value;
}

export function targetFolder(to, subPath, tag) {
  const base = resolve(to);
  const parts = [subPath && safeSegment(subPath, "--path"), tag && safeSegment(tag, "--tag")].filter(Boolean);
  const target = parts.length ? join(base, ...parts) : base;
  if (target !== base && !target.startsWith(base + sep)) throw new Error("目的地跑到 --to 外面去了");
  return { base, target };
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** 目的地那一層要換掉時，只換「看起來是我們上一次放的建置」：有 index.html 與 worker.js，或是空的／不存在。 */
function assertReplaceable(target) {
  if (!existsSync(target)) return;
  const entries = readdirSync(target);
  if (entries.length === 0) return;
  if (!(entries.includes("index.html") && entries.includes("worker.js"))) {
    throw new Error(`${target} 裡有不是瀏覽器版建置的檔案，為了不刪到別的東西，沒有動它。請指定空的資料夾或另一個 --path。`);
  }
}

export function deploy(options, log = console.log) {
  if (!options.to) throw new Error("需要 --to <資料夾>");
  if (options.tag && !options.build && !options.dryRun) log("提醒：--tag 只影響版本資料夾名稱；要讓說明頁寫上同一個標籤，請加 --build。");
  const from = resolve(options.from ?? join(root, "packages/frontend/dist-browser"));
  const { base, target } = targetFolder(options.to, options.path, options.tag);
  if (options.build) {
    if (options.dryRun) log("（dry-run）略過建置");
    else execFileSync(process.execPath, [join(root, "scripts/build-browser.mjs"), ...(options.tag ? [`--tag=${options.tag}`] : []), ...(options.reportUrl ? [`--report-url=${options.reportUrl}`] : [])], { stdio: "inherit" });
  }
  if (!existsSync(join(from, "index.html")) || !existsSync(join(from, "worker.js"))) {
    throw new Error(`${from} 不是瀏覽器版的建置結果（缺 index.html 或 worker.js）。先跑 npm run build:browser，或加 --build。`);
  }
  const scan = scanFolder(from);
  reportFindings(scan, log);
  if (scan.findings.length) throw new Error("發布前掃描沒有通過，沒有複製任何檔案。");
  assertReplaceable(target);
  const toCopy = [...files(from)].map((path) => relative(from, path)).filter((path) => !notPublished(path));
  log(`${options.dryRun ? "（dry-run）會" : ""}把 ${toCopy.length} 個檔案放進 ${target}${options.dryRun ? "" : "（舊的建置先清掉）"}`);
  if (options.dryRun) return { target, copied: 0 };
  rmSync(target, { recursive: true, force: true });
  for (const path of toCopy) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(from, path), join(target, path));
  }
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, ".nojekyll"), "");
  log("完成。沒有 commit、沒有 push、沒有碰任何遠端；.nojekyll 已寫在目的資料夾根目錄。");
  return { target, copied: toCopy.length };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    deploy(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`deploy:browser 失敗：${error.message}`);
    process.exit(1);
  }
}
