// 發布前掃描：瀏覽器版建置結果裡不能帶著私密（金鑰樣式、內部網址、IP、email、機器路徑）。
// 用法：node scripts/browserReleaseScan.mjs [資料夾]（預設 packages/frontend/dist-browser）；有發現就 exit 1。
// `npm run deploy:browser` 在複製之前先跑這個。規則與唯一的例外都在這個檔案裡，例外只放建置本來就會有的字串。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".txt", ".map", ".md", ".xml"]);
const MAX_BYTES = 40 * 1024 * 1024;

/** 建置本來就會有、不是私密的字串（逐字比對）。每一項都寫為什麼。 */
const EXPECTED = {
  // 頁面與 worker 之間的假來源：沒有任何網路請求會送到這裡（localSession.ts、env.ts）。
  url: new Set(["http://localhost"]),
  key: new Set(['password:"this-browser-has-one-person-and-no-server"']),
  // （上一行同理：key 那一項是同一個本機帳號的密碼，不是祕密，見 localSession.ts 的說明。）
  // 試用版唯一的本機帳號，只存在使用者自己的瀏覽器資料庫（localSession.ts LOCAL_ACCOUNT）。
  email: new Set(["me@this-browser.onden"]),
  // 版本號長得像 IP 的字串不算；0.0.0.0 與 127.0.0.1 是「沒有位址」「本機」的慣用寫法。
  ip: new Set(["0.0.0.0", "127.0.0.1", "255.255.255.255", "255.255.255.0"]),
};

const RULES = [
  { kind: "key", label: "私密金鑰", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "key", label: "API 金鑰樣式", pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g },
  { kind: "key", label: "JWT／Bearer 憑證", pattern: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._~+/-]{24,}={0,2})/g },
  { kind: "key", label: "寫死的密碼或密鑰", pattern: /\b(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{16,}["']/gi },
  // localhost／127.x 指的是「看這個頁面的人自己的電腦」（程式裡的開發預設埠，例如 Ollama 的 11434），不是任何人的內部主機，所以不算；
  // 私人網段與 .internal／.local／.lan／.corp 這類主機名才是會洩漏內部架構的網址。
  { kind: "url", label: "內部網址", pattern: /\bhttps?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[A-Za-z0-9.-]+\.(?:internal|local|lan|corp|intranet|home\.arpa))(?::\d+)?(?:\/[^\s"'`)<>\\]*)?/g },
  { kind: "ip", label: "IP 位址", pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g },
  { kind: "email", label: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  // /home/runner/（GitHub Actions 的預設路徑，第三方套件發布的偵錯字串）與 /home/postgres/（PGlite 裡 Postgres 的預設帳號路徑）是別人的程式帶來的，不是這台機器的。
  { kind: "path", label: "機器路徑", pattern: /(?:\/home\/(?!runner\/|postgres\/)[a-z_][a-z0-9_-]*\/|\/Users\/[^/\s"']+\/|\/root\/|[A-Za-z]:\\Users\\[^\\\s"']+\\|\/var\/folders\/|\/tmp\/claude)[^\s"'`)]*/g },
];

/** 一個檔案的內容裡有哪些發現：[{ kind, label, match, line }] */
export function scanText(text) {
  const found = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const match = m[0];
      if (EXPECTED[rule.kind]?.has(match)) continue;
      if (rule.kind === "email" && /@example\.(?:com|org|net)$/i.test(match)) continue; // RFC 2606 的示範網域
      // 0.x 與以 .0 結尾的是網段起點（保留網段表），不是某台主機。
      if (rule.kind === "ip" && (match.startsWith("0.") || match.endsWith(".0") || isVersionLike(text, m.index))) continue;
      found.push({ kind: rule.kind, label: rule.label, match: match.length > 80 ? `${match.slice(0, 77)}…` : match, line: text.slice(0, m.index).split("\n").length });
    }
  }
  return found;
}

/** 「1.2.3.4」前面緊跟 version／v 之類字樣的是版本號，不是位址。 */
function isVersionLike(text, index) {
  return /(?:version|ver|v|@|\/)\s*["']?$/i.test(text.slice(Math.max(0, index - 12), index));
}

/** 建置資料夾裡不會被發布的檔案（建置的副產品，內含這台機器的路徑）。deploy:browser 複製時略過它們，掃描也不看。 */
export const notPublished = (relativePath) => relativePath.endsWith(".meta.json");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** 掃整個資料夾；回傳 { scanned, findings: [{ file, kind, label, match, line }] } */
export function scanFolder(folder) {
  const findings = [];
  let scanned = 0;
  for (const path of walk(folder)) {
    if (notPublished(relative(folder, path)) || !TEXT_EXTENSIONS.has(extname(path)) || statSync(path).size > MAX_BYTES) continue;
    scanned++;
    for (const f of scanText(readFileSync(path, "utf8"))) findings.push({ file: relative(folder, path), ...f });
  }
  return { scanned, findings };
}

export function reportFindings({ scanned, findings }, write = console.log) {
  if (findings.length === 0) { write(`發布前掃描：${scanned} 個文字檔，沒有發現私密。`); return; }
  write(`發布前掃描：${scanned} 個文字檔，發現 ${findings.length} 處可能的私密，不能發布：`);
  const shown = new Map();
  for (const f of findings) {
    const count = (shown.get(f.file) ?? 0) + 1;
    shown.set(f.file, count);
    if (count <= 8) write(`  ${f.file}:${f.line}  ${f.label}  ${f.match}`);
  }
  for (const [file, count] of shown) if (count > 8) write(`  ${file}  還有 ${count - 8} 處`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] ?? join(fileURLToPath(new URL("..", import.meta.url)), "packages/frontend/dist-browser"));
  const result = scanFolder(folder);
  reportFindings(result);
  process.exit(result.findings.length ? 1 : 0);
}
