// 宿主轉接器共用：用 cookie 與 origin 打一個 http 網址（Node 後端與桌面版；瀏覽器版在頁面內 fetch）。
import { createServer } from "node:net";

export const freePort = () => new Promise((ok, fail) => {
  const probe = createServer();
  probe.once("error", fail);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => ok(port)); });
});

export const PARITY_USER = { name: "我", email: "parity@onden.local", password: "correct-horse-battery" };

/** 把 Response 變成劇本看到的樣子：JSON 解成物件，其餘留文字；binary 留位元組。 */
export async function readResponse(res, binary) {
  const contentType = res.headers.get("content-type")?.split(";")[0] ?? null;
  if (binary) return { status: res.status, contentType, binary: true, bytes: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let body = text;
  if (contentType?.includes("json")) { try { body = JSON.parse(text); } catch { /* 留文字 */ } }
  return { status: res.status, contentType, body };
}

/** 一個帶 cookie 的 http 用戶端。`origin` 是 Better Auth 檢查的來源。 */
export function cookieClient(base, origin = base, initialCookie = "") {
  let cookies = new Map(initialCookie ? initialCookie.split("; ").map((c) => c.split("=")) : []);
  const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (res) => { for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(";"); const i = pair.indexOf("="); cookies.set(pair.slice(0, i), pair.slice(i + 1)); } };
  return {
    cookieHeader: header,
    async request({ method, path, json, upload, binary, headers: extra, raw }) {
      // 與頁面一樣說自己懂段落錨點（伺服器對舊頁面的筆記寫入回 426：packages/backend/src/clientGate.ts）。
      const headers = { origin, cookie: header(), "x-onden-client-protocol": "3", ...extra };
      if (extra?.authorization) delete headers.cookie; // 帶權杖時不帶登入（權杖本來就是另一個身分）
      let body;
      if (upload) { const form = new FormData(); form.append("file", new Blob([upload.bytes], { type: upload.type }), upload.name); body = form; }
      else if (raw !== undefined) { body = raw.bytes; headers["content-type"] = raw.type; }
      else if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
      const res = await fetch(new URL(path, base), { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      absorb(res);
      return readResponse(res, binary);
    },
    async signUp(user = PARITY_USER) {
      const res = await this.request({ method: "POST", path: "/api/auth/sign-up/email", json: user });
      if (res.status >= 300) throw new Error(`建立帳號失敗：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    },
  };
}
