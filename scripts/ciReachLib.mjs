// What CI really runs, and every test or check that it does not (owner, 2026-11-22: 「測試一定要進ci」).
// CLI: scripts/ciReach.mjs; guard: packages/markdown/src/test/guards/ciReach.guard.test.ts.
//
// Reached = started by a line of a workflow that runs by itself (push, pull_request or schedule; a workflow that only
// runs by hand does not count), followed through `npm run`, `cd`, `vitest`, `node`, `bash` and the shell scripts they
// start. Then every test file must be owned by a reached runner, and every check-like npm script must be reached:
//   vitest      the file is in `vitest list` of a config that a reached line runs
//   playwright  a *.spec.ts under a reached Playwright config's folder and not in its ignore list
//   node        a file named on a reached line (`node x.mjs`, `node --test a/*.test.mjs`), or listed in run-all.mjs
// Blind (docs/agents/testing.md): a job's `if:`, environment prefixes (test:pglite counts as test), Playwright --grep /
// --project / skips. `vitest run <path>` reaches only that folder; a line whose file list is built at run time reaches nothing.
// A test or script that is deliberately not run (it measures without asserting, it writes a baseline) is named in
// scripts/ci-reach-baseline.json with the reason; that list only shrinks (scripts/ratchetLib.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import picomatch from "picomatch";

const AUTO_TRIGGERS = ["push", "pull_request", "schedule"];
/** npm scripts that are checks: each must be reached. Writers, watchers and one-file helpers are tools, not checks. */
const CHECK_SCRIPT = /^(test|check|lint|audit|bench|parity|dup|e2e|layout|style|unused|ratchet|changes|notices|preflight|desktop:(test|smoke|check))(:|$)|:(check|test|selftest)$/;
const TOOL_SCRIPT = /:(watch|fix|baseline|file|shrink|dev)$/;
/** Runners that start Playwright inside a container, where the command line is not a plain `playwright test`. */
const INSIDE = { "packages/frontend/e2e/fullstack/run.sh": ["packages/frontend/e2e/playwright.config.ts"] };
/** The one runner whose script list is data (FEATURES and the spawns above it): files it names count as reached with it. */
const RUN_ALL = "packages/frontend/e2e/browser-app/run-all.mjs";
/** vitest options whose value is the next word (so the word is not a file filter). */
const VITEST_VALUE_FLAGS = new Set(["--project", "-t", "--testNamePattern", "--shard", "--reporter", "--outputFile", "--maxWorkers", "--minWorkers", "--pool", "--environment", "--dir", "--root", "-r"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.perf\.ts$/;

const rel = (root, p) => relative(root, p).split("\\").join("/") || ".";

/** Shell text → logical lines (continuations joined, comments dropped). */
export function shellLines(text) {
  return text.replace(/\\\n/g, " ").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

/** Split one line into commands on && || ; | (outside quotes), and each into words (quotes kept as one word). */
export function commands(line) {
  const out = []; let words = []; let word = ""; let quote = null; let has = false;
  const endWord = () => { if (has) words.push(word); word = ""; has = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    if (c === ";" || c === "|" || (c === "&" && line[i + 1] === "&")) { if (line[i + 1] === c) i++; endCmd(); continue; }
    if (c === "#" && !has) break;
    word += c; has = true;
  }
  endCmd();
  return out;
}

/** The `run:` lines of the workflow files that run by themselves, with their working directory. Only what the guard needs
 *  is read: `on:`, each step's `run:` (plain or block) and `working-directory:`. */
export function workflowRuns(root) {
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    const on = triggers(lines);
    if (!on.some((t) => AUTO_TRIGGERS.includes(t))) continue;
    let step = null;
    let matrix = []; // the current job's `matrix.include` rows, as { key: value }
    const flush = () => {
      if (!step?.run) return;
      const rows = /\$\{\{\s*matrix\./.test(step.run + (step.cwd ?? "")) && matrix.length ? matrix : [null];
      for (const row of rows) {
        const fill = (t) => (row ? t.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) => row[k] ?? "") : t);
        runs.push({ from: `.github/workflows/${name}`, cwd: fill(step.cwd ?? "."), text: fill(step.run) });
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^ {2}[\w-]+:\s*$/.test(line)) { flush(); step = null; matrix = []; }
      const row = /^\s*- \{(.*)\}\s*$/.exec(line);
      if (row) { matrix.push(Object.fromEntries([...row[1].matchAll(/(\w+):\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)].map(([, k, v]) => [k, v.trim().replace(/^"|"$/g, "")]))); continue; }
      const indent = line.search(/\S/);
      const item = /^(\s*)- /.exec(line);
      if (item && (step === null || item[1].length <= step.indent)) { flush(); step = { indent: item[1].length, run: "", cwd: null }; }
      if (!step) continue;
      const body = line.replace(/^\s*- /, (m) => " ".repeat(m.length)).trim();
      const wd = /^working-directory:\s*(.+)$/.exec(body);
      if (wd) step.cwd = wd[1].replace(/^["']|["']$/g, "");
      const run = /^run:\s*(.*)$/.exec(body);
      if (!run) continue;
      if (/^[|>][-+]?$/.test(run[1])) {
        const block = [];
        while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > indent)) block.push(lines[++i]);
        step.run = block.join("\n");
      } else step.run = run[1];
    }
    flush();
  }
  return runs;
}

/** The event names under `on:` (a word, a list, or a map). */
function triggers(lines) {
  const at = lines.findIndex((l) => /^on:/.test(l));
  if (at < 0) return [];
  const inline = lines[at].slice(3).trim();
  if (inline) return inline.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = at + 1; i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i])); i++) {
    const m = /^ {2}(- )?([a-z_]+)/.exec(lines[i]);
    if (m) out.push(m[2]);
  }
  return out;
}

