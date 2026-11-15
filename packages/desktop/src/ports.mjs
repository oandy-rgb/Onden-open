// 桌面版所有本機服務（視窗載入的網頁伺服器、內建後端）都只聽 127.0.0.1，不對區網開放（手機連線是還沒做的功能）。
// 後端要靠啟動時帶 ONDEN_LISTEN_HOST（backendProcess.mjs）才會只聽本機；這裡的探測只是挑一個空的埠。
import { createServer } from "node:net";

export const LOOPBACK = "127.0.0.1";

/** 試著占住 preferred；被占用就讓系統給一個空的。回傳埠號（已釋放，呼叫者馬上用）。 @param {number} [preferred] */
export function freePort(preferred) {
  /** @param {number} port @returns {Promise<number>} */
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, LOOPBACK, () => {
        const address = probe.address();
        const got = typeof address === "object" && address ? address.port : port;
        probe.close(() => resolve(got));
      });
    });
  if (!preferred) return tryPort(0);
  return tryPort(preferred).catch(() => tryPort(0));
}
