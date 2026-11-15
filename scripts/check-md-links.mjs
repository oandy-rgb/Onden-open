#!/usr/bin/env node
// Checks that relative links in tracked Markdown files point at existing files.
// Usage: node scripts/check-md-links.mjs   (run from anywhere in the repo)
// Skips http(s)/mailto links, pure #anchors, fenced code and inline code.
// Anchors after a path are not verified; only the file (or directory) must exist.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./lib/paths.mjs";

const root = repoRoot;
const files = execSync("git ls-files -co --exclude-standard '*.md'", { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => existsSync(join(root, f)));

// Archived verbatim on purpose; its links to files that stayed in docs/research are not rewritten.
const FROZEN = new Set(["docs/archive/vps-tailscale-http-2026-09-28.md"]);

// docs/research 與 docs/architecture 的文件檔頭必須有狀態行（現行／提案／已被取代／歷史紀錄）。
const STATUS_DIRS = ["docs/research/", "docs/architecture/"];
const STATUS_LINE = /^> 狀態：(現行|提案|已被取代|歷史紀錄)/m;
let missingStatus = 0;
for (const f of files) {
  if (!STATUS_DIRS.some((d) => f.startsWith(d))) continue;
  const head = readFileSync(join(root, f), "utf8").split("\n").slice(0, 8).join("\n");
  if (!STATUS_LINE.test(head)) {
    console.log(`${f}:1: missing status line -> 檔頭加一行 "> 狀態：現行（最後確認 YYYY-MM-DD）"（或已被取代／歷史紀錄；歷史的移到 docs/archive/）`);
    missingStatus++;
  }
}

let broken = 0;
for (const f of files) {
  if (FROZEN.has(f)) continue;
  const text = readFileSync(join(root, f), "utf8")
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
      let path = target.split("#")[0].split("?")[0];
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      if (!path || !/[./]/.test(path)) continue; // "(url)" / "(…)" are prose, not links
      const abs = path.startsWith("/") ? join(root, path) : resolve(dirname(join(root, f)), path);
      if (!existsSync(abs)) { console.log(`${f}:${i + 1}: broken link -> ${target}`); broken++; }
    }
  });
}
console.log(`${files.length} markdown files checked, ${broken} broken link(s), ${missingStatus} missing status line(s)`);
process.exit(broken || missingStatus ? 1 : 0);
