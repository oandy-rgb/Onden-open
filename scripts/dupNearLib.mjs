// 近似重複偵測：抓「變數改名、調整註解」後的函式複本（jscpd 只抓逐字、dup:names 只抓同名）。
// CLI（scripts/dupNear.mjs）與守門測試（packages/frontend/src/test/guards/dupNear.guard.test.ts）共用。
//   1. 用 TypeScript AST 列出函式、方法、箭頭函式（至少 MIN_LINES 行、MIN_TOKENS 個記號）。
//   2. 正規化：註解不是節點所以自然消失；識別字依首次出現編號，字串／數字／樣板常值換成類別記號，保留關鍵字與運算子。
//   3. 記號 5-gram 做 winnowing 取指紋，兩函式指紋集合的 Jaccard ≥ THRESHOLD 算一對。
//      選 winnowing 而非 AST 子樹雜湊：子樹雜湊對「多一條 if」這種局部修改整棵變色，
//      序列指紋則只損失附近幾個 gram，且可用倒排索引避免 O(n²) 全比對。
// 掃描範圍同 dup:check（非測試的產品原始碼）：測試的 arrange 區塊本來就刻意重複，納入只會製造雜訊。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { OWNER_HINT, productSourceFiles, root } from './dupLib.mjs';

export const THRESHOLD = 0.8;
export const MIN_LINES = 6; // 略過 5 行以下
export const MIN_TOKENS = 40;
const GRAM = 5;
const WINDOW = 4;
// 出現在太多函式裡的指紋是樣板（import 後的常見序列等），不用來找候選，但仍參與 Jaccard。
const COMMON_POSTING = 150;

const baselinePath = join(root, 'scripts', 'dup-near-baseline.json');

const fnv = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

/** 函式節點的正規化記號序列。 */
function normalizedTokens(fn, sf) {
  const ids = new Map();
  const out = [];
  const walk = (node) => {
    const kids = node.getChildren(sf);
    if (kids.length > 0) return kids.forEach(walk);
    switch (node.kind) {
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.PrivateIdentifier: {
        if (!ids.has(node.text)) ids.set(node.text, ids.size);
        return out.push(`I${ids.get(node.text)}`);
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.JsxText:
        return node.kind === ts.SyntaxKind.JsxText && node.containsOnlyTriviaWhiteSpaces ? undefined : out.push('S');
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.BigIntLiteral:
        return out.push('N');
      case ts.SyntaxKind.RegularExpressionLiteral:
        return out.push('R');
      case ts.SyntaxKind.EndOfFileToken:
        return undefined;
      default:
        return out.push(String(node.kind));
    }
  };
  walk(fn);
  return out;
}

/** winnowing：每個視窗取最小雜湊（同值取最右），回傳指紋集合。 */
export function fingerprints(tokens) {
  if (tokens.length < GRAM) return new Set();
  const grams = [];
  for (let i = 0; i + GRAM <= tokens.length; i++) grams.push(fnv(tokens.slice(i, i + GRAM).join(' ')));
  const picked = new Set();
  for (let i = 0; i + WINDOW <= grams.length; i++) {
    let min = i;
    for (let j = i + 1; j < i + WINDOW; j++) if (grams[j] <= grams[min]) min = j;
    picked.add(grams[min]);
  }
  return picked;
}

const jaccard = (a, b) => {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const h of small) if (big.has(h)) shared++;
  return shared / (a.size + b.size - shared);
};

/** 一個檔案裡的函式：{ name, start, end, tokens }。name 為 `Class.method`／變數名／`<anonymous>`，同名加 #n。 */
export function functionsInSource(text, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const nameOf = (node) => {
    const own = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      const cls = node.parent && ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : '';
      return `${cls}${own ?? 'constructor'}`;
    }
    if (own) return own;
    const p = node.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    return '<anonymous>';
  };
  const visit = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (end - start + 1 >= MIN_LINES) {
        const tokens = normalizedTokens(node, sf);
        if (tokens.length >= MIN_TOKENS) found.push({ name: nameOf(node), start, end, tokens });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const seen = new Map();
  for (const f of found) {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    if (n > 1) f.name = `${f.name}#${n}`;
  }
  return found;
}

/** 從已有的函式清單找近似對：[{ a, b, similarity }]，相似度大的在前。 */
export function findNearPairs(fns, threshold = THRESHOLD) {
  const prints = fns.map((f) => fingerprints(f.tokens));
  const postings = new Map();
  prints.forEach((set, i) => {
    for (const h of set) {
      if (!postings.has(h)) postings.set(h, []);
      postings.get(h).push(i);
    }
  });
  const pairs = [];
  for (let i = 0; i < fns.length; i++) {
    const counts = new Map();
    for (const h of prints[i]) {
      const list = postings.get(h);
      if (list.length > COMMON_POSTING) continue;
      for (const j of list) if (j > i) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
    for (const [j, shared] of counts) {
      // Jaccard ≥ t 至少需要 t·max(|A|,|B|) 個共同指紋，先用便宜的計數擋掉。
      if (shared < threshold * Math.max(prints[i].size, prints[j].size) * 0.9) continue;
      const a = fns[i];
      const b = fns[j];
      // 同一檔案中一個包著另一個（巢狀函式）不算重複。
      if (a.file === b.file && a.start <= b.end && b.start <= a.end) continue;
      const similarity = jaccard(prints[i], prints[j]);
      if (similarity >= threshold) pairs.push({ a, b, similarity });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

const label = (f) => `${f.file}:${f.name}`;
const pairKey = ({ a, b }) => [label(a), label(b)].sort().join(' <-> ');
const where = (f) => `${f.file}:${f.start}`;

/** { pairs, current: { 鍵: 相似度(兩位小數) } }。 */
export function scanNearDuplicates() {
  const fns = [];
  for (const file of productSourceFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const f of functionsInSource(readFileSync(file, 'utf8'), rel)) fns.push({ ...f, file: rel });
  }
  const pairs = findNearPairs(fns);
  const current = {};
  for (const p of pairs) current[pairKey(p)] = Number(p.similarity.toFixed(2));
  return { pairs, current };
}

const readBaseline = () => JSON.parse(readFileSync(baselinePath, 'utf8'));

export function writeNearBaseline(current) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([x], [y]) => (x < y ? -1 : 1)));
  writeFileSync(baselinePath, JSON.stringify({ pairs: sorted }, null, 2) + '\n');
}

export const describePair = (p) => `${p.similarity.toFixed(2)}  ${where(p.a)} ${p.a.name} <-> ${where(p.b)} ${p.b.name}`;

/** 新的函式對就失敗（附位置與相似度）；基準裡已不存在的只提醒降基準。 */
export function compareNearDuplicates({ pairs, current }) {
  const base = readBaseline().pairs;
  const errors = [];
  const notes = [];
  const added = pairs.filter((p) => !(pairKey(p) in base));
  if (added.length > 0) {
    errors.push(
      `新增了 ${added.length} 組近似重複的函式（正規化後相似度 ≥ ${THRESHOLD}，改變數名或註解不會消失）：`,
      ...added.map((p) => `  ${describePair(p)}`),
      OWNER_HINT,
      '若兩者是不同概念、只是寫法像，請調整其中一個的結構；確定是誤判的類型，才改 scripts/dupNearLib.mjs 的排除規則並寫理由。',
    );
  }
  const gone = Object.keys(base).filter((k) => !(k in current));
  if (gone.length > 0) notes.push(`近似重複變少了（${gone.length} 組）：請執行 npm run dup:near:baseline 把 scripts/dup-near-baseline.json 降下來。`);
  return { ok: errors.length === 0, errors, notes };
}
