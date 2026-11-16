// The document checker (scripts/check-md-links.mjs): "a document says something the code no longer says".
// Each check is exercised on fixture markdown in a temp directory, not on the real docs
// (docs.guard.test.ts runs the real ones).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRemovedPath, linkPattern, loadRemovedRules } from "../../../../../scripts/public-mirror/removedPaths.mjs";
import {
  baselineValue, checkCodeRefs, checkCovers, checkDocs, checkNumbers, checkStatus, coveredCheck, docsSkipReasons, docsSkipRequested, globToRegExp,
  implementedProposals, lastTouched, listFiles, loadSuperseded, matchesAny, oldProposals, parseHead, summary, uncoveredChanges, wantsCodeRefs,
} from "../../../../../scripts/check-md-links.mjs";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A temp repo root holding the given files. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const messages = (r: { line: number; message: string }[]) => r.map((p) => p.message);
const refs = (root: string, f: string, text: string) => checkCodeRefs(root, f, text, listFiles(root));
const CODE = {
  "packages/backend/src/lib/rowAge.ts": "export function isOlderCopy() {}\nexport const X = 1;\n",
  "packages/backend/src/spine/a.ts": "line1\nline2\nline3\n",
  "packages/backend/db/migrations/146_note_link_index.sql": "select 1;\n",
  "packages/frontend/src/lib/x.ts": "export const y = 1;\n",
  "scripts/tool.mjs": "",
};

describe("1 code references must exist", () => {
  const root = fixture(CODE);
  it("accepts repo paths that exist and flags the ones that do not", () => {
    expect(refs(root, "docs/a.md", "see `scripts/tool.mjs` and `packages/backend/src/spine/a.ts`")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "gone: `scripts/old.mjs`"))).toEqual(["missing path -> scripts/old.mjs"]);
    expect(messages(refs(root, "docs/a.md", "run `node scripts/old.mjs --flag`"))).toEqual(["missing path -> scripts/old.mjs"]);
  });
  it("checks that path:line has that many lines (also lists and ranges)", () => {
    expect(refs(root, "docs/a.md", "`packages/backend/src/spine/a.ts:3`")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "`packages/backend/src/spine/a.ts:4`"))[0]).toMatch(/line out of range/);
    expect(messages(refs(root, "docs/a.md", "`packages/backend/src/spine/a.ts:1,2-9`"))[0]).toMatch(/line out of range/);
  });
  it("resolves src/… inside a package the document names, and skips it when none is named", () => {
    expect(refs(root, "docs/a.md", "in packages/backend, `src/lib/rowAge.ts`")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "in packages/backend, `src/lib/gone.ts`"))).toEqual(["missing path -> packages/backend/src/lib/gone.ts"]);
    expect(refs(root, "docs/a.md", "`src/lib/gone.ts` and nothing says which package")).toEqual([]);
    expect(refs(root, "packages/frontend/README.md", "`src/lib/x.ts`")).toEqual([]);
    expect(refs(root, "packages/frontend/README.md", "`src/lib/gone.ts`")).toHaveLength(1);
  });
  it("accepts a path that exists in any named package", () => {
    expect(refs(root, "docs/a.md", "packages/backend and packages/frontend: `src/lib/x.ts`")).toEqual([]);
  });
  it("checks db/migrations paths and 'migration NNN' numbers", () => {
    expect(refs(root, "docs/a.md", "`db/migrations/146_note_link_index.sql`, migration 146")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "`db/migrations/999_gone.sql`"))).toEqual(["missing path -> packages/backend/db/migrations/999_gone.sql"]);
    expect(messages(refs(root, "docs/a.md", "see migration 999 and migration 146"))).toEqual(["missing migration -> 999"]);
    expect(messages(refs(root, "docs/a.md", "migration 第 999 號"))).toEqual(["missing migration -> 999"]);
    expect(refs(root, "docs/a.md", "第 999 號 PR")).toEqual([]);
  });
  it("finds `file.ts` `name` identifiers by plain text search", () => {
    expect(refs(root, "docs/a.md", "`lib/rowAge.ts` `isOlderCopy`")).toEqual([]);
    expect(refs(root, "docs/a.md", "`lib/rowAge.ts` 的 `isOlderCopy()`／`X`")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "`lib/rowAge.ts` `isNewerCopy`"))).toEqual(["identifier not found -> `isNewerCopy` 不在 packages/backend/src/lib/rowAge.ts"]);
  });
  it("does not read a list as 'this file has these names'", () => {
    expect(refs(root, "docs/a.md", "`lib/rowAge.ts`、`someOtherName`")).toEqual([]);
    expect(refs(root, "docs/a.md", "`lib/rowAge.ts` is used by `unrelatedThing`")).toEqual([]);
  });
  it("skips placeholders, globs of existing folders, generated output and code fences", () => {
    expect(refs(root, "docs/a.md", "`packages/<name>/src`, `db/migrations/NNN_x.sql`, `docs/YYYY-MM-DD.md`, `packages/backend/src/**/*.ts`")).toEqual([]);
    expect(refs(root, "docs/a.md", "`packages/frontend/dist/index.js`, `packages/pairing/node_modules/x`, `packages/desktop/.cache/`")).toEqual([]);
    expect(refs(root, "docs/a.md", "```\nscripts/old.mjs\n```\n")).toEqual([]);
    expect(messages(refs(root, "docs/a.md", "`packages/nope/src/**/*.ts`"))).toEqual(["missing directory -> packages/nope/src/（在 `packages/nope/src/**/*.ts`）"]);
  });
  it("reports the line the reference is on", () => {
    expect(refs(root, "docs/a.md", "ok\n\n`scripts/old.mjs`")[0].line).toBe(3);
  });
});

