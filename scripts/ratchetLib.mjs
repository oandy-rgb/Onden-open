// 基準檔與例外清單「只准減少」的比對邏輯；CLI 是 scripts/ratchet.mjs，
// 測試是 packages/markdown/src/test/guards/ratchet.guard.test.ts。
// 把工作樹和 `git merge-base HEAD origin/main` 那一版比較：
//   失敗：既有鍵的計數變大、既有規則（群組）下多了鍵、例外清單多了項目
//   允許：整組新規則（新的頂層鍵／新的 `// ratchet:list` 標籤）、刪除、改理由文字
//   JSON 檔頂層的數值與字串屬於 `(根)` 這一組；根是物件時這組一定在（清空成 `{}` 也是，見 jsonGroups），所以多一個頂層數值算新增項目
// 逃生門：merge-base..HEAD 的任一 commit 訊息有 `ratchet-override: <原因>` 這一行。
//
// TS 例外清單的標記格式（選它而不是搬到 JSON 的理由見 PR 說明）：
//   // ratchet:list <標籤>        ← 標籤在同一個檔內唯一
//   const FOO: Record<string, string> = { "a.ts": "原因", ... };   // 或 `prop: [...]` / `prop: {...}`
// 標記下一行的 `=`（或沒有 `=` 時的 `:`）之後的字面值就是清單：物件取頂層鍵，陣列取元素；
// 條目有 `count: N` 或 `"鍵": N` 時，N 是計數（只准減）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const JSON_FILES = [
  /^scripts\/[^/]*baseline[^/]*\.json$/,
  /^packages\/[^/]+\/eslint-rules\/[^/]*(allowlist|exceptions)[^/]*\.json$/,
  /^packages\/[^/]+\/src\/test\/guards\/[^/]*baseline[^/]*\.json$/,
  /^packages\/frontend\/e2e\/layout-audit\/baseline\.json$/,
  /^packages\/frontend\/e2e\/[^/]*baseline[^/]*\.json$/,
  /^bench-budgets\.json$/,
];
// TS 例外清單：所有 guards（含 guards/allowlist/）、a11y 基準，以及擁有標記的掃描測試。
export const TS_FILES = /^packages\/[^/]+\/src\/test\/guards\/(?:allowlist\/)?[^/]+\.ts$/;
export const TS_FILES_EXTRA = [
  "packages/frontend/src/test/a11y/baseline.ts",
  "packages/backend/src/test/helpers/sweepWriteBodies.ts",
  "packages/backend/src/test/helpers/pgliteSkipList.ts",
  "packages/backend/src/test/helpers/stampedEndingExceptions.ts",
  "packages/backend/src/test/crossWorkspaceReadSweep.integration.test.ts",
  "packages/backend/src/test/crossWorkspaceWriteSweep.integration.test.ts",
];
const isTsFile = (f) => TS_FILES.test(f) || TS_FILES_EXTRA.includes(f);
export const MARKER = /\/\/\s*ratchet:list\s+(\S+)/;

/** 一個條目：群組（一份清單或一條規則）、鍵、計數（沒有計數就是 1）。 */
const entry = (groups, group, key, n) => {
  if (!groups.has(group)) groups.set(group, new Map());
  groups.get(group).set(key, n);
};

function flattenJson(value, path, out) {
  if (Array.isArray(value)) value.forEach((v) => (typeof v === "object" && v !== null ? flattenJson(v, [...path, JSON.stringify(v)], out) : out.push([[...path, String(v)], 1])));
  else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) flattenJson(v, [...path, k], out);
  else out.push([path, typeof value === "number" ? value : 1]);
}

/**
 * 一份 JSON 基準檔的群組：頂層是物件的鍵各自一組（`檔名::鍵`），頂層的數值與字串放在 `檔名::(根)` 這一組。
 * 根是物件時 `(根)` 一定在，空檔 `{}` 也是：基準清空之後這組照樣比，下一張 PR 再加一筆會算新增項目，
 * 不會被當成整組新規則放行。
 *   jsonGroups("x.json", "{}") → Map { "x.json::(根)" → Map {} }
 */
