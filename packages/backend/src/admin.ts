// Container admin commands for self-hosters (docs/self-host/recovery.md):
//   docker compose exec backend node dist/admin.js <command>
// No HTTP route, no email: whoever can run this already controls the
// container. Logic lives in services/adminAccounts.ts; this file only parses
// arguments and prints.
import { randomBytes } from "node:crypto";
import { pool } from "./db.js";
import {
  AdminCommandError, listAccounts, resetPassword, revokeSessions,
} from "./services/adminAccounts.js";

export const HELP = `Onden 管理指令（只在容器內執行，不寄信、不開網路入口）

用法：node dist/admin.js <指令>

指令：
  users                          列出所有帳號：email、是否為擁有者、最後登入時間
  reset-password <email>         產生一組隨機的暫時密碼並印出；該帳號所有登入狀態會失效
  reset-password <email> --password-stdin
                                 改從標準輸入讀新密碼（不會出現在螢幕或指令紀錄）
  sessions revoke <email>        讓該帳號所有登入狀態失效（懷疑被盜用時用）
  --help                         顯示這份說明

每次重設或停用都會寫入操作紀錄，內容不含密碼。
這兩個指令只結束登入狀態，不會停用 AI 金鑰：懷疑被盜用時，登入後到「使用者與 AI」檢查並停用不認得的金鑰。
`;

/** 24 characters of URL-safe randomness (144 bits), within the 8–128 rule. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Strip only the trailing newline an `echo`/heredoc adds.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function formatTime(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === "users" && rest.length === 0) {
    const accounts = await listAccounts();
    if (accounts.length === 0) out("還沒有任何帳號。");
    for (const a of accounts) {
      out([a.email, `擁有者：${a.isOwner ? "是" : "否"}`, `最後登入：${formatTime(a.lastSignInAt)}`].join("\t"));
    }
    return 0;
  }
  if (cmd === "reset-password") {
    const flags = rest.filter((a) => a.startsWith("--"));
    const [email, ...extra] = rest.filter((a) => !a.startsWith("--"));
    const fromStdin = flags.includes("--password-stdin");
    if (!email || extra.length || flags.some((f) => f !== "--password-stdin")) {
      out("用法：reset-password <email> [--password-stdin]");
      return 1;
    }
    const password = fromStdin ? await readPasswordFromStdin() : generateTemporaryPassword();
    const { sessionsEnded } = await resetPassword(email, password);
    out(`已重設 ${email} 的密碼，並讓 ${sessionsEnded} 個登入狀態失效。`);
    if (!fromStdin) {
      out(`暫時密碼（只顯示這一次）：${password}`);
      out("請用它登入後立刻改成自己的密碼。");
    }
    return 0;
  }
  if (cmd === "sessions" && rest[0] === "revoke" && rest.length === 2) {
    const { sessionsEnded } = await revokeSessions(rest[1]);
    out(`已讓 ${rest[1]} 的 ${sessionsEnded} 個登入狀態失效。`);
    return 0;
  }
  out(`不認識的指令：${cmd}\n`);
  out(HELP);
  return 1;
}

// Only when run as the entry file, so tests can import run() without exiting.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let code = 1;
  try {
    code = await run(process.argv.slice(2));
  } catch (err) {
    // Operator-facing refusals are written for the terminal; anything else is
    // reported without the raw error (it could echo query parameters).
    console.error(err instanceof AdminCommandError ? err.message : "指令失敗：發生未預期的錯誤，請檢查資料庫連線與後端記錄。");
    if (!(err instanceof AdminCommandError)) console.error(`（${(err as Error).name}）`);
  } finally {
    await pool.end();
  }
  process.exit(code);
}