describe("whole-repo run: which documents are checked, and the exception list", () => {
  const status = (s: string) => `# T\n\n> 狀態：${s}\n\n`;
  const root = fixture({
    ...CODE,
    "docs/current.md": `${status("現行（最後確認 2026-11-16）")}\`scripts/old.mjs\``,
    "docs/history.md": `${status("歷史紀錄")}\`scripts/old.mjs\``,
    "docs/proposal.md": `${status("提案（2026-11-01）")}\`scripts/old.mjs\``,
    "docs/replaced.md": `${status("已被取代（見 [x](current.md)）")}\`scripts/old.mjs\``,
    "docs/archive/old.md": "`scripts/old.mjs`",
    "packages/backend/AGENTS.md": "`scripts/old.mjs`",
    "packages/backend/src/README.md": "`scripts/old.mjs`",
    "src-notes.md": "`scripts/old.mjs`",
    "docs/agents/rule.md": `${status("歷史紀錄")}\`scripts/old.mjs\``,
  });
  it("checks 現行 documents, AGENTS.md, package READMEs and docs/agents; exempts the rest", () => {
    const r = checkDocs(root, { baseline: { noCoverage: ["docs/current.md"] } });
    expect(r.problems.codeRefs.map((p) => p.f).sort()).toEqual(["docs/agents/rule.md", "docs/current.md", "packages/backend/AGENTS.md", "packages/backend/src/README.md"]);
    expect(wantsCodeRefs("docs/history.md", parseHead(status("歷史紀錄")))).toBe(false);
  });
  it("lets a listed document through, and refuses a listed document that now passes or is gone", () => {
    const listed = checkDocs(root, { baseline: { noCoverage: ["docs/current.md"], codeReferences: { "docs/current.md": "reason", "docs/agents/rule.md": "r", "packages/backend/AGENTS.md": "r", "packages/backend/src/README.md": "r" } } });
    expect(listed.problems.codeRefs).toEqual([]);
    expect(listed.total).toBe(0);
    const fixed = fixture({ ...CODE, "docs/current.md": `${status("現行（最後確認 2026-11-16）")}\`scripts/tool.mjs\`` });
    expect(messages(checkDocs(fixed, { baseline: { codeReferences: { "docs/current.md": "r" } } }).problems.exceptions)[0]).toMatch(/已登記為例外但現在查得過/);
    expect(messages(checkDocs(fixed, { baseline: { codeReferences: { "docs/gone.md": "r" } } }).problems.exceptions)[0]).toMatch(/文件不存在/);
  });
  it("summary names every count", () => {
    expect(summary(checkDocs(root, { baseline: { noCoverage: ["docs/current.md"] } }))).toMatch(/\d+ markdown files checked, 0 broken link\(s\), 0 status line problem\(s\), 4 stale code reference\(s\)/);
  });
});

