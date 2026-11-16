// onden-ai-answerer run | install | uninstall | status
import { fileURLToPath } from "node:url";
import { createAdapters } from "./adapters/index.mjs";
import { parseServerAddress } from "./address.mjs";
import { readConnectionCode } from "./keyFile.mjs";
import { runLoop } from "./loop.mjs";
import { createClient } from "./protocol.mjs";
import * as service from "./service.mjs";

const HELP = `用法：onden-ai-answerer <指令> [選項]

指令
  run         在前景執行：從 Onden 領問題，交給這台電腦上已登入的 AI 工具回答（預設）
  install     安裝成使用者層級的背景服務（Linux／systemd，含記憶體上限）
  uninstall   移除背景服務
  status      看背景服務的狀態

選項
  --server <網址>        Onden 伺服器網址（或環境變數 ONDEN_SERVER_URL）
  --key-file <路徑>      存放這個 AI 連線碼的檔案（或 ONDEN_AI_KEY_FILE）；權限必須是 600
  --tool-command <路徑>  AI 命令列工具的執行檔（預設用內建支援的工具；或 ONDEN_AI_TOOL_COMMAND）

連線碼只從檔案讀取：不會出現在命令列、記錄或任何其他檔案。`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      options[name] = inline ?? argv[++i] ?? "";
    } else positional.push(a);
  }
  return { options, command: positional[0] ?? "run" };
}

/**
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env
 * @param {{ out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, env, { out = console.log, err = console.error } = {}) {
  const { options, command } = parseArgs(argv);
  if (command === "help" || "help" in options || argv.includes("-h")) { out(HELP); return 0; }
  const toolCommand = options["tool-command"] || env.ONDEN_AI_TOOL_COMMAND || undefined;

  if (command === "status") {
    if (process.platform !== "linux") { err(service.NOT_SUPPORTED); return 2; }
    const s = await service.status();
    out(`背景服務：${s.active}（開機自動啟動：${s.enabled}）`);
    return s.active === "active" ? 0 : 3;
  }
  if (command === "uninstall") {
    if (process.platform !== "linux") { err(service.NOT_SUPPORTED); return 2; }
    await service.uninstall(undefined);
    out("已移除背景服務。連線碼檔案沒有動，需要的話請自己刪除。");
    return 0;
  }
  if (command !== "run" && command !== "install") { err(`不認得的指令：${command}\n\n${HELP}`); return 1; }

  const address = parseServerAddress(options.server || env.ONDEN_SERVER_URL || "");
  if (!address.ok) { err(address.message); return 1; }
  const keyFile = options["key-file"] || env.ONDEN_AI_KEY_FILE;
  if (!keyFile) { err("請用 --key-file 指定存放連線碼的檔案。"); return 1; }
  let connectionCode;
  try { connectionCode = await readConnectionCode(keyFile); } catch (error) { err(/** @type {Error} */ (error).message); return 1; }

  const adapters = createAdapters({ command: toolCommand });
  const adapter = adapters[0];
  const detected = await adapter.detect();
  if (!detected.ok) { err(detected.message); return 1; }

  if (command === "install") {
    if (process.platform !== "linux") { err(service.NOT_SUPPORTED); return 2; }
    const { resolve } = await import("node:path");
    const file = await service.install({
      nodePath: process.execPath, cliPath: resolve(fileURLToPath(import.meta.url), "../../bin/onden-ai-answerer.mjs"),
      server: address.baseUrl, keyFile: resolve(keyFile),
      toolCommand: detected.command, // the absolute path found now: a background service does not get this shell's PATH
    });
    out(`已安裝並啟動背景服務（${file}）。看狀態：onden-ai-answerer status。\n若要在沒有登入桌面時也持續運作，請執行一次：loginctl enable-linger`);
    return 0;
  }

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => controller.abort());
  const stamp = () => new Date().toISOString().slice(11, 19);
  out(`開始等問題（${address.baseUrl}）。按 Ctrl+C 結束。`);
  await runLoop({
    client: createClient({ baseUrl: address.baseUrl, connectionCode }), adapter, baseUrl: address.baseUrl,
    log: (line) => out(`${stamp()} ${line}`), signal: controller.signal,
  });
  return 0;
}

