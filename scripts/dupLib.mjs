// 防重複檢查的共用邏輯：CLI（scripts/dup.mjs、scripts/dupNames.mjs）與守門測試
// （packages/frontend/src/test/guards/dup.guard.test.ts）都從這裡來，不各寫一份。
//   逐字重複：jscpd（設定 .jscpd.json），比對 scripts/dup-baseline.json，只准減、不准增。
//   同名匯出：jscpd 抓不到「寫法不同但名字相同」的函式；比對 scripts/dup-names-baseline.json。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './lib/paths.mjs';

export const root = repoRoot;
const dupBaselinePath = join(root, 'scripts', 'dup-baseline.json');
const namesBaselinePath = join(root, 'scripts', 'dup-names-baseline.json');
const reportPath = join(root, 'node_modules', '.cache', 'jscpd', 'jscpd-report.json');

/** 前後端的產品原始碼：兩邊各自定義同名 type／interface 就是重複（見 scanDuplicateNames）。 */
const CONTRACT_SIDES = ['packages/backend/src/', 'packages/frontend/src/'];

export const OWNER_HINT = '請改用現成的工具函式，或把重複抽成共用入口；見 AGENTS.md「這件事歸誰管」（先找現成的，新加的要在 PR 說明寫為什麼不用現成的）。';

/** 尚未提交或相對 origin/main 有改動的檔案（盡力而為；沒有 git 就空）。 */
function changedFiles() {
  const out = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? '';
  const porcelain = out(['status', '--porcelain', '-uall']).split('\n').map((l) => l.slice(3).trim());
  const branch = out(['diff', '--name-only', 'origin/main...HEAD']).split('\n');
  return new Set([...porcelain, ...branch].filter(Boolean));
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---- 逐字重複 ----

/** 執行 jscpd，回傳 { current: {clones, duplicatedLines}, duplicates: [{lines, where}]（大的在前） }。 */
export function scanDuplicates() {
  const run = spawnSync('npx', ['--no-install', 'jscpd'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  if (run.status !== 0) throw new Error('jscpd 執行失敗');
  const report = readJson(reportPath);
  const total = report.statistics.total;
  const loc = (f) => `${relative(root, f.name)}:${f.start}-${f.end}`;
  const duplicates = report.duplicates
    .map((d) => ({ lines: d.lines, where: `${loc(d.firstFile)} <-> ${loc(d.secondFile)}` }))
    .sort((a, b) => b.lines - a.lines);
  return { current: { clones: total.clones, duplicatedLines: total.duplicatedLines }, duplicates };
}

export function writeDupBaseline(current) {
  writeFileSync(dupBaselinePath, JSON.stringify(current, null, 2) + '\n');
}

/** { ok, errors[], notes[] }：變多就 not ok；變少只提醒降 baseline。 */
export function compareDuplicates({ current, duplicates }) {
  const base = readJson(dupBaselinePath);
  const errors = [];
  const notes = [];
  const changed = changedFiles();
  if (current.clones > base.clones || current.duplicatedLines > base.duplicatedLines) {
    errors.push(
      `重複增加：baseline ${base.clones} 組／${base.duplicatedLines} 行 → 現在 ${current.clones} 組／${current.duplicatedLines} 行`,
      '重複程式碼（★＝涉及你改動的檔案，先看這些；其餘依大小排序）：',
      ...[...duplicates]
        .map((d) => ({ ...d, mine: d.where.split(' <-> ').some((w) => changed.has(w.replace(/:\d+-\d+$/, ''))) }))
        .sort((a, b) => Number(b.mine) - Number(a.mine))
        .map((d) => `${d.mine ? '★' : ' '} ${d.lines} 行  ${d.where}`),
      OWNER_HINT,
    );
  } else if (current.clones < base.clones || current.duplicatedLines < base.duplicatedLines) {
    notes.push('重複變少了：請執行 npm run dup:baseline 把 scripts/dup-baseline.json 降下來。');
  }
  return { ok: errors.length === 0, errors, notes };
}

// ---- 同名匯出 ----

// 與 .jscpd.json 掃同樣範圍：非測試的產品原始碼。
const SOURCE_DIRS = ['packages/backend/src', 'packages/frontend/src', 'packages/markdown/src', 'packages/site/src', 'packages/contract/src', 'packages/pairing/src', 'packages/relay/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '__snapshots__', 'vendor', 'migrations']);
const SKIP_FILE = /\.(test|spec|fuzz\.test|generated)\.|\.d\.ts$|(^|\/)(i18n\.[^/]*|[^/]*Labels|labels)\.ts$/;

// 測試輔助（只掃它們「匯出」的名稱；*.test.* 本身仍排除）。同名輔助只准一份。
export const TEST_HELPER_DIRS = ['packages/backend/src/test/helpers', 'packages/frontend/src/test', 'packages/frontend/e2e'];
const TEST_HELPER_SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__', 'guards', 'harness']);

/** 掃描範圍：逐字重複、同名匯出、近似重複共用（dupNearLib.mjs）。 */
export function productSourceFiles() {
  return SOURCE_DIRS.flatMap((dir) => sourceFiles(join(root, dir)));
}

function sourceFiles(dir, skipDirs = SKIP_DIRS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return skipDirs.has(e.name) ? [] : sourceFiles(path, skipDirs);
    return /\.(ts|tsx)$/.test(e.name) && !SKIP_FILE.test(path.split(sep).join('/')) ? [path] : [];
  });
}

/** 一個檔案裡「自己定義並匯出」的值名稱（函式、常數、class、enum；不含型別、re-export、default）。 */
export function exportedValueNames(text, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set();
  const exported = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0 && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Default) === 0;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (exported(st) && st.name) names.add(st.name.text);
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    }
  }
  return names;
}