describe("2 status line everywhere it matters", () => {
  const root = fixture({ "docs/x.md": "", "docs/current.md": "" });
  const check = (f: string, text: string) => messages(checkStatus(root, f, parseHead(text), new Set(listFiles(root))));
  it("requires a status line under docs/ except archive, pr-assets and screenshots", () => {
    const r = checkDocs(fixture({
      "docs/a.md": "# A\n", "docs/agents/b.md": "# B\n", "docs/archive/c.md": "# C\n", "docs/pr-assets/d.md": "# D\n", "README.md": "# R\n",
    }));
    expect(r.problems.status.map((p) => p.f).sort()).toEqual(["docs/a.md", "docs/agents/b.md"]);
  });
  it("現行 does not need a date: the date was text nothing checked (coverage is what ties a document to code)", () => {
    expect(check("docs/x.md", "# T\n\n> 狀態：現行\n")).toEqual([]);
    expect(check("docs/x.md", "# T\n\n> 狀態：現行（最後確認 2026-11-16）\n")).toEqual([]);
  });
  it("已被取代 points at what replaced it", () => {
    expect(check("docs/x.md", "> 狀態：已被取代（2026-11-02）\n")).toHaveLength(1);
    expect(check("docs/x.md", "> 狀態：已被取代（見 [y](y.md)）\n")).toEqual([]);
    expect(check("docs/x.md", "> 狀態：已被取代（見 `docs/current.md`）\n")).toEqual([]);
  });
  it("accepts 歷史紀錄 and 提案 as they are", () => {
    expect(check("docs/x.md", "> 狀態：歷史紀錄\n")).toEqual([]);
    expect(check("docs/x.md", "> 狀態：提案，業主已回答第 9 節\n")).toEqual([]);
  });
});

describe("3 a proposal does not stay a proposal forever", () => {
  const root = fixture({ "docs/x.md": "", "docs/current.md": "" });
  const check = (text: string) => messages(checkStatus(root, "docs/p.md", parseHead(text), new Set(listFiles(root))));
  it("完成後 names an existing document or 歸檔, and only on a proposal", () => {
    expect(check("> 狀態：提案（2026-11-01）\n> 完成後：docs/current.md\n")).toEqual([]);
    expect(check("> 狀態：提案（2026-11-01）\n> 完成後：歸檔\n")).toEqual([]);
    expect(check("> 狀態：提案（2026-11-01）\n> 完成後：docs/never.md\n")).toEqual(["完成後 指向不存在的文件 -> docs/never.md"]);
    expect(check("> 狀態：歷史紀錄\n> 完成後：歸檔\n")).toEqual(["「> 完成後：」只用在狀態為提案的文件"]);
  });
  it("reports proposals not touched for 60 days: last commit date first, then header date, then file-name date; never fails", () => {
    const doc = (f: string, text: string, touched: string | null = null) => ({ f, head: parseHead(text), touched });
    const now = new Date("2026-12-01T00:00:00Z");
    const list = oldProposals([
      doc("docs/old-2026-10-01.md", "> 狀態：提案\n"),
      doc("docs/header.md", "> 狀態：提案（2026-09-15）\n"),
      doc("docs/renamed-2026-01-01.md", "> 狀態：提案\n", "2026-11-20"),
      doc("docs/edited-recently.md", "> 狀態：提案（2026-01-01）\n", "2026-11-25"),
      doc("docs/fresh-2026-11-25.md", "> 狀態：提案\n"),
      doc("docs/undated.md", "> 狀態：提案\n"),
      doc("docs/stale-by-commit.md", "> 狀態：提案\n", "2026-08-01"),
      doc("docs/current-2026-01-01.md", "> 狀態：現行\n"),
    ], now);
    expect(list.map((p) => [p.f, p.age, p.source])).toEqual([
      ["docs/undated.md", null, null], ["docs/stale-by-commit.md", 122, "最後改動"], ["docs/header.md", 77, "檔頭日期"], ["docs/old-2026-10-01.md", 61, "檔名日期"],
    ]);
    const r = checkDocs(fixture({ "docs/old-2026-01-01.md": "> 狀態：提案\n" }), { now });
    expect(r.total).toBe(0);
    expect(r.oldProposals).toHaveLength(1);
  });
  it("reads the age from git history: the last commit that touched the file", () => {
    const root = fixture({ "docs/p.md": "> 狀態：提案（2020-01-01）\n", "docs/q.md": "x\n" });
    expect(lastTouched(root, "docs/p.md")).toBeNull();
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z", GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z" } });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "p");
    expect(lastTouched(root, "docs/p.md")).toBe("2026-10-01");
    const r = checkDocs(root, { now: new Date("2026-12-01T00:00:00Z") });
    expect(r.oldProposals.map((p) => [p.f, p.source, p.age])).toEqual([["docs/p.md", "最後改動", 61]]);
  });
});

