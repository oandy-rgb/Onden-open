// 無人使用的程式碼檢查：CLI 是 scripts/unusedCode.mjs，由 scripts/guard-lane.sh 執行。
// 只抓兩件事（都只看「產品程式」：測試、e2e、test/ 資料夾不算使用者）：
//   檔案：沒有任何產品檔（或 scripts、設定檔、html、package.json）匯入的產品原始檔。
//   匯出：名稱在自己以外的任何產品檔／scripts 都沒出現的 export（只被自己或測試用到）。
// 故意不用 knip：它要建完整型別程式，記憶體與時間都超過 guard lane 的預算；這裡只用 TypeScript 的
// 單檔語法解析（不建 program）加字詞索引，整個 repo 約數秒。
// 取捨（偏保守，寧可漏報不誤報）：名稱以「字詞」比對，同名的另一個檔案用了就算有人用；
// 註解行（`//`、`*` 開頭）不算引用；`export * from` 與 re-export 只讓名稱「出現」，不另檢查 barrel 本身。
// 基準：scripts/unused-code-baseline.json（`intentional`＝刻意保留，附理由；`leftover`＝尚未清掉，只准減少）。
// 清單內的條目若已不再是死碼也會失敗，要求刪掉，基準才不會變成永遠不縮的垃圾桶。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { repoRoot } from "./lib/paths.mjs";

export const baselinePath = join(repoRoot, "scripts", "unused-code-baseline.json");

const PACKAGES = ["backend", "contract", "frontend", "markdown", "pairing", "relay", "site"];
const SKIP_DIRS = new Set(["node_modules", ".git", "migrations", "__snapshots__", "vendor", ".astro", "android", "public", "coverage", "test-results", "playwright-report", ".bench", ".cache"]);
/** 建置產物（dist、dist-browser…）不算原始碼，否則建置過的工作樹會讓死碼看起來有人用。 */
const skipDir = (name) => SKIP_DIRS.has(name) || /^dist(-[\w-]+)?$/.test(name);
const SOURCE_EXT = /\.(ts|tsx)$/;
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const AUX_TEXT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|astro|html|json|sh|ya?ml)$|(^|\/)Dockerfile[^/]*$/;

/** 測試與測試輔助：不算「使用」，自己也不被檢查。 */
const isTestPath = (rel) =>
  /(^|\/)(test|tests|__tests__|e2e|test-astro|fixtures)\//.test(rel) || /\.(test|spec|fuzz\.test|stories)\.[cm]?[tj]sx?$/.test(rel) || /\.d\.ts$/.test(rel);

