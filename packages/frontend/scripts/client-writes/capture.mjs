#!/usr/bin/env node
// Record what one release's frontend sends and how it reads, as fixtures the
// backend checks against the CURRENT server (packages/backend/src/test/
// clientWritesReplay.integration.test.ts, clientReadsDecode.integration.test.ts).
//
//   npm run capture:client-writes -- <commit-or-tag> [--keep]
//
// What it does, so you can do it by hand when it breaks:
//   1. `git worktree add --detach <tmp> <commit>` — that release's source.
//   2. Symlinks this checkout's node_modules into it (no install per release;
//      a release whose dependencies differ much from today's may need a real
//      `npm ci` in the worktree: run with --keep and do it there).
//   3. Copies the harness (*.harness.ts in this directory) into the worktree's
//      packages/frontend/src/test/ and runs it with the release's own vitest:
//        captureWrites.harness.ts  -> writes.json   (every writer's requests)
//   4. Copies the release's response decoders out as source (decoders/: the
//      bootstrap wire decoder and the sync-delta store ops, with the few pure
//      files they import), so the backend's read-side test can run THAT code on
//      today's responses without checking the release out.
//   5. Writes everything to packages/backend/src/test/fixtures/client-writes/<sha8>/.
//
// The harnesses are the ones in THIS checkout, whatever release they run on, so
// a new scenario is captured for every release by re-running this script.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const [commit, ...flags] = process.argv.slice(2);
if (!commit || commit.startsWith("--")) {
  console.error("usage: npm run capture:client-writes -- <commit-or-tag> [--keep]");
  process.exit(2);
}
const keep = flags.includes("--keep");
const sha = git("rev-parse", "--short=8", `${commit}^{commit}`);
const outDir = join(repo, "packages/backend/src/test/fixtures/client-writes", sha);

/** Entry points of "how the client reads the server's answers". */
const DECODER_ENTRIES = ["lib/data/bootstrapWire.ts", "lib/data/storeOps.ts"];

/** Copy `entries` and every runtime-imported relative module into `out`, keeping
 *  their layout under src/, each marked as a snapshot the backend does not
 *  type-check. Type-only imports are skipped: the bundler erases them. */
function snapshotDecoders(src, out) {
  const copied = new Set();
  const visit = (file) => {
    if (copied.has(file)) return;
    copied.add(file);
    const text = readFileSync(join(src, file), "utf8");
    const target = join(out, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `// @ts-nocheck\n// Snapshot of src/${file} as released (npm run capture:client-writes); not type-checked here.\n${text}`);
    for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]+)"/gms)) {
      const [, typeOnly, names, spec] = match;
      if (typeOnly) continue;
      const braces = names.match(/^\{([^}]*)\}$/);
      if (braces && braces[1].split(",").map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith("type "))) continue;
      const base = normalize(join(dirname(file), spec));
      const resolved = [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find((candidate) => existsSync(join(src, candidate)));
      if (resolved) visit(resolved);
    }
  };
  for (const entry of DECODER_ENTRIES) if (existsSync(join(src, entry))) visit(entry);
  else console.warn(`[capture] ${entry} does not exist in this release; its read-side check will be skipped`);
}

const work = mkdtempSync(join(tmpdir(), `onden-capture-${sha}-`));
const tree = join(work, "tree");
git("worktree", "add", "--detach", tree, sha);
try {
  // Dependencies: the root install, plus each package's own when it has one.
  symlinkSync(join(repo, "node_modules"), join(tree, "node_modules"), "dir");
  for (const pkg of readdirSync(join(repo, "packages"))) {
    const modules = join(repo, "packages", pkg, "node_modules");
    if (existsSync(modules) && existsSync(join(tree, "packages", pkg))) symlinkSync(modules, join(tree, "packages", pkg, "node_modules"), "dir");
  }

  const frontend = join(tree, "packages/frontend");
  const staging = join(work, "out");
  mkdirSync(staging, { recursive: true });
  const harnesses = readdirSync(here).filter((name) => name.endsWith(".harness.ts"));
  for (const name of harnesses) {
    cpSync(join(here, name), join(frontend, "src/test", `__capture_${name.replace(/\.harness\.ts$/, "")}.test.ts`));
  }
  for (const name of harnesses) {
    const file = `src/test/__capture_${name.replace(/\.harness\.ts$/, "")}.test.ts`;
    console.log(`[capture] ${sha}: ${name}`);
    execFileSync("npx", ["vitest", "run", file, "--sequence.shuffle=false", "--reporter=dot"], {
      cwd: frontend, stdio: "inherit",
      env: { ...process.env, CAPTURE_OUT: staging, CAPTURE_COMMIT: sha, CI: "1" },
    });
  }

  snapshotDecoders(join(frontend, "src"), join(staging, "decoders"));

  // transcribed.json is written by hand (requests built inside components, which
  // the harness cannot run); a re-capture keeps it.
  const transcribed = existsSync(join(outDir, "transcribed.json")) ? readFileSync(join(outDir, "transcribed.json")) : null;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  cpSync(staging, outDir, { recursive: true });
  if (transcribed) writeFileSync(join(outDir, "transcribed.json"), transcribed);
  writeFileSync(join(outDir, "release.json"), `${JSON.stringify({
    commit: git("rev-parse", sha),
    subject: git("log", "-1", "--format=%s", sha),
    committed_at: git("log", "-1", "--format=%cI", sha),
  }, null, 2)}\n`);
  console.log(`[capture] wrote ${relative(repo, outDir)}`);
} finally {
  if (keep) console.log(`[capture] kept ${tree}`);
  else {
    try { git("worktree", "remove", "--force", tree); } catch { /* already gone */ }
    rmSync(work, { recursive: true, force: true });
  }
}