describe("4 covered code", () => {
  const docs = [
    { f: "docs/restore.md", head: parseHead("> 狀態：現行（最後確認 2026-11-16）\n> 涵蓋：packages/backend/src/services/eventRestore/**, scripts/deploy-vps.sh\n") },
    { f: "docs/other.md", head: parseHead("> 狀態：現行（最後確認 2026-11-16）\n") },
  ];
  const mod = (path: string) => ({ status: "M", path });
  it("matches globs the way the doc writes them", () => {
    expect(globToRegExp("a/**").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("a/**/c.ts").test("a/c.ts")).toBe(true);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
    expect(globToRegExp("a/{b,c}.ts").test("a/c.ts")).toBe(true);
    expect(globToRegExp("a/b.ts").test("a/bxts")).toBe(false);
    expect(matchesAny(["packages/x/"], "packages/x/y/z.ts")).toBe(true);
  });
  it("names the document when covered code changed and the document did not", () => {
    expect(uncoveredChanges(docs, [mod("packages/backend/src/services/eventRestore/restore.ts")])).toEqual([
      { doc: "docs/restore.md", globs: ["packages/backend/src/services/eventRestore/**"], files: ["packages/backend/src/services/eventRestore/restore.ts"] },
    ]);
    expect(uncoveredChanges(docs, [mod("scripts/deploy-vps.sh")])).toHaveLength(1);
  });
  it("passes when the document changed too, or only tests / unrelated files changed", () => {
    expect(uncoveredChanges(docs, [mod("scripts/deploy-vps.sh"), mod("docs/restore.md")])).toEqual([]);
    expect(uncoveredChanges(docs, [mod("packages/backend/src/services/eventRestore/restore.test.ts"), mod("packages/backend/src/test/x.ts")])).toEqual([]);
    expect(uncoveredChanges(docs, [mod("packages/frontend/src/a.ts")])).toEqual([]);
  });
  it("a 涵蓋 glob that matches no file is a failure; 涵蓋 on a non-現行 document too", () => {
    const root = fixture({ "docs/a.md": "# A\n\n> 狀態：現行（最後確認 2026-11-16）\n> 涵蓋：gone/**\n", "docs/b.md": "# B\n\n> 狀態：歷史紀錄\n> 涵蓋：docs/**\n" });
    expect(messages(checkDocs(root).problems.covers).sort()).toEqual(["「> 涵蓋：」只用在狀態為現行的文件", "涵蓋 的 glob 沒有對到任何檔案 -> gone/**"]);
  });
  it("reads the opt-out like the change-note check, with a reason", () => {
    expect(docsSkipRequested(["--skip"], {})).toBe(true);
    expect(docsSkipRequested([], { DOCS_SKIP: "1" })).toBe(true);
    expect(docsSkipRequested([], { PR_BODY: "說明\n文件不需要更新：只改內部命名\n" })).toBe(true);
    expect(docsSkipRequested([], {}, ["Fix x\n\n文件不需要更新：行為沒變\n"])).toBe(true);
    expect(docsSkipRequested([], { PR_BODY: "文件不需要更新：" })).toBe(false);
    expect(docsSkipRequested([], { PR_BODY: "我覺得文件不需要更新：因為" })).toBe(false);
    expect(docsSkipRequested([], {}, ["no mention"])).toBe(false);
  });

  describe("against a real git history (the PR-time step)", () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    const repo = () => {
      const root = fixture({
        "docs/restore.md": "# R\n\n> 狀態：現行（最後確認 2026-11-16）\n> 涵蓋：src/restore/**\n",
        "src/restore/a.ts": "1\n",
      });
      git(root, "init", "-q", "-b", "main");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "base");
      git(root, "checkout", "-q", "-b", "work");
      return root;
    };
    it("fails naming the document, passes with the document, passes with the opt-out in a commit message", () => {
      const root = repo();
      writeFileSync(join(root, "src/restore/a.ts"), "2\n");
      git(root, "commit", "-qam", "change code");
      const failed = coveredCheck(root, { base: "main" });
      expect(failed.code).toBe(1);
      expect(failed.lines.join("\n")).toContain("docs/restore.md");
      expect(failed.lines.join("\n")).toContain("src/restore/a.ts");
      writeFileSync(join(root, "docs/restore.md"), "# R\n\n> 狀態：現行（最後確認 2026-11-17）\n> 涵蓋：src/restore/**\n");
      git(root, "commit", "-qam", "update doc");
      expect(coveredCheck(root, { base: "main" }).code).toBe(0);
      const other = repo();
      writeFileSync(join(other, "src/restore/a.ts"), "2\n");
      git(other, "commit", "-qam", "change code\n\n文件不需要更新：只改變數名稱");
      expect(coveredCheck(other, { base: "main" }).code).toBe(0);
      expect(coveredCheck(other, { base: "no-such-ref" }).code).toBe(2);
    });
  });
});

