// 公開庫的鏡像拿掉哪些路徑：資料在 removed-paths.json，這裡是唯一讀它的地方。
// 用的人：public-push.sh、verify.sh（用下面的命令列）與 scripts/check-md-links.mjs（用 isRemovedPath）。
//   node removedPaths.mjs --filter [-z]        stdin 的路徑清單，印出會被拿掉的
//   node removedPaths.mjs --not-removed-diff   stdin 是 `git diff --name-status`，印出「不是被拿掉的檔案、也不只是 .md 內容修改」的列
//   node removedPaths.mjs --pathspecs          印出 git pathspec（`:!<路徑>`），給 git diff 排除被拿掉的路徑
//   node removedPaths.mjs --link-pattern       印出 egrep 運算式：指向被拿掉的路徑的行
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REMOVED_PATHS_FILE = "scripts/public-mirror/removed-paths.json";

/** @returns {{ files: string[], prefixes: string[], imagesUnder: string[], imageExtensions: string[] }} 沒有那個檔就是空規則 */
export function loadRemovedRules(root, { required = false } = {}) {
  const abs = join(root, REMOVED_PATHS_FILE);
  // 推送腳本沒有規則就什麼都不會拿掉：圖片與部署紀錄會被推出去，所以命令列一律要求檔案存在。
  if (required && !existsSync(abs)) throw new Error(`${REMOVED_PATHS_FILE} 不存在：鏡像不知道要拿掉什麼，不推`);
  const raw = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : {};
  return { files: raw.files ?? [], prefixes: raw.prefixes ?? [], imagesUnder: raw.imagesUnder ?? [], imageExtensions: raw.imageExtensions ?? [] };
}

/** 這個路徑（檔案，或結尾 / 的資料夾）是不是鏡像會拿掉的。 */
export function isRemovedPath(rules, path) {
  const p = path.replace(/^\.\//, "");
  if (rules.files.includes(p)) return true;
  if (rules.prefixes.some((x) => p.startsWith(x) || `${p}/`.startsWith(x))) return true;
  const ext = p.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return !!ext && rules.imageExtensions.includes(ext) && rules.imagesUnder.some((x) => p.startsWith(x));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** egrep 運算式：這一行提到被拿掉的路徑（圖片副檔名、資料夾、檔案）。文件裡的連結是相對路徑（`../deploy-log.md`、
 *  `scan-2026-11-14/09-ink-pdf.md`），所以比對的是資料夾與檔案的最後一段名稱，不是從 repo 根目錄算起的完整路徑。 */
export function linkPattern(rules) {
  const lastName = (path) => escapeRegex(path.replace(/\/$/, "").split("/").pop());
  return [`\\.(${rules.imageExtensions.join("|")})`, ...rules.prefixes.map(lastName), ...rules.files.map(lastName)].join("|");
}

function main(argv) {
  const rules = loadRemovedRules(join(here, "..", ".."), { required: true });
  const stdin = () => readFileSync(0, "utf8");
  if (argv.includes("--filter")) {
    const z = argv.includes("-z");
    const out = stdin().split(z ? "\0" : "\n").filter((p) => p && isRemovedPath(rules, p));
    process.stdout.write(out.map((p) => p + (z ? "\0" : "\n")).join(""));
  } else if (argv.includes("--not-removed-diff")) {
    for (const line of stdin().split("\n")) {
      if (!line) continue;
      const [status, p] = line.split("\t");
      if (isRemovedPath(rules, p)) continue;
      if (p.endsWith(".md") && status === "M") continue;
      console.log(line);
    }
  } else if (argv.includes("--pathspecs")) {
    console.log([...rules.files, ...rules.prefixes.map((x) => x.replace(/\/$/, ""))].map((x) => `:!${x}`).join("\n"));
  } else if (argv.includes("--link-pattern")) {
    console.log(linkPattern(rules));
  } else {
    console.error("usage: removedPaths.mjs --filter [-z] | --not-removed-diff | --pathspecs | --link-pattern");
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
