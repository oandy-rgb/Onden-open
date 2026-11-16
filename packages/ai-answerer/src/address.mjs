// Which server addresses this program will talk to: https, or plain http only on this computer or a private
// network (the connection code travels in every request). Shared with the desktop app.
import { isIP } from "node:net";

/** @param {string} host */
function isLocalOrPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
  if (isIP(h) !== 4) return false;
  const [a, b] = h.split(".").map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** @param {string} text @returns {{ ok: true, baseUrl: string } | { ok: false, message: string }} */
export function parseServerAddress(text) {
  let url;
  try { url = new URL(text.trim()); } catch { return { ok: false, message: "伺服器網址不正確。" }; }
  if (url.username || url.password) return { ok: false, message: "網址裡不能帶帳號或密碼。" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalOrPrivateHost(url.hostname))) {
    return { ok: false, message: "請用 https:// 開頭的網址（只有這台電腦或內網位址可以用 http://）。" };
  }
  return { ok: true, baseUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}
