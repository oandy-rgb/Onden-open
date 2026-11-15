// Guard: 基準檔與例外清單只准減少（agent 不能手改數字或在例外陣列多加一條來過關）。
// 邏輯在 scripts/ratchetLib.mjs，`npm run ratchet:check` 跑同一份；規則與逃生門寫在那個檔的開頭。
// TS 例外清單用 `// ratchet:list <標籤>` 標記，才會被比對。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runRatchet, tsGroups } from "../../../../../scripts/ratchetLib.mjs";

describe("baselines and exception lists only shrink", () => {
  it("nothing grew since the merge-base with origin/main", () => {
    const result = runRatchet();
    expect(result.ok, result.errors.join("\n")).toBe(true);
  }, 120_000);
});

describe("the ratchet itself", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const put = (cwd: string, file: string, text: string) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const GUARD = "packages/backend/src/test/guards/x.guard.test.ts";
  const list = (...paths: string[]) => `// ratchet:list KEPT\nconst KEPT: Record<string, string> = {\n${paths.map((p) => `  "${p}": "why",`).join("\n")}\n};\n`;
  const BASELINE = "scripts/allowlist-baseline.json";

  /** main 有一份基準與一份例外清單；分支從它開出，回傳工作目錄。 */
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    put(dir, BASELINE, JSON.stringify({ "be-console": { "a.ts": 2 } }));
    put(dir, GUARD, list("a.ts", "b.ts"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "work");
    return dir;
  }
  const check = (dir: string) => runRatchet({ cwd: dir, mainRef: "main" });

  it("passes when nothing changed or entries only shrink", () => {
    const dir = repo();
    expect(check(dir).ok).toBe(true);
    put(dir, BASELINE, JSON.stringify({ "be-console": { "a.ts": 1 } }));
    put(dir, GUARD, list("a.ts"));
    expect(check(dir).ok).toBe(true);
  });

  it("fails when a baseline count grows or a file key is added under an existing rule", () => {
    const dir = repo();
    put(dir, BASELINE, JSON.stringify({ "be-console": { "a.ts": 3, "c.ts": 1 } }));
    const result = check(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("a.ts：計數變大（原本 2，現在 3）");
    expect(result.errors.join("\n")).toContain("c.ts：新增項目");
  });

  it("fails when an exception list gets a new entry", () => {
    const dir = repo();
    put(dir, GUARD, list("a.ts", "b.ts", "c.ts"));
    const result = check(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("#KEPT｜c.ts：新增項目");
  });

  it("allows a whole new rule group and a brand-new list", () => {
    const dir = repo();
    put(dir, BASELINE, JSON.stringify({ "be-console": { "a.ts": 2 }, "be-new-rule": { "z.ts": 9 } }));
    put(dir, GUARD, `${list("a.ts", "b.ts")}// ratchet:list OTHER\nconst OTHER = ["q.ts"];\n`);
    expect(check(dir).ok).toBe(true);
  });

  it("lets a ratchet-override trailer through and says so", () => {
    const dir = repo();
    put(dir, GUARD, list("a.ts", "b.ts", "c.ts"));
    git(dir, "commit", "-q", "-am", "widen\n\nratchet-override: 另一個 PR 正在改 c.ts");
    const result = check(dir);
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("ratchet-override");
  });

  it("compares against the merge-base, not the tip of main", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    put(dir, GUARD, list("a.ts")); // main 之後又縮小了一條；分支沒動，不該被判為新增
    git(dir, "commit", "-q", "-am", "main shrinks");
    git(dir, "checkout", "-q", "work");
    expect(check(dir).ok).toBe(true);
  });

  it("fails when the marker is removed but the list is still there", () => {
    const dir = repo();
    put(dir, GUARD, list("a.ts", "b.ts", "c.ts").replace("// ratchet:list KEPT\n", ""));
    const result = check(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("標記");
  });

  it("fails, saying to fetch, when the main ref does not exist", () => {
    const dir = repo();
    const result = runRatchet({ cwd: dir, mainRef: "nope" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/nope[\s\S]*git fetch/);
  });

  it.each([
    ["an allowlist table under guards/allowlist", "packages/frontend/src/test/guards/allowlist/owners.ts", list("a.ts"), list("a.ts", "z.ts")],
    ["the a11y baseline", "packages/frontend/src/test/a11y/baseline.ts", list("a.ts"), list("a.ts", "z.ts")],
    ["a scan test's marked list outside the guards folders", "packages/backend/src/test/helpers/sweepWriteBodies.ts", list("a.ts"), list("a.ts", "z.ts")],
    ["the PGlite skip list", "packages/backend/src/test/helpers/pgliteSkipList.ts", list("a.ts"), list("a.ts", "z.ts")],
    ["the layout-audit baseline", "packages/frontend/e2e/layout-audit/baseline.json", JSON.stringify({ violations: [{ rule: "R1" }] }), JSON.stringify({ violations: [{ rule: "R1" }, { rule: "R2" }] })],
    ["the bench budgets", "bench-budgets.json", JSON.stringify({ metrics: { a: { median: 10 } } }), JSON.stringify({ metrics: { a: { median: 11 } } })],
  ])("also watches %s", (_name, file, before, after) => {
    const dir = repo();
    git(dir, "checkout", "-q", "main");
    put(dir, file, before);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add");
    git(dir, "checkout", "-q", "-B", "work2");
    expect(check(dir).ok).toBe(true);
    put(dir, file, after);
    expect(check(dir).ok).toBe(false);
  });

  it("reads keys, counts, comments and strings with brackets in a marked literal", () => {
    const text = [
      "// ratchet:list A",
      'const A: Record<string, { count: number; reason: string }> = {',
      '  "a.ts": { count: 2, reason: "has ] and { inside, and, commas" }, // trailing, comment',
      '  "b.ts": { count: 1, reason: `${X}; y` },',
      "};",
      "// ratchet:list B",
      "rule.temporary = [NAV, \"c.ts\"];",
    ].join("\n");
    const groups = tsGroups("f.ts", text);
    expect([...groups.get("f.ts#A")!]).toEqual([["a.ts", 2], ["b.ts", 1]]);
    expect([...groups.get("f.ts#B")!]).toEqual([["NAV", 1], ["c.ts", 1]]);
  });
});
