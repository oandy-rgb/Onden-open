#!/usr/bin/env node
// 文件檢查器：同一支腳本回答「文件說的，程式還這樣說嗎」。名字是歷史（一開始只查連結），保留是因為
// docs.guard.test.ts、public-push.sh、AGENTS.md 都用這個名字；不要在旁邊再開第二支檢查腳本。
//
//   node scripts/check-md-links.mjs                 全部檢查（失敗就 exit 1）
//   node scripts/check-md-links.mjs --report        再印報告：過期的提案、例外清單、各狀態的文件數（不影響結果）
//   node scripts/check-md-links.mjs --covered       PR 時：動到某份文件「涵蓋」的程式卻沒動那份文件（見下面 6）
//         [--base origin/main] [--skip]             PR 說明或 commit 訊息有一行「文件不需要更新：<原因>」就放行，但會把
//                                                   文件、glob、改到的檔、原因印出來給查證者對照 diff；另有一行
//                                                   「實作提案：<路徑>」時，那份提案在這個 PR 裡不能還是提案而沒被動過
//
// 檢查（規則寫在 docs/agents/docs-freshness.md）：
//   1 連結：相對連結指向存在的檔案（略過網址、純 #錨點、程式碼區塊與行內程式碼）。
//   2 狀態行：docs/ 底下（archive、pr-assets、screenshots 除外）每份 .md 檔頭有
//     `> 狀態：現行`／提案／已被取代／歷史紀錄；已被取代要指向取代它的文件。現行文件要嘛宣告「涵蓋」，
//     要嘛登記在 baseline 的 noCoverage（只准減少：新的現行文件一律要宣告涵蓋）。
//   3 提案：`> 完成後：<文件路徑或「歸檔」>` 指向的文件須存在；`--report` 列出「最後一次被 commit 改動」超過 60 天的提案
//     （沒有 git 歷史才退回檔頭／檔名日期）。只有提案會過期；現行文件沒有日曆期限，由「涵蓋」在程式變動時觸發。
//   4 程式碼引用（只查狀態為現行的文件、各 AGENTS.md、packages 裡的 README）：行內程式碼裡長得像 repo 路徑的
//     （packages/、scripts/、docs/、src/、db/migrations/）要存在，`路徑:行號` 要有那麼多行，「migration NNN」要有那個檔，
//     `檔案.ts` 後面緊接的 `識別字` 要出現在那個檔裡。歷史／提案／已被取代的文件與 docs/archive 不查。
//     查不過又無法在這批修的文件，登記在 scripts/docs-freshness-baseline.json（只准減少，ratchet:check 守）。
//   5 涵蓋：`> 涵蓋：<glob>[, <glob>…]` 只能出現在現行文件，每個 glob 至少要對到一個檔案。
//     被取代清單（scripts/docs-superseded.json）：還在 repo 裡、但已被別的做法取代的路徑；現行文件的程式碼引用或涵蓋指到它就失敗。
//   6 數字：`<!-- check: <檔>#<路徑> -->` 緊跟在行內的數字後面，數字要等於那個基準檔裡的值
//     （JSON：點號分隔的路徑，數字取值、陣列取長度、物件取鍵數；.mjs/.ts：常數名稱）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isTestPath } from "./changesLib.mjs";
import { repoRoot } from "./lib/paths.mjs";
import { isRemovedPath, loadRemovedRules } from "./public-mirror/removedPaths.mjs";

// Archived verbatim on purpose; its links to files that stayed in docs/research are not rewritten.
const FROZEN = new Set(["docs/archive/vps-tailscale-http-2026-09-28.md"]);

const STATUS_LINE = /^> 狀態：(現行|提案|已被取代|歷史紀錄)/m;
const CONFIRMED = /最後確認 (\d{4}-\d{2}-\d{2})/;
const HEAD_LINES = 10;
const PROPOSAL_MAX_DAYS = 60;
export const SKIP_DOCS_PHRASE = "文件不需要更新";
const SKIP_DOCS_LINE = new RegExp(`^\\s*${SKIP_DOCS_PHRASE}：\\s*\\S`, "m");
export const BASELINE_FILE = "scripts/docs-freshness-baseline.json";
export const SUPERSEDED_FILE = "scripts/docs-superseded.json";

