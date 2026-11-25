// A per-user background service. Linux (systemd user unit) only; other systems say plainly what is not done.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const UNIT_NAME = "onden-ai-answerer.service";
// The limit counts the AI tool too (same cgroup). Measured 2026-11-16 on a laptop: the tool alone peaks at about
// 225 MB for a one-line answer with no tool calls; this program adds a small Node process.
export const MEMORY_MAX = "768M";

/** systemd quoting for one ExecStart word. @param {string} word */
const quote = (word) => `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** The unit text. It names the key file's path, never the code. @param {{ nodePath: string, cliPath: string, server: string, keyFile: string, tool?: string, toolCommand?: string }} input */
export function unitText({ nodePath, cliPath, server, keyFile, tool, toolCommand }) {
  const words = [
    nodePath, cliPath, "run", "--server", server, "--key-file", keyFile,
    ...(tool ? ["--tool", tool] : []),
    ...(toolCommand ? ["--tool-command", toolCommand] : []),
  ];
  return `[Unit]
Description=Onden: answer questions with the AI tool on this computer
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${words.map(quote).join(" ")}
Restart=always
RestartSec=10
MemoryMax=${MEMORY_MAX}
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export const NOT_SUPPORTED = "背景服務目前只支援 Linux（systemd）。這個系統上還沒做：請先在終端機用前景模式執行（onden-ai-answerer run …）。";
export const unitPath = (/** @type {string} */ home = homedir()) => join(home, ".config/systemd/user", UNIT_NAME);

/** @param {string[]} args */
const systemctl = (args) => run("systemctl", ["--user", ...args]);

/** @param {Parameters<typeof unitText>[0] & { home?: string }} input */
export async function install(input) {
  const file = unitPath(input.home);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, unitText(input), { mode: 0o644 });
  await systemctl(["daemon-reload"]);
  await systemctl(["enable", "--now", UNIT_NAME]);
  return file;
}

export async function uninstall(/** @type {string | undefined} */ home) {
  await systemctl(["disable", "--now", UNIT_NAME]).catch(() => {});
  await rm(unitPath(home), { force: true });
  await systemctl(["daemon-reload"]).catch(() => {});
}

export async function status() {
  const active = await systemctl(["is-active", UNIT_NAME]).then((r) => r.stdout.trim(), (e) => String(e.stdout ?? "inactive").trim() || "inactive");
  const enabled = await systemctl(["is-enabled", UNIT_NAME]).then((r) => r.stdout.trim(), (e) => String(e.stdout ?? "").trim() || "未安裝");
  return { active, enabled };
}
