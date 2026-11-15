// Gate for the native-origin → admin-actor bypass.
//
// Native-origin admin is a development convenience: the Capacitor app runs from
// `capacitor://localhost` and local Astro dev from `http://localhost`, neither
// of which carries a session cookie. But the Origin header is forgeable by any
// non-browser client (curl, any HTTP lib), so on a routable PRODUCTION backend
// honouring it is a trivial admin grant to anyone who sets the right Origin.
//
// Therefore the bypass is FORCE-DISABLED in production regardless of the flag —
// the flag can only ever enable it OUTSIDE production. This closes the footgun
// where ALLOW_NATIVE_BYPASS=1 leaked into a production deployment.
//
// Enabled only when: NOT production AND (running tests — so the in-process Hono
// harness can drive admin routes — OR ALLOW_NATIVE_BYPASS=1 is set explicitly).
import { processEnv } from "./config.js";
export function nativeBypassEnabled(env: NodeJS.ProcessEnv = processEnv()): boolean {
  if (env.NODE_ENV === "production") return false;
  return env.NODE_ENV === "test" || env.ALLOW_NATIVE_BYPASS === "1";
}

/** The bypass state in words, for the owner's roster (Settings › Users & agents):
 *  "on", "off_production" (forced off — the production case) or "off". */
export type NativeBypassState = "on" | "off_production" | "off";
export function nativeBypassState(env: NodeJS.ProcessEnv = processEnv()): NativeBypassState {
  if (nativeBypassEnabled(env)) return "on";
  return env.NODE_ENV === "production" ? "off_production" : "off";
}
