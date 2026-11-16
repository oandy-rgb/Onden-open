// The connection code is read from a file and from nowhere else: never an argument, never logged, never copied.
import { readFile, stat } from "node:fs/promises";

/** A key file other users can read is refused (POSIX). @param {string} path @returns {Promise<string>} */
export async function readConnectionCode(path) {
  let info;
  try { info = await stat(path); } catch { throw new Error(`讀不到連線碼檔案：${path}`); }
  if (!info.isFile()) throw new Error(`連線碼檔案不是一般檔案：${path}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`連線碼檔案的權限太寬（其他使用者讀得到）。請執行：chmod 600 ${path}`);
  }
  const code = (await readFile(path, "utf8")).trim();
  if (!code) throw new Error(`連線碼檔案是空的：${path}`);
  return code;
}
