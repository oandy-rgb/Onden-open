// Shared process, filesystem-isolation and executable-lookup helpers for AI CLI adapters.
// Every adapter runs its child with no shell, ONDEN_* stripped from the environment, an empty
// 0700 working directory removed on exit, a process-group kill on deadline/abort, and a 5 MB cap.
import { spawn } from "node:child_process";
import { access, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const MAX_OUTPUT_BYTES = 5_000_000;

/** Our own settings are not the tool's business: nothing named ONDEN_* reaches it.
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string | undefined>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnvironment(env, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("ONDEN_")));
  for (const [name, value] of Object.entries(extra)) {
    if (name.startsWith("ONDEN_")) continue;
    if (value === undefined) delete clean[name];
    else clean[name] = value;
  }
  return clean;
}

/** Where AI tools usually live when the program was not started from a shell (a systemd user service and a desktop app get a short PATH). */
const COMMON_TOOL_DIRS = () => [
  join(homedir(), ".local/bin"),
  join(homedir(), ".npm-global/bin"),
  join(homedir(), ".claude/local"),
  "/home/linuxbrew/.linuxbrew/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

/** @param {string} file */
const isExecutable = (file) => new Promise((resolve) => access(file, constants.X_OK, (error) => resolve(!error)));

/**
 * The tool as an absolute path, or null: a path is checked as given; a bare name is looked up in PATH, then in the
 * usual install folders. A background service must be started with this path, not the name.
 * @param {string} command @param {NodeJS.ProcessEnv} env @returns {Promise<string | null>}
 */
export async function resolveExecutable(command, env) {
  if (isAbsolute(command) || command.includes("/")) return (await isExecutable(command)) ? command : null;
  for (const dir of [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...COMMON_TOOL_DIRS()]) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Resolve the first executable found among candidate names/paths.
 * @param {readonly string[]} candidates @param {NodeJS.ProcessEnv} env @returns {Promise<string | null>}
 */
export async function resolveFirstExecutable(candidates, env) {
  for (const name of candidates) {
    const found = await resolveExecutable(name, env);
    if (found) return found;
  }
  return null;
}

/** Run a short probe command with stdin closed so interactive wrappers (e.g. installer shims) cannot hang.
 * @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number | null, out: string, err: string, error: Error | null }>}
 */
export function runToEnd(command, args, { env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(command, args, { env: childEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, out, err, error }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, error: null }); });
  });
}

/** Kill a child and (on Unix) its entire process group.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killProcessGroup(child) {
  const pid = child.pid;
  try {
    if (pid === undefined || process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Create an isolated 0700 temp directory with separate empty `work` and `config` folders, always removed afterwards.
 * @template T
 * @param {(dirs: { root: string, work: string, configDir: string }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIsolatedRunDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "onden-ai-"));
  try {
    await chmod(root, 0o700);
    const work = join(root, "work");
    const configDir = join(root, "config");
    await mkdir(work, { mode: 0o700 });
    await mkdir(configDir, { mode: 0o700 });
    return await fn({ root, work, configDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Spawn an AI tool with stdin piped, stdout bounded, and hard deadline/abort termination.
 * @param {{
 *   exe: string,
 *   args: string[],
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   stdin: string,
 *   deadline: number,
 *   signal?: AbortSignal,
 *   parse: (stdout: string, code: number | null) => import("./index.mjs").RunResult,
 * }} input
 * @returns {Promise<import("./index.mjs").RunResult>}
 */
export function spawnBounded({ exe, args, cwd, env, stdin, deadline, signal, parse }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    let out = "";
    let ended = false;
    /** @param {import("./index.mjs").RunResult} result */
    const end = (result) => {
      if (!ended) {
        ended = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve(result);
      }
    };
    const stop = () => { killProcessGroup(child); end({ ok: false, reason: "cancelled" }); };
    const timer = setTimeout(() => { killProcessGroup(child); end({ ok: false, reason: "timeout" }); }, Math.max(0, deadline - Date.now()));
    if (signal?.aborted) { stop(); return; }
    signal?.addEventListener("abort", stop);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUTPUT_BYTES) {
        killProcessGroup(child);
        end({ ok: false, reason: "too_long" });
      }
    });
    child.on("error", () => end({ ok: false, reason: "not_started" }));
    child.on("close", (code) => end(parse(out, code)));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