export function jsonGroups(file, text) {
  const groups = new Map();
  let root;
  try { root = JSON.parse(text); } catch { return groups; }
  if (typeof root === "object" && root !== null && !Array.isArray(root)) groups.set(`${file}::(根)`, new Map());
  for (const [top, value] of Object.entries(root)) {
    if (typeof value !== "object" || value === null) { entry(groups, `${file}::(根)`, top, typeof value === "number" ? value : 1); continue; }
    groups.set(`${file}::${top}`, new Map());
    const leaves = [];
    flattenJson(value, [], leaves);
    for (const [path, n] of leaves) entry(groups, `${file}::${top}`, path.join(" › "), n);
  }
  return groups;
}

/** `text` 從 `start` 開始的字面值（[...] 或 {...}）的頂層條目原文；字串、樣板字串與註解不算括號。 */
function topLevelEntries(text, start) {
  const open = text.slice(start).search(/[[{]/);
  if (open < 0) return [];
  let i = start + open;
  const out = [];
  let depth = 0;
  let current = "";
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; if (i === 0) break; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (depth >= 1) current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") { depth++; if (depth > 1) current += c; continue; }
    if (c === "]" || c === "}" || c === ")") {
      depth--;
      if (depth === 0) { if (current.trim()) out.push(current.trim()); return out; }
      current += c;
      continue;
    }
    if (c === "," && depth === 1) { if (current.trim()) out.push(current.trim()); current = ""; continue; }
    if (depth >= 1) current += c;
  }
  return out;
}

function entryKeyAndCount(raw) {
  const quoted = raw.match(/^(["'`])((?:\\.|(?!\1).)*)\1/s);
  const key = quoted ? quoted[2] : raw.match(/^(?:\.\.\.)?[\w$.[\]]+/)?.[0] ?? raw.slice(0, 40);
  const count = raw.match(/\bcount:\s*(\d+)/) ?? raw.match(/^(?:"[^"]*"|'[^']*'|[\w$]+)\s*:\s*(\d+)\s*$/);
  return [key, count ? Number(count[1]) : 1];
}

export function tsGroups(file, text) {
  const groups = new Map();
  const lines = text.split("\n");
  let offset = 0;
  const starts = lines.map((l) => { const s = offset; offset += l.length + 1; return s; });
  lines.forEach((line, idx) => {
    const marker = line.match(MARKER);
    if (!marker) return;
    const next = lines[idx + 1] ?? "";
    const eq = next.search(/[^=!<>]=(?![=>])/);
    const colon = next.indexOf(":");
    const from = eq >= 0 ? starts[idx + 1] + eq + 2 : colon >= 0 ? starts[idx + 1] + colon + 1 : starts[idx + 1];
    const group = `${file}#${marker[1]}`;
    groups.set(group, new Map());
    for (const raw of topLevelEntries(text, from)) {
      const [key, n] = entryKeyAndCount(raw);
      entry(groups, group, key, n);
    }
  });
  return groups;
}

/** 比對兩份群組表；回傳逐條的錯誤文字。新群組與刪除都放行。 */
export function compareGroups(base, current, headText = () => null) {
  const errors = [];
  for (const group of base.keys()) {
    // 標記被拿掉但清單（以標籤為名的常數）還在，等於把例外藏起來：刪掉整份清單才算減少。
    const [file, label] = group.split("#");
    if (label && !current.has(group) && new RegExp(`\\b${label.replace(/[^\w$]/g, "\\$&")}\\b`).test(headText(file) ?? "")) errors.push(`${group}：標記 // ratchet:list ${label} 不見了，但清單還在`);
  }
  for (const [group, items] of current) {
    const before = base.get(group);
    if (!before) continue;
    for (const [key, n] of items) {
      if (!before.has(key)) errors.push(`${group}｜${key}：新增項目（原本沒有，現在 ${n}）`);
      else if (n > before.get(key)) errors.push(`${group}｜${key}：計數變大（原本 ${before.get(key)}，現在 ${n}）`);
    }
  }
  return errors;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const tryGit = (cwd, args) => { try { return git(cwd, args).trim(); } catch { return null; } };

/** 找合併基準；淺 clone 先補歷史，做不到回 `{ fail }` 並說明怎麼補（找不到基準時不能當作通過：2026-11 之前這裡回 ok，守門在 CI 淺 clone 上整個不比）。 */
export function resolveBase(cwd, mainRef = "origin/main") {
  const remote = mainRef.includes("/") ? mainRef.split("/")[0] : null;
  const branch = mainRef.includes("/") ? mainRef.split("/").slice(1).join("/") : mainRef;
  if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", mainRef]) === null && remote) tryGit(cwd, ["fetch", remote, branch]);
  if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", mainRef]) === null) return { fail: `找不到 ${mainRef}，無法比對，所以不算通過：先 \`git fetch origin main\`（淺 clone 用 \`--unshallow\`；CI 的 guard job 用 fetch-depth 0）` };
  let base = tryGit(cwd, ["merge-base", "HEAD", mainRef]);
  const shallow = () => tryGit(cwd, ["rev-parse", "--is-shallow-repository"]) === "true";
  for (const deepen of ["--deepen=200", "--deepen=2000", "--unshallow"]) {
    if (base || !shallow() || !remote) break;
    tryGit(cwd, ["fetch", remote, deepen]);
    base = tryGit(cwd, ["merge-base", "HEAD", mainRef]);
  }
  return base ? { base } : { fail: `${mainRef} 與 HEAD 沒有共同祖先（歷史不完整），無法比對，所以不算通過：先 \`git fetch --unshallow origin main\`` };
}

/** 一個版本（`base` 為 commit，否則為工作樹）的所有群組。 */
function collect(cwd, base) {
  const names = base
    ? git(cwd, ["ls-tree", "-r", "--name-only", base]).split("\n")
    : git(cwd, ["ls-files", "-co", "--exclude-standard"]).split("\n");
  const read = (f) => { try { return base ? git(cwd, ["show", `${base}:${f}`]) : readFileSync(join(cwd, f), "utf8"); } catch { return null; } };
  const groups = new Map();
  for (const f of new Set(names)) {
    const isJson = JSON_FILES.some((re) => re.test(f));
    if (!isJson && !isTsFile(f)) continue;
    const text = read(f);
    if (text === null || (!isJson && !text.includes("ratchet:list"))) continue;
    for (const [g, items] of (isJson ? jsonGroups : tsGroups)(f, text)) groups.set(g, items);
  }
  return groups;
}

export const OVERRIDE = /^ratchet-override:\s*\S+/im;

/** `{ ok, errors, notes }`；`mainRef` 預設 origin/main。 */
export function runRatchet({ cwd = process.cwd(), mainRef = "origin/main" } = {}) {
  const resolved = resolveBase(cwd, mainRef);
  if (resolved.fail) return { ok: false, errors: [resolved.fail], notes: [] };
  const errors = compareGroups(collect(cwd, resolved.base), collect(cwd, null), (f) => { try { return readFileSync(join(cwd, f), "utf8"); } catch { return null; } });
  if (errors.length === 0) return { ok: true, errors, notes: [] };
  const trailer = (tryGit(cwd, ["log", `${resolved.base}..HEAD`, "--format=%B"]) ?? "").match(OVERRIDE);
  if (trailer) return { ok: true, errors: [], notes: [`放行：commit 訊息帶 ${trailer[0].trim()}（${errors.length} 條放寬）`, ...errors] };
  return { ok: false, errors, notes: [] };
}
