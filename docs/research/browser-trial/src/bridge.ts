// 「攔下前端的 /api/* 請求，交給同一個 Hono app」的橋（正式版會放在 service worker 或頁面的 fetch 包裝裡）。
//
// 瀏覽器限制（實測到的，不是推測）：Request／Response 建構子會悄悄丟掉「禁止的標頭」——
//   Request 的 cookie、origin、host；Response 的 set-cookie。
// 後端靠 cookie 認人，所以橋要自己做兩件事：
//   1. 登入：直接呼叫 better-auth 的 API（`returnHeaders`）拿 session cookie（一般 Headers 不受禁止清單限制），存在橋的 cookie jar。
//   2. 每個請求：用 Proxy 把 Request 的 `headers` 換成含 cookie 的 Headers（其餘屬性與方法照舊綁回原 Request）。
import type { Hono } from "hono";

type AuthApi = {
  signInEmail(o: { body: { email: string; password: string }; returnHeaders: true }): Promise<{ headers: Headers }>;
  signUpEmail(o: { body: { email: string; password: string; name: string }; returnHeaders: true }): Promise<{ headers: Headers }>;
};

export function createBridge(app: Hono<any>, authApi: AuthApi, account: { email: string; password: string; name: string }) {
  let cookie = "";
  const remember = (h: Headers) => {
    const parts = h.getSetCookie().map((c) => c.split(";")[0]);
    if (parts.length) cookie = parts.join("; ");
  };
  async function ensureLocalAccount(): Promise<void> {
    try {
      remember((await authApi.signInEmail({ body: { email: account.email, password: account.password }, returnHeaders: true })).headers);
    } catch {
      remember((await authApi.signUpEmail({ body: account, returnHeaders: true })).headers);
    }
  }
  async function request(input: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request(new URL(input, "http://localhost").href, init);
    const headers = new Headers(req.headers);
    if (cookie) headers.set("cookie", cookie);
    headers.set("host", "localhost");
    const wrapped = new Proxy(req, {
      get(t, k) {
        if (k === "headers") return headers;
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return app.fetch(wrapped as Request);
  }
  return { ensureLocalAccount, request, get hasSession() { return cookie !== ""; } };
}