/** 沒人 import 也正常的產品檔：檔案式路由。 */
const STRUCTURAL_ENTRY = [/(^|\/)src\/pages\//, /(^|\/)src\/main\.tsx?$/];

/** 哪些檔的「src/….ts」字串算引用：package.json、Dockerfile、yaml、sh、html，以及會啟動程式的 scripts（不含只列路徑的清單檔）。 */
const PATH_STRING_SOURCE = (relPath, isCode) => {
  if (relPath.endsWith("package.json")) return true;
  if (/\.json$/.test(relPath)) return false;
  if (!isCode) return true;
  return /(^|\/)scripts\//.test(relPath) && !/allowlist|entrypoint|catalog|dup|ratchet|agentsTables|unusedCode/.test(relPath);
};

const rel = (abs) => relative(repoRoot, abs).split(sep).join("/");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skipDir(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 讀所有要掃的檔：每個套件整個目錄（含 scripts、設定檔），加根目錄 scripts 與 docker。 */
function collectFiles(root) {
  const abs = [];
  for (const p of PACKAGES) abs.push(...walk(join(root, "packages", p)));
  abs.push(...walk(join(root, "scripts")), ...walk(join(root, "docker")));
  for (const f of ["package.json", "compose.yaml", "compose.e2e.yaml"]) if (existsSync(join(root, f))) abs.push(join(root, f));
  return abs.map((a) => ({ abs: a, rel: relative(root, a).split(sep).join("/") }));
}

const globToRegex = (glob) =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");

/** 檔案文字中的模組指定字串：import／export from／動態 import／require／new URL(…, import.meta.url)／import.meta.glob。 */
export function moduleSpecifiers(text) {
  const out = [];
  const add = (spec, glob = false) => out.push({ spec, glob });
  for (const m of text.matchAll(/\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n$]+)\1/g)) add(m[2]);
  for (const m of text.matchAll(/new URL\(\s*(['"`])([^'"`\n$]+)\1\s*,\s*import\.meta\.url/g)) add(m[2]);
  for (const m of text.matchAll(/import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\(\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/g)) {
    for (const g of m[1].matchAll(/(['"`])([^'"`]+)\1/g)) add(g[2], true);
  }
  return out;
}

/** 工作區套件的 `@onden/<name>[/sub]` → 原始碼檔（package.json exports 的 dist 路徑換回 src）。 */
function packageEntryMap(root) {
  const map = new Map();
  for (const p of PACKAGES) {
    const pj = join(root, "packages", p, "package.json");
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, "utf8"));
    const name = json.name;
    if (!name) continue;
    const toSrc = (target) => {
      if (typeof target !== "string") return null;
      const fromDist = target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
      return join(root, "packages", p, fromDist);
    };
    for (const [sub, target] of Object.entries(json.exports ?? {})) {
      const t = typeof target === "string" ? target : (target.types ?? target.default);
      const file = toSrc(t);
      if (file) map.set(sub === "." ? name : `${name}/${sub.replace(/^\.\//, "")}`, file);
    }
  }
  return map;
}

function resolveRelative(fromFile, spec, known) {
  const base = resolve(dirname(fromFile), spec.replace(/[?#].*$/, ""));
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  const candidates = [base, stem, ...RESOLVE_EXT.map((e) => base + e), ...RESOLVE_EXT.map((e) => stem + e), ...RESOLVE_EXT.map((e) => join(base, "index" + e))];
  return candidates.find((c) => known.has(c)) ?? null;
}

const exportedFlag = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;

/** 一個檔案自己宣告的 export 名稱（值與型別；`export { a as b }` 取 b；不含 `from` 的 re-export、default）。 */
export function declaredExports(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = [];
  for (const st of sf.statements) {
    const isDefault = (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Default) !== 0;
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isModuleDeclaration(st)) && exportedFlag(st) && !isDefault && st.name && ts.isIdentifier(st.name)) {
      names.push(st.name.text);
    } else if (ts.isVariableStatement(st) && exportedFlag(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.push(el.name.text);
    }
  }
  return names;
}

const WORD = /[A-Za-z_$][\w$]*/g;
/** 檔案裡出現的字詞；整行註解不算。 */
function wordsOf(text) {
  const kept = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return new Set(kept.match(WORD) ?? []);
}

/** 掃描整個 repo，回傳 { files: {rel: 原因}, exports: {"rel#名稱": 原因} }（未套用基準）。 */
export function scanUnused(root = repoRoot) {
  const all = collectFiles(root);
  const known = new Set(all.map((f) => f.abs));
  const entryMap = packageEntryMap(root);
  const nonTest = all.filter((f) => !isTestPath(f.rel));
  const production = nonTest.filter((f) => /^packages\/[^/]+\/src\//.test(f.rel) && SOURCE_EXT.test(f.rel));

  // 讀文字：只有會當「使用者」或「被檢查」的檔案才讀。
  const text = new Map();
  for (const f of nonTest) if (AUX_TEXT_EXT.test(f.rel) && f.rel.slice(-5) !== ".d.ts" && statSync(f.abs).size < 4_000_000) text.set(f.abs, readFileSync(f.abs, "utf8"));

  // 1) 檔案：誰被匯入
  const imported = new Set();
  const globs = [];
  for (const f of nonTest) {
    const src = text.get(f.abs);
    if (src === undefined || f.rel.endsWith("package-lock.json")) continue;
    const isCode = /\.(m?[jt]sx?|cjs|astro)$/.test(f.rel);
    if (isCode) {
      for (const { spec, glob } of moduleSpecifiers(src)) {
        if (glob) globs.push({ from: f.abs, re: globToRegex(resolve(dirname(f.abs), spec).split(sep).join("/")) });
        else if (spec.startsWith(".")) {
          const hit = resolveRelative(f.abs, spec, known);
          if (hit) imported.add(hit);
        } else {
          const hit = entryMap.get(spec);
          if (hit) imported.add(hit);
        }
      }
    }
    // package.json、Dockerfile、yaml、sh、html：路徑字串（`src/server.ts`、`<script src="/src/main.tsx">`）
    if (PATH_STRING_SOURCE(f.rel, isCode)) {
      for (const m of src.matchAll(/(?:\.\/|\/)?((?:packages\/[\w-]+\/)?src\/[\w./-]+\.(?:tsx?|mjs|js))\b/g)) {
        for (const base of [root, join(root, dirname(f.rel).split("/").slice(0, 2).join("/")), join(root, dirname(f.rel))]) {
          const p = resolve(base, m[1]);
          if (known.has(p)) imported.add(p);
        }
      }
    }
  }
  for (const f of production) {
    const abs = f.abs.split(sep).join("/");
    if (globs.some((g) => g.re.test(abs))) imported.add(f.abs);
  }

  const files = {};
  for (const f of production) {
    if (imported.has(f.abs) || STRUCTURAL_ENTRY.some((re) => re.test(f.rel))) continue;
    files[f.rel] = "沒有任何產品檔匯入";
  }

  // 2) 匯出：名稱在別的產品檔都沒出現
  const wordsByFile = new Map();
  const holders = new Map(); // 字詞 → 出現的檔案集合
  for (const f of nonTest) {
    const src = text.get(f.abs);
    if (src === undefined || f.rel.endsWith("package-lock.json") || /\.json$/.test(f.rel)) continue;
    const words = wordsOf(src);
    wordsByFile.set(f.abs, words);
    for (const w of words) {
      let set = holders.get(w);
      if (!set) holders.set(w, (set = new Set()));
      set.add(f.abs);
    }
  }
  const exports = {};
  for (const f of production) {
    if (/\.generated\./.test(f.rel) || files[f.rel]) continue; // 整個檔都死了就只報檔案
    for (const name of new Set(declaredExports(text.get(f.abs), f.rel))) {
      const users = holders.get(name);
      const usedElsewhere = users && [...users].some((u) => u !== f.abs);
      if (!usedElsewhere) exports[`${f.rel}#${name}`] = "只在自己的檔案出現";
    }
  }
  return { files, exports };
}

/** 檔案裡 leftover.exports 寫成 { 檔案: [名稱…] }（短、好讀）；程式內部用 { "檔案#名稱": 理由 }。 */
const LEFTOVER_REASON = "尚未清掉";
const expandLeftover = (byFile) =>
  Object.fromEntries(Object.entries(byFile ?? {}).flatMap(([file, names]) => names.map((name) => [`${file}#${name}`, LEFTOVER_REASON])));
const groupLeftover = (exports) => {
  const byFile = {};
  for (const key of Object.keys(exports)) {
    const [file, name] = key.split("#");
    (byFile[file] ??= []).push(name);
  }
  return Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, names]) => [f, names.sort()]));
};

export function readBaseline() {
  const empty = { intentional: { files: {}, exports: {} }, leftover: { files: {}, exports: {} } };
  if (!existsSync(baselinePath)) return empty;
  const json = JSON.parse(readFileSync(baselinePath, "utf8"));
  return {
    intentional: { files: {}, exports: {}, ...json.intentional },
    leftover: { files: { ...json.leftover?.files }, exports: expandLeftover(json.leftover?.exports) },
  };
}

/** intentional 的鍵可以用樣式：檔案部分以 `/` 結尾＝整個資料夾；`#` 後面的名稱 `*`＝該檔所有匯出。 */
function keyMatches(pattern, key) {
  if (pattern === key) return true;
  const [pFile, pName] = pattern.split("#");
  const [kFile, kName] = key.split("#");
  const fileOk = pFile.endsWith("/") ? kFile.startsWith(pFile) : pFile === kFile;
  return fileOk && (pName === undefined || pName === "*" || pName === kName);
}

/** 比對：目前的死碼 vs 基準。新的死碼、過期的條目（已不是死碼）、缺理由的 intentional 都算失敗。 */
export function compareUnused(current, baseline = readBaseline()) {
  const errors = [];
  const allowed = (kind, key) =>
    Object.keys(baseline.intentional[kind]).some((pattern) => keyMatches(pattern, key)) || key in baseline.leftover[kind];
  for (const key of Object.keys(current.files)) {
    if (!allowed("files", key)) errors.push(`沒有人匯入的檔案：${key}。請刪掉；若是刻意保留（入口、手動執行），加進 scripts/unused-code-baseline.json 的 intentional.files 並寫理由。`);
  }
  for (const key of Object.keys(current.exports)) {
    if (!allowed("exports", key)) {
      const [file, name] = key.split("#");
      errors.push(`沒有人使用的匯出：${file} 的 ${name}（只在自己的檔案或測試出現）。請刪掉，或取消 export；刻意保留請加進 intentional.exports 並寫理由。`);
    }
  }
  for (const section of ["intentional", "leftover"]) {
    for (const kind of ["files", "exports"]) {
      for (const [key, reason] of Object.entries(baseline[section][kind])) {
        const stillDead = Object.keys(current[kind]).some((k) => (section === "intentional" ? keyMatches(key, k) : key === k));
        if (!stillDead) errors.push(`基準裡的 ${section}.${kind} 條目已不是死碼，請從 scripts/unused-code-baseline.json 刪掉：${key}`);
        else if (section === "intentional" && (typeof reason !== "string" || reason.trim().length < 6)) errors.push(`intentional.${kind} 要寫理由：${key}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 把基準縮到目前的死碼（只刪過期條目，不新增）。 */
export function shrinkBaseline(current, baseline = readBaseline()) {
  const next = { intentional: { files: {}, exports: {} }, leftover: { files: {}, exports: {} } };
  for (const section of ["intentional", "leftover"]) {
    for (const kind of ["files", "exports"]) {
      for (const [key, reason] of Object.entries(baseline[section][kind])) {
        const stillDead = Object.keys(current[kind]).some((k) => (section === "intentional" ? keyMatches(key, k) : key === k));
        if (stillDead) next[section][kind][key] = reason;
      }
    }
  }
  return next;
}

/** 目前的死碼全寫進 leftover（建立初始基準用）；intentional 保留，已被它涵蓋的不重複寫。 */
export function seedBaseline(current, baseline = readBaseline()) {
  const next = { intentional: baseline.intentional, leftover: { files: {}, exports: {} } };
  for (const kind of ["files", "exports"]) {
    for (const [key, reason] of Object.entries(current[kind])) {
      if (!Object.keys(baseline.intentional[kind]).some((pattern) => keyMatches(pattern, key))) next.leftover[kind][key] = reason;
    }
  }
  return next;
}

export function writeBaseline(baseline) {
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = {
    說明: "unused:check 的基準，只准減少（ratchet:check）。intentional＝刻意保留，必須寫理由；leftover＝尚未清掉的死碼。新的死碼請直接刪，不要加進這裡。",
    intentional: { files: sortKeys(baseline.intentional.files), exports: sortKeys(baseline.intentional.exports) },
    leftover: { files: sortKeys(baseline.leftover.files), exports: groupLeftover(baseline.leftover.exports) },
  };
  // leftover.exports：一個檔案一行（名稱陣列不拆行），避免上千行的清單。
  const text = JSON.stringify(body, null, 2).replace(/\[\n\s+([^\]]*?)\n\s+\]/g, (_m, inner) => `[${inner.replace(/,\n\s+/g, ", ")}]`);
  writeFileSync(baselinePath, text + "\n");
}
