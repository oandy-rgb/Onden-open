// The browser app has one person and no sign-in screen. The worker signs that person in itself and
// adds the session cookie to every request it hands the backend: the page cannot send a Cookie header
// (forbidden in fetch), and a Request built in a worker drops it too, so the Request's headers are
// replaced with a Headers object that carries them (a plain Headers accepts any name).
//
// The password is the same on every device. That is deliberate and not a secret: the account exists only in
// this browser's own database, the worker answers nobody but its own page, and anything that can read the
// password (script running on this page) can already read the database itself.

import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import type { Hono } from "hono";

type AuthApi = {
  signInEmail(options: { body: { email: string; password: string }; returnHeaders: true }): Promise<{ headers: Headers }>;
  signUpEmail(options: { body: { email: string; password: string; name: string }; returnHeaders: true }): Promise<{ headers: Headers }>;
};

export const LOCAL_ACCOUNT = {
  email: "me@this-browser.onden",
  password: "this-browser-has-one-person-and-no-server",
  name: "我",
} as const;

const ORIGIN = "http://localhost";

export function createLocalSession(app: Hono<any>, authApi: AuthApi) {
  let cookie = "";

  const remember = (headers: Headers) => {
    const parts = headers.getSetCookie().map((c) => c.split(";")[0]);
    if (parts.length) cookie = parts.join("; ");
  };

  /** Sign in; on the very first start the account does not exist yet, so make it. */
  async function signIn(): Promise<void> {
    try {
      remember((await authApi.signInEmail({ body: { email: LOCAL_ACCOUNT.email, password: LOCAL_ACCOUNT.password }, returnHeaders: true })).headers);
    } catch {
      remember((await authApi.signUpEmail({ body: LOCAL_ACCOUNT, returnHeaders: true })).headers);
    }
  }

  /** Hand the backend a request as if it came from the signed-in person's browser. `contentLength` is the size of
   *  its body, when it has one: a Request built here has no Content-Length (the header is forbidden to script), and the
   *  upload routes' size limit (hono bodyLimit) would otherwise rebuild the request around the Proxy below, which a
   *  Request constructor does not accept. */
  function fetchAsLocalUser(request: Request, contentLength?: number): Promise<Response> {
    const headers = new Headers(request.headers);
    if (contentLength !== undefined) headers.set("content-length", String(contentLength));
    if (cookie) headers.set("cookie", cookie);
    headers.set("host", "localhost");
    headers.set("origin", ORIGIN);
    // Same build as the page, so it speaks the current block-identity protocol (clientGate.ts).
    if (!headers.has(CLIENT_PROTOCOL_HEADER)) headers.set(CLIENT_PROTOCOL_HEADER, String(CLIENT_PROTOCOL));
    const withSession = new Proxy(request, {
      get(target, key) {
        if (key === "headers") return headers;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return Promise.resolve(app.fetch(withSession as Request));
  }

  return { signIn, fetchAsLocalUser, origin: ORIGIN };
}