/** 一個檔案裡「自己定義並匯出」的型別名稱（type、interface；不含 re-export 與只 import 的）。 */
export function exportedTypeNames(text, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set();
  for (const st of sf.statements) {
    if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export) !== 0) names.add(st.name.text);
  }
  return names;
}

/** allow 的鍵是名稱，`*` 代任意字元（例如 `*Module`）。值是理由字串，或 { reason, files }：
 *  files 是路徑的正規表示式，同名的每個檔案都要符合才算允許（例如 `*Module` 只限 modules/<id>/index.ts）。 */
const isAllowed = (name, files, allow) =>
  Object.entries(allow).some(([pattern, rule]) =>
    new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name)
    && (typeof rule === 'string' || files.every((f) => new RegExp(rule.files).test(f))));

/** rootDir 預設是 repo 根；守門測試傳暫存目錄來驗證規則。
 *  { names, types }。
 *  names：{ 名稱: [相對路徑, ...] }，只含在兩個以上檔案各自定義的函式／常數名稱，已排除允許清單。
 *  types：同形，只含前端與後端各自定義並匯出的 type／interface 名稱（API 回應形狀該寫一份，放 packages/contract）；
 *  定義在 packages/contract 再被兩邊 import 的不算（contract 不在掃描範圍，import 不是定義）。
 *  typesAllow（基準檔）：{ 名稱: { reason, files } }，核對過是兩個不同模型的同名型別；不計入 types，但名稱與檔案要完全相符。
 *  typesAllowedSeen：目前仍成立的 typesAllow 名稱（用來提醒已消失的條目該刪）。 */
export function scanDuplicateNames(rootDir = root) {
  const allow = readJson(namesBaselinePath).allow;
  const byName = new Map();
  const typeByName = new Map();
  const scanned = [...SOURCE_DIRS.map((dir) => [dir, SKIP_DIRS, true]), ...TEST_HELPER_DIRS.map((dir) => [dir, TEST_HELPER_SKIP_DIRS, false])];
  for (const [dir, skipDirs, isProduct] of scanned) {
    for (const file of sourceFiles(join(rootDir, dir), skipDirs)) {
      const rel = relative(rootDir, file).split(sep).join('/');
      for (const name of exportedValueNames(readFileSync(file, 'utf8'), rel)) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(rel);
      }
      if (!isProduct || !CONTRACT_SIDES.some((side) => rel.startsWith(side))) continue;
      for (const name of exportedTypeNames(readFileSync(file, 'utf8'), rel)) {
        if (!typeByName.has(name)) typeByName.set(name, []);
        typeByName.get(name).push(rel);
      }
    }
  }
  const names = {};
  for (const [name, files] of [...byName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (files.length > 1 && !isAllowed(name, files, allow)) names[name] = files.sort();
  }
  const typesAllow = readJson(namesBaselinePath).typesAllow ?? {};
  const types = {};
  const typesAllowedSeen = [];
  for (const [name, files] of [...typeByName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!CONTRACT_SIDES.every((side) => files.some((f) => f.startsWith(side)))) continue;
    // 一對已核對過「是兩個不同的模型」的同名型別：名稱與檔案都要和 typesAllow 寫的一致，多了第三個定義就不放行。
    const pinned = typesAllow[name]?.files;
    if (pinned && files.every((f) => pinned.includes(f))) { typesAllowedSeen.push(name); continue; }
    types[name] = files.sort();
  }
  return { names, types, typesAllowedSeen };
}

