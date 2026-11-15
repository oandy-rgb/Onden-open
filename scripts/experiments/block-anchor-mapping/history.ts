// 取 docs/**/*.md 的真實編輯歷史：修改次數最多的 N 個檔案，每個檔案依序的全部不同版本。
// 只讀本 repo 的 git；不碰任何正式站資料。輸出 out/versions.json（不提交）。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, "out");
const root = join(here, "../../..");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 29 });

export type FileHistory = { path: string; versions: Array<{ commit: string; text: string }> };

/** 一個檔案（含改名）的全部不同版本，舊 → 新。 */
function versionsOf(path: string): FileHistory {
  const log = git(["log", "--follow", "--name-only", "--format=C %H", "--", path]).split("\n");
  const entries: Array<{ commit: string; path: string }> = [];
  let commit = "";
  for (const line of log) {
    if (line.startsWith("C ")) commit = line.slice(2);
    else if (line.trim() && commit) { entries.push({ commit, path: line.trim() }); commit = ""; }
  }
  entries.reverse();
  const versions: FileHistory["versions"] = [];
  for (const e of entries) {
    let text: string;
    try { text = git(["show", `${e.commit}:${e.path}`]); } catch { continue; }
    if (versions.length && versions[versions.length - 1]!.text === text) continue;
    versions.push({ commit: e.commit, text });
  }
  return { path, versions };
}

export function loadHistories(n = 30): FileHistory[] {
  const cache = join(OUT, `versions-${n}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  // 先用不追改名的次數粗篩前 3n 個候選，再用 --follow 的實際版本數取前 n。
  const counts = new Map<string, number>();
  for (const line of git(["log", "--name-only", "--format=", "--", "docs/*.md"]).split("\n")) {
    if (line.trim() && existsSync(join(root, line.trim()))) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1);
  }
  const candidates = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n * 3).map(([p]) => p);
  const all = candidates.map(versionsOf).filter((h) => h.versions.length >= 4);
  const top = all.sort((a, b) => b.versions.length - a.versions.length || a.path.localeCompare(b.path)).slice(0, n);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(cache, JSON.stringify(top));
  return top;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const h = loadHistories(Number(process.argv[2] ?? 30));
  for (const f of h) console.log(f.versions.length, f.path, Math.round(f.versions.at(-1)!.text.length / 1000) + "k");
}
