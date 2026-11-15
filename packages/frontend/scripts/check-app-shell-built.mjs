// After a build: the page the build wrote still carries the keyboard rule in its viewport (appShell/head.ts is the source).
// usage: node scripts/check-app-shell-built.mjs <built index.html> [...]   (dist/client, dist-browser, dist-cap)
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: check-app-shell-built.mjs <built index.html> [...]");
  process.exit(2);
}
let bad = 0;
for (const file of files) {
  const content = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(readFileSync(file, "utf8"))?.[1];
  const ok = content?.split(",").map((p) => p.trim()).includes("interactive-widget=resizes-content");
  console.log(`${ok ? "ok  " : "FAIL"} ${file}: viewport ${content ?? "(none)"}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