/** 狀態行必備的範圍：docs/ 底下，除了封存與素材。 */
export const needsStatusLine = (f) => f.startsWith("docs/") && !/^docs\/(archive|pr-assets|screenshots)\//.test(f);
/** 不論狀態都查程式碼引用的文件：各層 AGENTS.md 與 packages 裡的 README（它們沒有狀態行，永遠算現行）。 */
const alwaysChecked = (f) => /(^|\/)AGENTS\.md$/.test(f) || /^packages\/.*README\.md$/.test(f) || f.startsWith("docs/agents/");

const blankFences = (text) => text.replace(/^( *)(```|~~~)[\s\S]*?^\1\2.*$/gm, (m) => m.replace(/[^\n]/g, " "));

/** 檔頭的結構化資料：狀態、最後確認日、完成後、涵蓋。 */
export function parseHead(text) {
  const head = text.split("\n").slice(0, HEAD_LINES);
  const headText = head.join("\n");
  const status = headText.match(STATUS_LINE)?.[1] ?? null;
  const statusLine = head.find((l) => l.startsWith("> 狀態：")) ?? null;
  const field = (name) => head.find((l) => l.startsWith(`> ${name}：`))?.slice(`> ${name}：`.length).trim() ?? null;
  const covers = (field("涵蓋") ?? "").split(/[,，、]/).map((s) => s.trim().replace(/^`|`$/g, "")).filter(Boolean);
  // 由資料檔產生的文件（`<!-- 由 npm run … 產生 -->`）按定義與資料一致，不需要人來「最後確認」。
  const generated = /^<!-- 由 .*產生/m.test(headText);
  return { status, statusLine, generated, confirmed: statusLine?.match(CONFIRMED)?.[1] ?? null, after: field("完成後"), covers, headText };
}

// ---- 檔案清單 ----
function walk(root, dir = "") {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === ".git") continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** repo 內的檔案（已追蹤＋未追蹤但沒被忽略）；不是 git repo（測試用的暫存資料夾）就走訪目錄。 */
export function listFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)));
  } catch {
    return walk(root);
  }
}

// ---- 1 連結 ----
export function checkLinks(root, f, text) {
  const out = [];
  const stripped = blankFences(text).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  stripped.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
      let path = target.split("#")[0].split("?")[0];
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      if (!path || !/[./]/.test(path)) continue; // "(url)" / "(…)" are prose, not links
      const abs = path.startsWith("/") ? join(root, path) : resolve(dirname(join(root, f)), path);
      if (!existsSync(abs)) out.push({ line: i + 1, message: `broken link -> ${target}` });
    }
  });
  return out;
}

// ---- 2、3 狀態行與提案 ----
export function checkStatus(root, f, head, files) {
  const out = [];
  const problem = (message) => out.push({ line: 1, message });
  if (!head.status) {
    problem('missing status line -> 檔頭加一行 "> 狀態：現行（最後確認 YYYY-MM-DD）"（讀過、確認引用都還在才寫現行；否則提案／已被取代／歷史紀錄）');
    return out;
  }
  if (head.status === "已被取代" && !/\]\(|`[^`]+`/.test(head.statusLine ?? "")) problem("狀態：已被取代 要在同一行指向取代它的文件（連結或 `路徑`）");
  if (head.after !== null) {
    if (head.status !== "提案") problem("「> 完成後：」只用在狀態為提案的文件");
    else if (head.after !== "歸檔") {
      const target = head.after.replace(/^`|`$/g, "").replace(/^\[[^\]]*\]\(([^)]*)\)$/, "$1");
      if (!files.has(target) && !existsSync(join(root, target))) problem(`完成後 指向不存在的文件 -> ${target}`);
    }
  }
  return out;
}

const DAY = 86_400_000;
const dateOf = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);

/** 一份文件最後一次被 commit 改動的日期（YYYY-MM-DD）；不是 git repo 或沒有歷史回 null。 */
export function lastTouched(root, f) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", f], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** 提案放了多久：最後一次被改動的日期，沒有 git 歷史才退回檔頭、再退回檔名的日期。 */
export function proposalDate(f, head, touched = null) {
  if (touched) return { date: touched, source: "最後改動" };
  const header = head.headText.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (header) return { date: header, source: "檔頭日期" };
  const name = f.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  return name ? { date: name, source: "檔名日期" } : { date: null, source: null };
}