describe("5 numbers", () => {
  const root = fixture({
    "scripts/base.json": JSON.stringify({ a: { "x.ts": 3, "y.ts": 1 }, "rule.with.dots": { "f.ts": 2 }, n: 687, list: [1, 2, 3] }),
    "scripts/budget.mjs": "export const BOOT_BUDGET_GZIP = 310_204;\n",
  });
  it("reads JSON values (number, key count, array length, dotted keys) and constants", () => {
    expect(baselineValue(root, "scripts/base.json#n")).toBe(687);
    expect(baselineValue(root, "scripts/base.json#a")).toBe(2);
    expect(baselineValue(root, "scripts/base.json#list")).toBe(3);
    expect(baselineValue(root, "scripts/base.json#rule.with.dots")).toBe(1);
    expect(baselineValue(root, "scripts/base.json#a.x.ts")).toBe(3);
    expect(baselineValue(root, "scripts/base.json#missing")).toBeUndefined();
    expect(baselineValue(root, "scripts/budget.mjs#BOOT_BUDGET_GZIP")).toBe(310204);
    expect(baselineValue(root, "scripts/none.json#n")).toBeUndefined();
  });
  it("compares the number before the comment with the baseline", () => {
    expect(checkNumbers(root, "共 687 個名稱 <!-- check: scripts/base.json#n -->")).toEqual([]);
    expect(checkNumbers(root, "預算 310,204 B <!-- check: scripts/budget.mjs#BOOT_BUDGET_GZIP -->")).toEqual([]);
    expect(messages(checkNumbers(root, "共 700 個名稱 <!-- check: scripts/base.json#n -->"))).toEqual(["數字過時：文件寫 700，scripts/base.json#n 現在是 687"]);
    expect(messages(checkNumbers(root, "共 1 個 <!-- check: scripts/base.json#gone -->"))).toEqual(["check 指向不存在的值 -> scripts/base.json#gone"]);
    expect(messages(checkNumbers(root, "沒有數字 <!-- check: scripts/base.json#n -->"))).toEqual(["check 前面找不到數字 -> scripts/base.json#n"]);
    expect(checkNumbers(root, "範例：`7 <!-- check: scripts/base.json#n -->`\n```\n7 <!-- check: x#y -->\n```\n")).toEqual([]);
  });
});

