// 只有真 Postgres 才有意義的後端測試（在 PGlite 上以 needsSecondConnection／needsPostgresServer／needsPgroonga 跳過，
// 定義與原因見 src/test/helpers/pgliteSkips.ts）。合併前在有真 Postgres 的機器上只跑這批：
//   npm run test:real-pg          跑這批檔案（需要 DATABASE_URL 指向 _test 資料庫）
//   npm run test:real-pg -- --list  只列出檔案
// 清單由標記自動找出，新增標記的測試不用另外登記。
// 另一個標記：檔案內寫一行 `// realPostgresAlso: <原因>`，給「PGlite 上也會過、但只有真 Postgres 才抓得到錯」的檔案
// （例如交易 client 與連線池是兩條連線的讀寫）。何時該標見 docs/agents/testing.md。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: a checkout path with non-ASCII characters (桌面) stays percent-encoded in .pathname.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MARKER = /\bneeds(SecondConnection|PostgresServer|Pgroonga)\b|^\s*\/\/ realPostgresAlso:/m;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function realPostgresTestFiles() {
  return walk(join(ROOT, "src/test"))
    .filter((file) => file.endsWith(".test.ts") && !file.includes("/helpers/") && MARKER.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = realPostgresTestFiles();
  if (process.argv.includes("--list")) {
    console.log(files.join("\n"));
  } else {
    const result = spawnSync("npx", ["vitest", "run", ...files, ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
}