/** names 照目前清單寫；types 只准縮：只留基準裡已有的名稱與檔案，所以 --write-baseline 不會讓清單變長。 */
export function writeNamesBaseline(current) {
  const { allow, types: baseTypes = {}, typesAllow = {} } = readJson(namesBaselinePath);
  const types = {};
  for (const [name, files] of Object.entries(current.types)) {
    const known = new Set(baseTypes[name] ?? []);
    const kept = files.filter((f) => known.has(f));
    if (kept.length > 0) types[name] = kept;
  }
  writeFileSync(namesBaselinePath, JSON.stringify({ allow, typesAllow, names: current.names, types }, null, 2) + '\n');
}

/** 新名稱、或既有名稱多了定義檔案就失敗；變少只提醒降 baseline。names 與 types 同一規則。 */
export function compareDuplicateNames(current) {
  const baseline = readJson(namesBaselinePath);
  const nameResult = compareNameMap(current.names, baseline.names);
  const typeResult = compareNameMap(current.types, baseline.types ?? {});
  const errors = [];
  const notes = [];
  if (nameResult.errors.length > 0) {
    errors.push(
      '新增了同名匯出（同一個函式或常數名稱在兩個以上檔案各自定義）：',
      ...nameResult.errors,
      OWNER_HINT,
      '若是同名但各管各的（不同概念），改成能分辨的名字；確實是通用名稱時，才把名稱連同理由加進 scripts/dup-names-baseline.json 的 allow。',
    );
  }
  if (typeResult.errors.length > 0) {
    errors.push(
      '前端與後端各自定義了同名型別（API 回應的形狀只寫一份）：',
      ...typeResult.errors,
      '請把形狀放進 packages/contract（@onden/contract，純型別），兩邊都用 import type 引用，不要在後端 re-export；見 packages/contract/AGENTS.md。若只是同名但不同概念，改成能分辨的名字。',
    );
  }
  const goneAllowed = Object.keys(baseline.typesAllow ?? {}).filter((name) => !(current.typesAllowedSeen ?? []).includes(name));
  if (goneAllowed.length > 0) errors.push(`typesAllow 裡的型別已經不是前後端各自定義的同名型別了（${goneAllowed.join('、')}）：請從 scripts/dup-names-baseline.json 的 typesAllow 刪掉，讓清單只減不增。`);
  if (nameResult.stale.length > 0) notes.push(`同名匯出變少了（${nameResult.stale.join('、')}）：請執行 npm run dup:names:baseline 把 scripts/dup-names-baseline.json 降下來。`);
  if (typeResult.stale.length > 0) notes.push(`前後端同名型別變少了（${typeResult.stale.join('、')}）：請執行 npm run dup:names:baseline 把 scripts/dup-names-baseline.json 的 types 降下來。`);
  return { ok: errors.length === 0, errors, notes };
}

function compareNameMap(current, base) {
  const errors = [];
  for (const [name, files] of Object.entries(current)) {
    const known = new Set(base[name] ?? []);
    const added = files.filter((f) => !known.has(f));
    if (added.length > 0 && (!(name in base) || files.length > known.size)) {
      errors.push(`  ${name} 在 ${files.length} 個檔案各自定義：${files.join('、')}（新增：${added.join('、')}）`);
    }
  }
  const stale = Object.keys(base).filter((n) => !(n in current) || current[n].length < base[n].length);
  return { errors, stale };
}