describe("現行 documents declare what they cover, or are listed (and the list only shrinks)", () => {
  const cur = "# T\n\n> 狀態：現行\n";
  const root = fixture({
    "src/a.ts": "x\n",
    "docs/covered.md": `${cur}> 涵蓋：src/**\n`,
    "docs/bare.md": cur,
    "docs/generated.md": `${cur}\n<!-- 由 npm run catalog 產生 -->\n`,
    "docs/history.md": "# H\n\n> 狀態：歷史紀錄\n",
  });
  it("fails a 現行 document with no 涵蓋 unless it is listed; generated, covered and non-現行 documents are fine", () => {
    const r = checkDocs(root);
    expect(r.problems.covers.map((p) => p.f)).toEqual(["docs/bare.md"]);
    expect(checkDocs(root, { baseline: { noCoverage: ["docs/bare.md"] } }).total).toBe(0);
  });
  it("asks to remove a list entry once the document is covered, is not 現行 any more, or is gone", () => {
    const r = checkDocs(root, { baseline: { noCoverage: ["docs/bare.md", "docs/covered.md", "docs/history.md", "docs/gone.md"] } });
    expect(r.problems.exceptions.map((p) => p.f).sort()).toEqual(["docs/covered.md", "docs/gone.md", "docs/history.md"]);
  });
});

describe("superseded registry: things still in the repo that something else replaced", () => {
  const entry = { paths: ["packages/old/**"], replacedBy: "packages/new/", pr: "#1" };
  const root = fixture({ "packages/old/a.ts": "x\n", "packages/new/b.ts": "x\n", "docs/cur.md": "# C\n\n> 狀態：現行\n> 涵蓋：packages/new/**\n" });
  it("fails a code reference to a superseded path even though the file exists", () => {
    expect(messages(checkCodeRefs(root, "docs/cur.md", "`packages/old/a.ts`", listFiles(root), { superseded: [entry] }))).toEqual(["superseded path -> packages/old/a.ts（已被取代：packages/new/（#1））"]);
    expect(checkCodeRefs(root, "docs/cur.md", "`packages/new/b.ts`", listFiles(root), { superseded: [entry] })).toEqual([]);
    expect(checkCodeRefs(root, "docs/cur.md", "`packages/old/a.ts`", listFiles(root))).toEqual([]);
  });
  it("fails a 涵蓋 glob that points at a superseded path", () => {
    expect(messages(checkCovers(parseHead("> 狀態：現行\n> 涵蓋：packages/old/**\n"), listFiles(root), [entry]))).toEqual(["涵蓋 指到已被取代的東西 -> packages/old/**（已被取代：packages/new/（#1））"]);
    expect(messages(checkCovers(parseHead("> 狀態：現行\n> 涵蓋：packages/old/a.ts\n"), listFiles(root), [entry]))).toHaveLength(1);
    expect(checkCovers(parseHead("> 狀態：現行\n> 涵蓋：packages/new/**\n"), listFiles(root), [entry])).toEqual([]);
  });
  it("is read from scripts/docs-superseded.json and must say what replaced it and in which PR", () => {
    expect(loadSuperseded(root)).toEqual([]);
    const withFile = fixture({ "scripts/docs-superseded.json": JSON.stringify({ entries: [entry] }) });
    expect(loadSuperseded(withFile)).toEqual([entry]);
    const bad = fixture({ "scripts/docs-superseded.json": JSON.stringify({ entries: [{ paths: ["a"], replacedBy: "b" }] }) });
    expect(() => loadSuperseded(bad)).toThrow(/replacedBy、pr/);
    expect(checkDocs(root, { superseded: [entry] }).problems.covers.map((p) => p.f)).toEqual([]);
  });
});