/** 超過 PROPOSAL_MAX_DAYS 天沒動的提案（只報告，不算失敗）。沒有日期的也列，因為沒人看得出它放多久了。 */
export function oldProposals(docs, now = new Date()) {
  return docs.filter((d) => d.head.status === "提案").map((d) => {
    const { date, source } = proposalDate(d.f, d.head, d.touched ?? null);
    const age = date ? Math.floor((now - dateOf(date)) / DAY) : null;
    return { f: d.f, date, source, age, after: d.head.after };
  }).filter((p) => p.age === null || p.age > PROPOSAL_MAX_DAYS).sort((a, b) => (b.age ?? 1e9) - (a.age ?? 1e9));
}

// ---- 4 程式碼引用 ----
const ROOT_PATH = /^(?:packages|scripts|docs|changes|\.github|\.claude)\/[^\s]*$/;
const PLACEHOLDER = /[<>{}$…]|\.\.\.|NNN|YYYY|XXX/;
const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const SOURCE_FILE = /^[\w@./-]+\.(?:[cm]?[jt]sx?|json|sql)$/;
// 檔名與第一個識別字之間只准空白、括號與「的」；後面的識別字之間也可以用頓號或斜線。其他情況是清單（各項屬於不同檔），不是「這個檔的這個名稱」。
const FIRST_GAP = /^[\s（(]*(?:的\s*)?$/;
const NEXT_GAP = /^\s*[／/、,，]?\s*$/;
// 內建名稱與全小寫的普通單字不當成識別字引用（`Set`、`types`、`uploads`）。
const BUILTIN = new Set(["Set", "Map", "Array", "Promise", "Object", "JSON", "Date", "Error", "String", "Number", "Boolean"]);
const looksLikeIdentifier = (span) => IDENT.test(span) && !BUILTIN.has(span) && (/[A-Z_]/.test(span) || span.endsWith("()"));
// 建置產物與套件安裝目錄不進版本控制，文件可以提到，但不能要求它存在。
const GENERATED = /(^|\/)(node_modules|dist|dist-[\w-]+|\.cache)(\/|$)/;

const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const packagesNamed = (f, text) => {
  // 「> 涵蓋：」那一行是宣告，不是文件的敘述，不算「文件提到的套件」。
  const named = new Set([...text.replace(/^> 涵蓋：.*$/m, "").matchAll(/packages\/([\w-]+)/g)].map((m) => m[1]));
  const own = f.match(/^packages\/([\w-]+)\//)?.[1];
  if (own) named.add(own);
  return [...named];
};

/** 一份文件裡每個行內程式碼 { line, span, col }。 */
function codeSpans(text) {
  const out = [];
  blankFences(text).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) out.push({ line: i + 1, span: m[1], col: m.index, end: m.index + m[0].length, text: line });
  });
  return out;
}