/** The package directories with a package.json, the root included (".") */
function packageDirs(root) {
  const dirs = ["."];
  const pk = join(root, "packages");
  if (existsSync(pk)) for (const d of readdirSync(pk).sort()) if (existsSync(join(pk, d, "package.json"))) dirs.push(`packages/${d}`);
  return dirs;
}
const scriptsOf = (root, dir) => {
  const file = join(root, dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).scripts ?? {} : {};
};

/** Follow every reached line. Returns what ran: npm scripts ("dir:name"), vitest configs, Playwright configs, files. */
export function reached(root, runs = workflowRuns(root)) {
  const out = { scripts: new Set(), vitest: new Set(), vitestPaths: new Map(), playwright: new Set(), files: new Set(), tools: new Set() };
  const seen = new Set();
  const visit = (cwd, text, depth) => {
    if (depth > 12) return;
    for (const line of shellLines(text)) {
      let here = cwd;
      for (const words of commands(line)) here = run(here, words, depth) ?? here;
    }
  };
  const file = (cwd, p) => rel(root, normalize(join(root, cwd, p)));
  const run = (cwd, words, depth) => {
    let w = words.filter((x, i) => !(i < words.findIndex((y) => !/^[A-Z_][A-Z0-9_]*=/.test(y)) && /^[A-Z_][A-Z0-9_]*=/.test(x)));
    // wrappers that start the rest: env, xvfb-run -a, timeout N, npx, sh -c "…", guard-lane's step "label" / in_package <pkg>
    for (;;) {
      if (w[0] === "env") w = w.slice(1).filter((x) => !/^[A-Z_][A-Z0-9_]*=/.test(x) && !x.startsWith("$"));
      else if (w[0] === "xvfb-run") w = w.slice(1).filter((x) => x !== "-a");
      else if (w[0] === "timeout") w = w.slice(2);
      else if (w[0] === "npx") w = w.slice(1).filter((x) => !x.startsWith("--yes"));
      else if (w[0] === "step") w = w.slice(2);
      else if (w[0] === "in_package") { cwd = `packages/${w[1]}`; w = w.slice(2); }
      else if ((w[0] === "sh" || w[0] === "bash") && w[1] === "-c") { visit(cwd, w[2] ?? "", depth + 1); return; }
      else break;
    }
    const [cmd, ...args] = w;
    if (!cmd) return;
    if (cmd === "cd") return args[0] ? file(cwd, args[0]) : ".";
    if (cmd === "npm") return npm(cwd, args, depth);
    if (cmd === "vitest") {
      if (args[0] && !["run", "list"].includes(args[0]) && !args[0].startsWith("-")) return; // vitest bench / typecheck …
      const rest = args[0] === "run" || args[0] === "list" ? args.slice(1) : args;
      let config = "vitest.config.ts"; const paths = []; let unknown = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--config" || a === "-c") config = rest[++i];
        else if (VITEST_VALUE_FLAGS.has(a)) i++;
        else if (a.startsWith("-")) continue;
        else if (a.startsWith("$") || a.includes("$(")) unknown = true; // a list built at run time: cannot say which files
        else paths.push(file(cwd, a));
      }
      if (unknown) return;
      const c = file(cwd, config);
      if (!paths.length) out.vitest.add(c);
      else for (const p of paths) out.vitestPaths.set(c, new Set([...(out.vitestPaths.get(c) ?? []), p]));
      return;
    }
    // Checks that are one tool run in a folder: the same tool with the same config anywhere in CI is the same check.
    if (cmd === "tsc" || cmd === "eslint") {
      const c = args.indexOf(cmd === "tsc" ? "-p" : "-c");
      out.tools.add(`${cmd} ${c >= 0 ? file(cwd, args[c + 1]) : cwd}`);
      return;
    }
    if (cmd === "playwright" && args[0] === "test") {
      const c = args.indexOf("--config");
      out.playwright.add(file(cwd, c >= 0 ? args[c + 1] : "playwright.config.ts"));
      return;
    }
    if (cmd === "node" || cmd === "tsx" || cmd === "bash" || cmd === "sh" || cmd.startsWith("./") || /\.(sh|mjs|js|ts)$/.test(cmd)) {
      const targets = (cmd === "node" || cmd === "tsx" || cmd === "bash" || cmd === "sh" ? args : [cmd, ...args]).filter((a) => !a.startsWith("-") && !a.startsWith("$"));
      const nodeTest = cmd === "node" && args.includes("--test");
      const rest = targets.length ? args.slice(args.indexOf(targets[0]) + 1) : [];
      for (const t of nodeTest ? targets : targets.slice(0, 1)) for (const f of expandGlob(root, file(cwd, t))) script(cwd, f, depth, rest);
    }
  };
  const script = (cwd, f, depth, args = []) => {
    if (!existsSync(join(root, f))) return;
    out.files.add(f);
    // A node script that starts npm or npx as an argument list, the way scripts/desktopCheck.mjs and scripts/bench/run.mjs
    // do: ("npm", ["run", "test", "--prefix", "packages/desktop"]) or ("npx", ["vitest", …], resolve(root, "packages/frontend")).
    if (/\.[cm]?js$/.test(f) && !seen.has(f)) {
      seen.add(f);
      for (const m of readFileSync(join(root, f), "utf8").matchAll(/["'](npm|npx)["'],\s*\[([^\]]*)\]([^\n]*)/g)) {
        const words = [...m[2].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
        const dir = /["'](packages\/[\w-]+)["']/.exec(m[3])?.[1] ?? ".";
        run(dir, [m[1], ...words], depth + 1);
      }
    }
    // run.sh hands its arguments to `playwright test` in the e2e folder: `--config X` runs X instead of the default config.
    const c = args.indexOf("--config");
    for (const cfg of INSIDE[f] ?? []) out.playwright.add(c >= 0 && args[c + 1] ? rel(root, normalize(join(root, dirname(cfg), args[c + 1]))) : cfg);
    if (f === RUN_ALL) for (const m of readFileSync(join(root, f), "utf8").matchAll(/["']([\w.-]+\.mjs)["']/g)) out.files.add(`${dirname(f)}/${m[1]}`);
    if (/\.sh$/.test(f) && existsSync(join(root, f)) && !seen.has(f)) { seen.add(f); visit(cwd, readFileSync(join(root, f), "utf8"), depth + 1); }
  };
  const npm = (cwd, args, depth) => {
    let dirs = [cwd]; const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-w" || a === "--workspace" || a === "--prefix") { const v = args[++i]; if (v === undefined || v.startsWith("$")) continue; const d = file(cwd, v); dirs = (rest.includes("__ws") ? dirs : []).concat(d); rest.push("__ws"); }
      else if (a.startsWith("--workspace=")) { dirs = [file(cwd, a.slice(12))]; rest.push("__ws"); }
      else if (a === "--workspaces" || a === "-ws") dirs = packageDirs(root).filter((d) => d !== ".");
      else if (a === "--") break;
      else if (!a.startsWith("-")) rest.push(a);
    }
    const words = rest.filter((x) => x !== "__ws");
    const name = words[0] === "test" ? "test" : (words[0] === "run" || words[0] === "run-script") ? words[1] : null;
    if (!name) return;
    for (const d of dirs) {
      const body = scriptsOf(root, d)[name];
      if (body === undefined) continue;
      const key = `${d}:${name}`;
      if (out.scripts.has(key)) continue;
      out.scripts.add(key);
      visit(d, body, depth + 1);
    }
  };
  for (const r of runs) visit(r.cwd, r.text, 0);
  return out;
}

function expandGlob(root, pattern) {
  if (!/[*?{[]/.test(pattern)) return [pattern];
  const match = picomatch(pattern);
  return trackedFiles(root).filter((f) => match(f));
}

let tracked = null;
export function trackedFiles(root) {
  if (tracked?.root === root) return tracked.files;
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  tracked = { root, files };
  return files;
}

/** Every vitest config in the packages (mutation configs re-run tests other configs own, so they own nothing). */
function vitestConfigs(root) {
  return trackedFiles(root).filter((f) => /^(packages\/[^/]+\/)?vitest(\.[\w-]+)?\.config\.[cm]?ts$/.test(f) && !/mutation/.test(f));
}

/** The files a vitest config runs, from vitest itself (`vitest list --filesOnly`), so include/exclude are read the way vitest reads them. */
export function vitestFiles(root, config) {
  const dir = dirname(config);
  // --json=<file>: a config may print to stdout while it loads (Astro's does), so the list goes to a file of its own.
  const out = join(mkdtempSync(join(tmpdir(), "ci-reach-")), "list.json");
  execFileSync("npx", ["vitest", "list", "--filesOnly", `--json=${out}`, "--config", config.slice(dir === "." ? 0 : dir.length + 1)], {
    cwd: join(root, dir), stdio: "ignore", env: { ...process.env, ONDEN_TESTS_WITHOUT_DATABASE: "1" },
  });
  const list = JSON.parse(readFileSync(out, "utf8"));
  rmSync(dirname(out), { recursive: true, force: true });
  return list.map((x) => rel(root, x.file));
}

/** A Playwright config's specs: *.spec.ts under testDir, less the files its IGNORED_SPECS / testIgnore regex names
 *  outside the cloud stack. Read from the config's text because Playwright is not installed where the guards run. */
export function playwrightFiles(root, config) {
  const text = readFileSync(join(root, config), "utf8");
  // A config whose testMatch is computed (playwright.webkit-scan.config.ts: a list from e2e/webkitScanSpecs.ts) cannot be read
  // from its text: it owns nothing here, so running it never counts as running a spec the guard cannot see it select.
  if (/testMatch\b/.test(text) && !/testMatch:\s*\//.test(text)) return [];
  const dir = /testDir:\s*["']([^"']+)["']/.exec(text)?.[1] ?? ".";
  const base = rel(root, normalize(join(root, dirname(config), dir)));
  const ignore = /const IGNORED_SPECS\s*=.*:\s*(\/.+\/);/.exec(text)?.[1] ?? /testIgnore:\s*(\/.+?\/)[,\s]/.exec(text)?.[1];
  const re = ignore ? new RegExp(ignore.slice(1, -1)) : null;
  return trackedFiles(root).filter((f) => f.startsWith(`${base}/`) && f.endsWith(".spec.ts") && !(re && re.test(f)));
}

/** What no reached runner runs: test files, check scripts; and baseline entries that no longer name a gap. */
export function gaps(root, { baseline = readBaseline(root), runs = workflowRuns(root), listVitest = vitestFiles } = {}) {
  const r = reached(root, runs);
  const owned = new Map(); // file → [runner]
  const own = (f, by) => owned.set(f, [...(owned.get(f) ?? []), by]);
  for (const c of vitestConfigs(root)) for (const f of listVitest(root, c)) own(f, { kind: "vitest", id: c, ran: vitestRan(r, c, f) });
  for (const c of trackedFiles(root).filter((f) => /(^|\/)playwright(\.[\w-]+)?\.config\.ts$/.test(f) && !f.includes("node_modules")))
    for (const f of playwrightFiles(root, c)) own(f, { kind: "playwright", id: c, ran: r.playwright.has(c) });
  const tests = trackedFiles(root).filter((f) => !f.includes("node_modules/") && (TEST_FILE.test(f) || /^packages\/frontend\/e2e\/browser-app\/[^/]+\.mjs$/.test(f)));
  const files = [];
  for (const f of tests) {
    const by = owned.get(f) ?? [];
    if (by.some((b) => b.ran) || r.files.has(f)) continue;
    files.push({ file: f, why: by.length ? `only in ${by.map((b) => b.id).join(", ")}, which no CI job runs` : "no runner owns it" });
  }
  const scripts = [];
  for (const d of packageDirs(root)) for (const name of Object.keys(scriptsOf(root, d))) {
    if (!CHECK_SCRIPT.test(name) || TOOL_SCRIPT.test(name)) continue;
    if (!r.scripts.has(`${d}:${name}`) && !runsOnlyReached(root, r, d, name)) scripts.push(`${d}:${name}`);
  }
  // `covered`: the same check runs inside a test CI does run (dup:check inside dup.guard.test.ts). Proven, not trusted:
  // the test must be owned by a reached runner and import a module the script's own entry file imports (or the entry).
  const covered = baseline.covered ?? {};
  const unproven = [];
  for (const [key, by] of Object.entries(covered)) {
    if (!scripts.includes(key)) continue;
    const byRan = (owned.get(by) ?? []).some((b) => b.ran);
    if (!byRan || !sharesModule(root, key, by)) unproven.push(`${key} → ${by}`);
  }
  const allowedFiles = baseline.files ?? {}; const allowedScripts = baseline.scripts ?? {};
  const fileGaps = files.filter((g) => !matchesAny(Object.keys(allowedFiles), g.file));
  const scriptGaps = scripts.filter((s) => !(s in allowedScripts) && !(s in covered && !unproven.some((u) => u.startsWith(`${s} →`))));
  const stale = [
    ...Object.keys(allowedFiles).filter((p) => !files.some((g) => picomatch(p)(g.file))),
    ...[...Object.keys(allowedScripts), ...Object.keys(covered)].filter((s) => !scripts.includes(s)),
  ];
  return { files: fileGaps, scripts: scriptGaps, unproven, stale, reached: r };
}

/** A script CI does not call by name but whose every runner CI starts anyway: `test` = `vitest run` in a package whose
 *  config a job runs with `npx vitest run`. A script that starts nothing this file can follow (stryker, tsc) is not. */
function runsOnlyReached(root, r, dir, name) {
  const sub = reached(root, [{ from: "package.json", cwd: dir, text: `npm run ${name}` }]);
  sub.scripts.delete(`${dir}:${name}`);
  if (![...Object.values(sub)].some((set) => set.size)) return false;
  const partOf = (c, p) => r.vitest.has(c) || [...(r.vitestPaths.get(c) ?? [])].some((q) => p === q || p.startsWith(`${q}/`));
  if (![...sub.vitestPaths].every(([c, ps]) => [...ps].every((p) => partOf(c, p)))) return false;
  const scriptRuns = (key) => r.scripts.has(key) || runsOnlyReached(root, r, key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1));
  return [...sub.scripts].every(scriptRuns) && ["vitest", "playwright", "files", "tools"].every((k) => [...sub[k]].every((x) => r[k].has(x)));
}

/** Does a reached vitest line run test file `f` of config `c`: the whole config, or a path filter that holds f. */
function vitestRan(r, c, f) {
  return r.vitest.has(c) || [...(r.vitestPaths.get(c) ?? [])].some((p) => f === p || f.startsWith(`${p}/`));
}

/** Does test file `by` import a module that script `key` runs (its entry file, or a file the entry imports)? */
function sharesModule(root, key, by) {
  const [dir, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const sub = reached(root, [{ from: "package.json", cwd: dir, text: `npm run ${name}` }]);
  const modules = new Set();
  for (const f of sub.files) { modules.add(f); for (const m of importsOf(root, f)) modules.add(m); }
  return importsOf(root, by).some((m) => modules.has(m));
}
const importsOf = (root, f) => existsSync(join(root, f))
  ? [...readFileSync(join(root, f), "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => rel(root, normalize(join(root, dirname(f), m[1]))))
  : [];

const matchesAny = (patterns, f) => patterns.some((p) => picomatch(p)(f));

export function readBaseline(root) {
  const f = join(root, "scripts/ci-reach-baseline.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

/** Human text for a failing check. */
export function report({ files, scripts, unproven = [], stale }) {
  const out = [];
  if (unproven.length) out.push(`scripts/ci-reach-baseline.json 的 covered 說「在這個測試裡跑」，但查不到（測試沒有 CI 在跑，或沒有用到同一個模組）：`, ...unproven.map((u) => `  ${u}`));
  if (files.length) out.push(`沒有任何 CI 工作會跑的測試檔（${files.length}）：`, ...files.map((g) => `  ${g.file} — ${g.why}`));
  if (scripts.length) out.push(`沒有任何 CI 工作會跑的檢查指令（${scripts.length}）：`, ...scripts.map((s) => `  ${s}`));
  if (stale.length) out.push(`scripts/ci-reach-baseline.json 裡已經不是缺口的項目（請刪掉）：`, ...stale.map((s) => `  ${s}`));
  if (out.length) out.push("", "讓它進 CI（.github/workflows/ci.yml 的工作或 scripts/guard-lane.sh），或在 scripts/ci-reach-baseline.json 寫明為什麼刻意不跑；那份清單只准減少。");
  return out.join("\n");
}