describe("the opt-out is printed, and 實作提案 names the proposal a PR implements", () => {
  it("collects the reasons and the named proposals from the PR text and the commit messages", () => {
    expect(docsSkipReasons({ PR_BODY: "x\n文件不需要更新：只改命名\n" }, ["y\n\n文件不需要更新：行為沒變\n", "none"])).toEqual(["只改命名", "行為沒變"]);
    expect(docsSkipReasons({}, [])).toEqual([]);
    expect(implementedProposals({ PR_BODY: "實作提案：docs/p.md\n" }, ["z\n\n實作提案：`docs/q.md`\n"])).toEqual(["docs/p.md", "docs/q.md"]);
    expect(implementedProposals({ PR_BODY: "實作提案說明" }, [])).toEqual([]);
  });

  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  const repo = () => {
    const root = fixture({
      "docs/restore.md": "# R\n\n> 狀態：現行\n> 涵蓋：src/restore/**\n",
      "docs/plan.md": "# P\n\n> 狀態：提案（2026-11-01）\n",
      "src/restore/a.ts": "1\n",
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "work");
    writeFileSync(join(root, "src/restore/a.ts"), "2\n");
    git(root, "commit", "-qam", "change code");
    return root;
  };

  it("lets the line through but prints the document, the glob, the changed files and the reason", () => {
    const root = repo();
    const r = coveredCheck(root, { base: "main", env: { PR_BODY: "文件不需要更新：只是內部命名" } });
    expect(r.code).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("docs/restore.md（涵蓋：src/restore/**）");
    expect(text).toContain("src/restore/a.ts");
    expect(text).toContain("只是內部命名");
    expect(coveredCheck(root, { base: "main", argv: ["--skip"] }).lines.join("\n")).toContain("沒有寫原因");
  });

  it("fails a named proposal that is still a proposal and was not touched; passes once it is touched or has moved on", () => {
    const root = repo();
    const env = { PR_BODY: "文件不需要更新：x\n實作提案：docs/plan.md" };
    const failed = coveredCheck(root, { base: "main", env });
    expect(failed.code).toBe(1);
    expect(failed.lines.join("\n")).toContain("在這個 PR 裡仍是「提案」");
    expect(coveredCheck(root, { base: "main", env: { PR_BODY: "文件不需要更新：x\n實作提案：docs/gone.md" } }).code).toBe(1);
    writeFileSync(join(root, "docs/plan.md"), "# P\n\n> 狀態：提案（2026-11-01）\n> 完成後：docs/restore.md\n");
    git(root, "commit", "-qam", "touch the proposal");
    expect(coveredCheck(root, { base: "main", env }).code).toBe(0);
    const done = repo();
    writeFileSync(join(done, "docs/plan.md"), "# P\n\n> 狀態：現行\n");
    git(done, "commit", "-qam", "done");
    git(done, "checkout", "-q", "main");
    git(done, "merge", "-q", "work");
    expect(coveredCheck(done, { base: "HEAD~2", env: { PR_BODY: "文件不需要更新：x\n實作提案：docs/plan.md" } }).code).toBe(0);
  });

  it("does not check proposals when no line names one", () => {
    expect(coveredCheck(repo(), { base: "main", env: { PR_BODY: "文件不需要更新：x" } }).lines.join("\n")).not.toContain("實作提案");
  });
});

describe("public mirror: paths the mirror removes are not stale in the mirror tree", () => {
  const rules = { files: ["docs/deploy-log.md"], prefixes: ["docs/research/scan/"], imagesUnder: ["docs/"], imageExtensions: ["png"] };
  const cur = "# T\n\n> 狀態：現行\n> 涵蓋：src/**\n";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  /** A private tree committed, then the mirror's removals applied to the working tree (what public-push.sh leaves). */
  const mirror = () => {
    const root = fixture({
      "scripts/public-mirror/removed-paths.json": JSON.stringify(rules),
      "src/a.ts": "x\n",
      "docs/deploy-log.md": "log\n",
      "docs/research/scan/one.md": `${cur}\n`,
      "docs/shots/a.png": "p",
      "docs/shots/b.png": "p",
      "docs/mixed/a.png": "p",
      "docs/mixed/notes.md": "# N\n\n> 狀態：歷史紀錄\n",
      "docs/real.md": "# R\n\n> 狀態：歷史紀錄\n",
      "docs/guide.md": `${cur}\n\`docs/deploy-log.md\`、\`docs/research/scan/\`、\`docs/research/scan/one.md\`、\`docs/shots/\`、\`docs/shots/a.png\`\n`,
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "private");
    for (const p of ["docs/deploy-log.md", "docs/research/scan", "docs/shots", "docs/mixed/a.png"]) rmSync(join(root, p), { recursive: true }); // git leaves no empty folders
    return root;
  };
  const baseline = { noCoverage: [] as string[] };

  it("passes: a missing path that matches the list, or a folder whose tracked files are all removed, is not stale", () => {
    const r = checkDocs(mirror(), { baseline });
    expect(r.problems.codeRefs).toEqual([]);
    expect(r.total).toBe(0);
  });
  it("still fails a missing path the list does not name, and a folder that also held a kept file", () => {
    const root = mirror();
    writeFileSync(join(root, "docs/guide.md"), `${cur}\n\`docs/real.md\` \`docs/mixed/\` \`docs/shots/\`\n`);
    rmSync(join(root, "docs/real.md"));
    rmSync(join(root, "docs/mixed"), { recursive: true });
    expect(messages(checkDocs(root, { baseline }).problems.codeRefs)).toEqual(["missing path -> docs/real.md", "missing path -> docs/mixed/"]);
  });
  it("in the private tree, where the path exists, nothing is skipped; a path that is gone and not in the list fails", () => {
    const root = fixture({ "scripts/public-mirror/removed-paths.json": JSON.stringify(rules), "docs/guide.md": `${cur}\n\`docs/deploy-log.md\` \`docs/nope.md\`\n`, "docs/deploy-log.md": "log\n", "src/a.ts": "x\n" });
    expect(messages(checkDocs(root, { baseline }).problems.codeRefs)).toEqual(["missing path -> docs/nope.md"]);
  });
  // What the public repo's CI checks out: the stripped tree IS the commit, so HEAD no longer knows the folder that held
  // only images (first real public run of this check, 43967397937: day-timeline.md and site-boxes named such folders).
  it("passes on the mirror's own commit: an image-only folder is gone from HEAD too", () => {
    const root = mirror();
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "public");
    const r = checkDocs(root, { baseline });
    expect(messages(r.problems.codeRefs)).toEqual([]);
  });
  it("in the private tree a folder that is in neither the files nor HEAD still fails, images root or not", () => {
    const root = fixture({ "scripts/public-mirror/removed-paths.json": JSON.stringify(rules), "docs/guide.md": `${cur}\n\`docs/never-was/\`\n`, "docs/deploy-log.md": "log\n", "src/a.ts": "x\n" });
    git(root, "init", "-q", "-b", "main"); git(root, "add", "-A"); git(root, "commit", "-q", "-m", "private");
    expect(messages(checkDocs(root, { baseline }).problems.codeRefs)).toEqual(["missing path -> docs/never-was/"]);
  });
  it("a list entry for a document the mirror removes is not 'gone' in the mirror", () => {
    const root = mirror();
    const r = checkDocs(root, { baseline: { noCoverage: ["docs/research/scan/one.md", "docs/real.md"] } });
    expect(r.problems.exceptions.map((p) => p.f)).toEqual(["docs/real.md"]);
  });
});

describe("removed-paths.json: what the mirror leaves out (one list for push, verify and the checker)", () => {
  const rules = loadRemovedRules(join(dirname(fileURLToPath(import.meta.url)), "../../../../.."), { required: true });
  it("covers docs images, the scan folder and the deploy log, and nothing else", () => {
    for (const p of ["docs/a/b.PNG", "docs/x.webp", "docs/research/scan-2026-11-14/01-editor.md", "docs/research/scan-2026-11-14/", "docs/research/scan-2026-11-14", "docs/deploy-log.md"]) expect(isRemovedPath(rules, p), p).toBe(true);
    for (const p of ["docs/agents/deploy.md", "packages/frontend/public/icon.png", "docs/research/scan-2026-11-14-notes.md", "docs/README.md"]) expect(isRemovedPath(rules, p), p).toBe(false);
  });
  it("the egrep pattern verify.sh uses names the same paths", () => {
    const re = new RegExp(linkPattern(rules));
    expect(re.test("see docs/shots/a.png")).toBe(true);
    expect(re.test("see docs/research/scan-2026-11-14/x.md")).toBe(true);
    expect(re.test("see docs/agents/deploy.md")).toBe(false);
    // Links in a document are relative: these are real lines of the mirror's diff (2026-11-17), which a pattern made of
    // full repo paths did not match, so verify.sh refused a correct mirror.
    expect(re.test("+8. 在 [deploy-log.md](../deploy-log.md) 加一列")).toBe(true);
    expect(re.test("+> 掃描：[09-ink-pdf.md](scan-2026-11-14/09-ink-pdf.md) S1")).toBe(true);
    expect(re.test("+| [deploy-log.md](deploy-log.md) | 每次部署一列的紀錄 |")).toBe(true);
  });
  it("refuses to run without the file when required (an empty list would push everything)", () => {
    expect(() => loadRemovedRules(fixture({}), { required: true })).toThrow(/不推/);
    expect(loadRemovedRules(fixture({}))).toEqual({ files: [], prefixes: [], imagesUnder: [], imageExtensions: [] });
  });
});