/** span 裡的 repo 路徑引用：{ path（相對 repo 根）, lines（路徑:行號 的最大行號）, glob } 或 []。 */
function pathRefs(span, packages) {
  const out = [];
  const tokens = span.split(/[\s、，]+/);
  for (const raw of tokens) {
    let t = raw.replace(/^["'(]+|["'),.;]+$/g, "").replace(/^\.\//, "");
    if (!t || PLACEHOLDER.test(t)) continue;
    t = t.split("#")[0];
    const lineSuffix = t.match(/^(.*?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
    const lines = lineSuffix ? Math.max(...lineSuffix[2].split(/[,-]/).map(Number)) : null;
    if (GENERATED.test(t)) continue;
    if (lineSuffix) t = lineSuffix[1];
    if (ROOT_PATH.test(t)) { out.push({ paths: [t], lines }); continue; }
    if (!/[\s、，]/.test(span) && /^src\/[\w@./-]+$/.test(t) && packages.length) out.push({ paths: packages.map((p) => `packages/${p}/${t}`), lines });
    else if (/^db\/migrations\/[\w.*-]+$/.test(t)) out.push({ paths: [`packages/backend/${t}`], lines });
  }
  return out;
}

// ---- 被取代清單 ----
/** 登記檔 scripts/docs-superseded.json 的項目：{ paths: [路徑或 glob], replacedBy, pr }。 */
export function loadSuperseded(root) {
  const abs = join(root, SUPERSEDED_FILE);
  if (!existsSync(abs)) return [];
  const entries = JSON.parse(readFileSync(abs, "utf8")).entries ?? [];
  for (const e of entries) if (!Array.isArray(e.paths) || !e.paths.length || !e.replacedBy || !e.pr) throw new Error(`${SUPERSEDED_FILE}：每一項要有 paths、replacedBy、pr`);
  return entries;
}
const describeSuperseded = (e) => `${e.replacedBy}（${e.pr}）`;
/** `paths` 裡有任何一個落在某個被取代的項目上，回那一項。 */
const supersededBy = (superseded, paths) => superseded.find((e) => paths.some((p) => matchesAny(e.paths, p)));

/** 這份文件的程式碼引用有哪些壞掉。files＝repo 內所有檔案（相對路徑）。 */
/**
 * 公開庫的鏡像拿掉了這個路徑，所以它不存在是正常的：路徑符合 scripts/public-mirror/removed-paths.json，
 * 或它是資料夾、HEAD 裡那個資料夾底下的檔案全都被拿掉（只有圖片的資料夾在鏡像裡整個消失）。
 * 只在路徑真的不存在時才會問到這裡：私人庫裡存在的路徑照常檢查。
 */
export function removedByMirror(root, rules, path) {
  if (isRemovedPath(rules, path)) return true;
  try {
    const inHead = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", path.replace(/\/$/, "")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    return inHead.length > 0 && inHead.every((p) => isRemovedPath(rules, p));
  } catch {
    return false;
  }
}

/** ctx.superseded：被取代清單；ctx.removed：鏡像拿掉的路徑規則（見 removedByMirror）。 */
export function checkCodeRefs(root, f, text, files, ctx = {}) {
  const superseded = ctx.superseded ?? [];
  const removed = ctx.removed ?? null;
  const out = [];
  const fileSet = files instanceof Set ? files : new Set(files);
  const packages = packagesNamed(f, text);
  const read = (p) => readFileSync(join(root, p), "utf8");
  const spans = codeSpans(text);
  const migrations = [...fileSet].filter((p) => /^packages\/backend\/db\/migrations\/\d{3}_/.test(p)).map((p) => p.match(/migrations\/(\d{3})_/)[1]);

  for (const s of spans) {
    for (const ref of pathRefs(s.span, packages)) {
      const gone = supersededBy(superseded, ref.paths);
      if (gone) { out.push({ line: s.line, message: `superseded path -> ${ref.paths[0]}（已被取代：${describeSuperseded(gone)}）` }); continue; }
      const hit = ref.paths.find((p) => existsSync(join(root, p.replace(/\/$/, ""))));
      const wild = ref.paths[0].includes("*");
      if (wild) {
        const base = ref.paths[0].split("*")[0];
        const dir = base.endsWith("/") ? base.slice(0, -1) : dirname(base);
        if (!existsSync(join(root, dir)) && !(removed && removedByMirror(root, removed, dir))) out.push({ line: s.line, message: `missing directory -> ${dir}/（在 \`${s.span}\`）` });
        continue;
      }
      if (!hit) {
        if (!(removed && ref.paths.some((p) => removedByMirror(root, removed, p)))) out.push({ line: s.line, message: `missing path -> ${ref.paths[0]}` });
        continue;
      }
      if (ref.lines !== null && statSync(join(root, hit)).isFile() && lineCount(read(hit)) < ref.lines) {
        out.push({ line: s.line, message: `line out of range -> ${hit}:${ref.lines}（檔案只有 ${lineCount(read(hit))} 行）` });
      }
    }
  }

  // `檔案.ts` 後面緊接的 `識別字`：識別字要出現在那個檔裡（純文字搜尋）。
  spans.forEach((s, i) => {
    const file = s.span.replace(/^\.\//, "");
    if (!SOURCE_FILE.test(file) || PLACEHOLDER.test(file)) return;
    const matches = fileSet.has(file) ? [file] : [...fileSet].filter((p) => p.endsWith(`/${file}`));
    if (!matches.length) return; // 只有「看起來是 repo 路徑」的引用才要求存在；短檔名可能不指向這個 repo
    const bodies = matches.map(read);
    let prevEnd = s.end;
    for (let j = i + 1; j < spans.length; j++) {
      const n = spans[j];
      if (n.line !== s.line || !(j === i + 1 ? FIRST_GAP : NEXT_GAP).test(n.text.slice(prevEnd, n.col)) || !looksLikeIdentifier(n.span) || SOURCE_FILE.test(n.span)) break;
      const names = n.span.replace(/\(\)$/, "").split(".");
      if (!bodies.some((b) => names.every((nm) => new RegExp(`(?<![\\w$])${nm.replace(/\$/g, "\\$")}(?![\\w$])`).test(b)))) {
        out.push({ line: s.line, message: `identifier not found -> \`${n.span}\` 不在 ${matches[0]}` });
      }
      prevEnd = n.end;
    }
  });

  // migration NNN／第 NNN 號（有提到 migration／遷移的那一行）
  blankFences(text).split("\n").forEach((line, i) => {
    const nums = [...line.matchAll(/\bmigrations?\s+`?(\d{3})(?!\d)/gi)].map((m) => m[1]);
    if (/migration|遷移/i.test(line)) nums.push(...[...line.matchAll(/第\s*(\d{3})\s*號/g)].map((m) => m[1]));
    for (const n of new Set(nums)) if (!migrations.includes(n)) out.push({ line: i + 1, message: `missing migration -> ${n}` });
  });
  return out;
}

/** 這份文件的程式碼引用要不要查。 */
export const wantsCodeRefs = (f, head) => alwaysChecked(f) || head.status === "現行";

// ---- 5 涵蓋（glob）----
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += /\{[^}]*$/.test(glob.slice(0, i)) ? "|" : ",";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (globs, path) => globs.some((g) => globToRegExp(g.endsWith("/") ? `${g}**` : g).test(path));

export function checkCovers(head, files, superseded = []) {
  if (!head.covers.length) return [];
  if (head.status !== "現行") return [{ line: 1, message: "「> 涵蓋：」只用在狀態為現行的文件" }];
  const out = [];
  for (const g of head.covers) {
    if (!files.some((p) => matchesAny([g], p))) out.push({ line: 1, message: `涵蓋 的 glob 沒有對到任何檔案 -> ${g}` });
    const gone = superseded.find((e) => e.paths.some((x) => x === g || matchesAny([g], x) || matchesAny([x], g)));
    if (gone) out.push({ line: 1, message: `涵蓋 指到已被取代的東西 -> ${g}（已被取代：${describeSuperseded(gone)}）` });
  }
  return out;
}

/**
 * PR 時：動到某份文件涵蓋的程式，卻沒動那份文件。
 * @param {{ f: string, head: { covers: string[] } }[]} docs
 * @param {{ status: string, path: string }[]} entries `git diff --name-status`
 * @returns {{ doc: string, globs: string[], files: string[] }[]} 該一起更新卻沒更新的文件、被碰到的 glob 與觸發它的檔案
 */
export function uncoveredChanges(docs, entries) {
  const changed = new Set(entries.map((e) => e.path));
  const out = [];
  for (const d of docs) {
    if (!d.head.covers.length || changed.has(d.f)) continue;
    const files = [...changed].filter((p) => !isTestPath(p) && !p.endsWith(".md") && matchesAny(d.head.covers, p));
    if (files.length) out.push({ doc: d.f, globs: d.head.covers.filter((g) => files.some((p) => matchesAny([g], p))), files });
  }
  return out;
}

/** PR 說明與 commit 訊息裡每一行「文件不需要更新：<原因>」的原因。 */
export const docsSkipReasons = (env, messages = []) =>
  [env.PR_BODY ?? "", ...messages].flatMap((m) => [...m.matchAll(new RegExp(`^\\s*${SKIP_DOCS_PHRASE}：\\s*(\\S.*)$`, "gm"))].map((x) => x[1].trim()));
/** 「實作提案：<路徑>」指名的提案。 */
export const implementedProposals = (env, messages = []) =>
  [env.PR_BODY ?? "", ...messages].flatMap((m) => [...m.matchAll(/^\s*實作提案：\s*`?([^\s`]+)`?/gm)].map((x) => x[1]));

/** 說明文字（PR 說明、commit 訊息）裡有沒有一行「文件不需要更新：<原因>」。 */
export const docsSkipRequested = (argv, env, messages = []) =>
  argv.includes("--skip") || env.DOCS_SKIP === "1" || [env.PR_BODY ?? "", ...messages].some((m) => SKIP_DOCS_LINE.test(m));

// ---- 6 數字 ----
function resolveJsonPath(value, path) {
  if (path === "") return value;
  if (typeof value !== "object" || value === null) return undefined;
  for (const key of Object.keys(value)) {
    if (path === key) return value[key];
    if (path.startsWith(`${key}.`)) { const r = resolveJsonPath(value[key], path.slice(key.length + 1)); if (r !== undefined) return r; }
  }
  return undefined;
}

/** 基準檔裡的值：JSON 的路徑，或 .mjs/.ts 裡的常數。查不到回 undefined。 */
export function baselineValue(root, ref) {
  const [file, path = ""] = ref.split("#");
  const abs = join(root, file);
  if (!existsSync(abs)) return undefined;
  const text = readFileSync(abs, "utf8");
  if (file.endsWith(".json")) {
    let v;
    try { v = resolveJsonPath(JSON.parse(text), path); } catch { return undefined; }
    if (typeof v === "number") return v;
    if (Array.isArray(v)) return v.length;
    return v && typeof v === "object" ? Object.keys(v).length : undefined;
  }
  const m = text.match(new RegExp(`\\b${path.replace(/[^\w$]/g, "")}\\b\\s*[:=]\\s*([\\d_.]+)`));
  return m ? Number(m[1].replace(/_/g, "")) : undefined;
}

export function checkNumbers(root, text) {
  const out = [];
  // 說明「怎麼寫 check 註解」的範例（行內程式碼、程式碼區塊）不是要檢查的註解。
  blankFences(text).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/<!--\s*check:\s*(\S+)\s*-->/g)) {
      const before = line.slice(0, m.index);
      const claimed = [...before.matchAll(/\d[\d,_]*(?:\.\d+)?/g)].pop();
      const expected = baselineValue(root, m[1]);
      if (expected === undefined) out.push({ line: i + 1, message: `check 指向不存在的值 -> ${m[1]}` });
      else if (!claimed) out.push({ line: i + 1, message: `check 前面找不到數字 -> ${m[1]}` });
      else if (Number(claimed[0].replace(/[,_]/g, "")) !== expected) out.push({ line: i + 1, message: `數字過時：文件寫 ${claimed[0]}，${m[1]} 現在是 ${expected}` });
    }
  });
  return out;
}

// ---- 全部合起來 ----
/**
 * @param {string} root
 * @param {{ files?: string[], baseline?: { codeReferences?: Record<string,string> }, now?: Date }} [opts]
 */
export function checkDocs(root, { files = listFiles(root), baseline = {}, now = new Date(), superseded = loadSuperseded(root), removed = loadRemovedRules(root) } = {}) {
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const fileSet = new Set(files);
  const exceptions = baseline.codeReferences ?? {};
  const noCoverage = new Set(baseline.noCoverage ?? []);
  const problems = { links: [], status: [], codeRefs: [], covers: [], numbers: [], exceptions: [] };
  const docs = [];
  const add = (kind, f, list) => list.forEach((p) => problems[kind].push({ f, ...p }));
  const counts = { documents: mdFiles.length, codeRefDocuments: 0, byStatus: {} };

  for (const f of mdFiles) {
    if (FROZEN.has(f)) continue;
    const text = readFileSync(join(root, f), "utf8");
    const head = parseHead(text);
    docs.push({ f, head, touched: head.status === "提案" ? lastTouched(root, f) : null });
    add("links", f, checkLinks(root, f, text));
    if (needsStatusLine(f)) { add("status", f, checkStatus(root, f, head, fileSet)); const k = head.status ?? "(無)"; counts.byStatus[k] = (counts.byStatus[k] ?? 0) + 1; }
    add("covers", f, checkCovers(head, files, superseded));
    const needsCover = head.status === "現行" && !head.generated && !head.covers.length;
    if (needsCover && !noCoverage.has(f)) problems.covers.push({ f, line: 1, message: `現行文件要宣告 "> 涵蓋：<glob>"（它描述哪些程式）；沒有對應程式的才登記在 ${BASELINE_FILE} 的 noCoverage，而那份清單只准減少，新文件不能加` });
    if (!needsCover && noCoverage.has(f)) problems.exceptions.push({ f, line: 1, message: `noCoverage 裡的文件已經有涵蓋、或不是現行 -> 從 ${BASELINE_FILE} 刪掉這一項` });
    add("numbers", f, checkNumbers(root, text));
    if (wantsCodeRefs(f, head)) {
      counts.codeRefDocuments++;
      const found = checkCodeRefs(root, f, text, fileSet, { superseded, removed });
      if (f in exceptions) {
        if (!found.length) problems.exceptions.push({ f, line: 1, message: `已登記為例外但現在查得過 -> 從 ${BASELINE_FILE} 刪掉這一項` });
      } else add("codeRefs", f, found);
    }
  }
  // 鏡像拿掉的文件（掃描報告、部署紀錄）在鏡像裡不存在是正常的，清單照舊留著（私人庫裡它們存在，照常檢查）。
  for (const f of Object.keys(exceptions)) if (!mdFiles.includes(f) && !isRemovedPath(removed, f)) problems.exceptions.push({ f, line: 1, message: `例外清單裡的文件不存在 -> 從 ${BASELINE_FILE} 刪掉` });
  for (const f of noCoverage) if (!mdFiles.includes(f) && !isRemovedPath(removed, f)) problems.exceptions.push({ f, line: 1, message: `noCoverage 裡的文件不存在 -> 從 ${BASELINE_FILE} 刪掉` });
  const total = Object.values(problems).reduce((n, l) => n + l.length, 0);
  return { problems, docs, counts, total, oldProposals: oldProposals(docs, now), exceptions, noCoverage: [...noCoverage], superseded };
}

const LABEL = { links: "壞連結", status: "狀態行", codeRefs: "過時的程式碼引用", covers: "涵蓋", numbers: "數字", exceptions: "例外清單" };

export function summary(r) {
  const n = (k) => r.problems[k].length;
  return `${r.counts.documents} markdown files checked, ${n("links")} broken link(s), ${n("status")} status line problem(s), ${n("codeRefs")} stale code reference(s), ${n("covers")} coverage problem(s), ${n("numbers")} stale number(s), ${n("exceptions")} exception list problem(s)`;
}

function printReport(r) {
  console.log("\n## 報告");
  console.log(`文件數：${r.counts.documents}；查程式碼引用的有 ${r.counts.codeRefDocuments} 份；docs/ 狀態分布：${Object.entries(r.counts.byStatus).map(([k, v]) => `${k} ${v}`).join("、")}`);
  console.log(`\n### 超過 ${PROPOSAL_MAX_DAYS} 天的提案（${r.oldProposals.length}）：要嘛做完改成現行、要嘛歸檔、要嘛重新決定`);
  for (const p of r.oldProposals) console.log(`  ${p.f}  ${p.date ? `${p.age} 天沒動（${p.source} ${p.date}）` : "沒有日期"}  完成後：${p.after ?? "（未寫）"}`);
  const ex = Object.entries(r.exceptions);
  console.log(`\n### 程式碼引用的例外清單（${ex.length}，只准減少）`);
  for (const [f, reason] of ex) console.log(`  ${f}  ${reason}`);
  console.log(`\n### 沒有涵蓋的現行文件（${r.noCoverage.length}，只准減少；每補一份「> 涵蓋：」就從清單刪一項）`);
  console.log(`### 被取代清單（${r.superseded.length}）`);
  for (const e of r.superseded) console.log(`  ${e.paths.join(", ")}  →  ${describeSuperseded(e)}`);
}

// ---- CLI ----
function main(argv) {
  const root = repoRoot;
  if (argv.includes("--covered")) return coveredMain(argv, root);
  const baselinePath = join(root, BASELINE_FILE);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  const r = checkDocs(root, { baseline });
  for (const kind of Object.keys(LABEL)) for (const p of r.problems[kind]) console.log(`${p.f}:${p.line}: ${p.message}`);
  console.log(summary(r));
  if (argv.includes("--report")) printReport(r);
  return r.total ? 1 : 0;
}

/**
 * PR 時的「涵蓋」檢查（`--covered`）。回傳 { code, lines }：code 0 通過、1 該更新文件或提案沒處理、2 無法比對。
 * 放行：`--skip`、DOCS_SKIP=1、PR_BODY 或任一 commit 訊息有一行「文件不需要更新：<原因>」（與 changes:check 同一套讀法）。
 * 放行不是免查：被放行的文件、glob、改到的檔與作者寫的原因都印出來（exit 0），查證者對照 diff 用。
 * 「實作提案：<路徑>」指名的提案不受放行影響：那份文件在這個 PR 裡仍是提案、又沒被動過，就失敗。
 */
export function coveredCheck(root, { base = "origin/main", argv = [], env = {} } = {}) {
  let entries;
  let messages;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  try {
    entries = git("diff", "--name-status", `${base}...HEAD`)
      .split("\n").filter(Boolean).map((line) => { const [status, ...paths] = line.split("\t"); return { status, path: paths[paths.length - 1] }; });
    messages = git("log", "--format=%B%x00", `${base}..HEAD`).split("\0");
  } catch (e) {
    return { code: 2, lines: [`無法比對 ${base}...HEAD：${e.message}`] };
  }
  const lines = [];
  let code = 0;

  const changed = new Set(entries.map((e) => e.path));
  for (const path of implementedProposals(env, messages)) {
    const abs = join(root, path);
    if (!existsSync(abs)) { lines.push(`實作提案：${path} 不存在`); code = 1; continue; }
    const status = parseHead(readFileSync(abs, "utf8")).status;
    if (status === "提案" && !changed.has(path)) {
      lines.push(`實作提案：${path} 在這個 PR 裡仍是「提案」，而且沒有被動過：改狀態，或寫「> 完成後：」並說明還剩哪些沒做。`);
      code = 1;
    } else lines.push(`實作提案：${path}（狀態：${status ?? "沒有狀態行"}${changed.has(path) ? "，本 PR 有改" : ""}）`);
  }

  const docs = listFiles(root).filter((f) => f.endsWith(".md") && !FROZEN.has(f)).map((f) => ({ f, head: parseHead(readFileSync(join(root, f), "utf8")) }));
  const missed = uncoveredChanges(docs, entries);
  const skipped = docsSkipRequested(argv, env, messages);
  const reasons = docsSkipReasons(env, messages);
  if (!missed.length) {
    lines.push(skipped ? `docs:covered：有「${SKIP_DOCS_PHRASE}」的聲明，但這個 PR 沒有動到任何文件涵蓋的程式。` : "docs:covered 通過：動到的程式，它們涵蓋的文件都一起動了（或沒有文件涵蓋）。");
    return { code, lines };
  }
  const detail = (m) => [
    `  ${m.doc}（涵蓋：${m.globs.join(", ")}）`,
    ...m.files.slice(0, 10).map((p) => `    ${p}`),
    ...(m.files.length > 10 ? [`    …還有 ${m.files.length - 10} 個`] : []),
  ];
  if (skipped) {
    lines.push(`docs:covered 放行（${SKIP_DOCS_PHRASE}）。以下是被放行的項目，由查證者對照 diff 確認文件確實不需要改：`);
    for (const m of missed) lines.push(...detail(m));
    lines.push(`  作者寫的原因：${reasons.length ? reasons.join("；") : "（只用了 --skip／DOCS_SKIP，沒有寫原因）"}`);
    return { code, lines };
  }
  lines.push("動到了有文件「涵蓋」的程式，但沒有一起更新那份文件：");
  for (const m of missed) lines.push(...detail(m));
  lines.push("", `讀一遍那份文件、改掉說錯的地方。確實不需要（只改內部、文件說的仍然成立）時，在 PR 說明或 commit 訊息寫一行「${SKIP_DOCS_PHRASE}：<原因>」——這個聲明會被印出來，由查證者對照 diff。`);
  return { code: 1, lines };
}

function coveredMain(argv, root) {
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "origin/main";
  const { code, lines } = coveredCheck(root, { base, argv, env: process.env });
  for (const l of lines) (code === 0 ? console.log : console.error)(l);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
