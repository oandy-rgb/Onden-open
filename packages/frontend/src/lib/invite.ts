// The owner's one-time invite link (audit D110): `/?invite=<token>`.
//
// The token is read ONCE at boot (before the URL canonicaliser rewrites the
// search string), kept in sessionStorage for this tab, and:
//   * sent with an email sign-up as the X-Onden-Invite header, so a closed
//     server (ONDEN_SIGNUP first-only) lets the invited person register;
//   * mirrored in the onden_invite cookie, which a first OAuth sign-in's
//     callback carries to the server (same-site deployments only);
//   * spent by POST /api/invites/claim right after sign-in, BEFORE the
//     workspace mounts (InviteClaimGate) — so no other request can make the
//     login an ordinary viewer first.
// The server decides everything; the token here proves nothing by itself.
import { readUrlParams, stripUrlParams } from "./pageUrl";
import { getApiBase, pageOrigin } from "./api";
import { SESSION_KEYS, readSession, removeSession, writeSession } from "./sessionPrefs";

const COOKIE = "onden_invite";
// Kept in memory too, for a tab whose sessionStorage is unavailable.
let memo: string | null = null;

function setCookie(value: string | null): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = value
      ? `${COOKIE}=${encodeURIComponent(value)}; path=/; max-age=3600; SameSite=Lax`
      : `${COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch { /* cookies blocked: the header path still works for email sign-up */ }
}

/** Read `?invite=` from the address bar once, keep it for this tab, and strip
 *  it from the URL (a reload or a shared screenshot does not carry it on).
 *  Returns the token now pending, from the URL or an earlier capture. */
export function captureInviteFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = readUrlParams();
  const fromUrl = params.get("invite")?.trim();
  if (fromUrl) {
    writeSession(SESSION_KEYS.inviteToken, fromUrl); // not kept when storage is blocked: `memo` covers it
    setCookie(fromUrl);
    stripUrlParams(["invite"]);
    memo = fromUrl;
  }
  return pendingInviteToken();
}

/** The invite token this tab still has to claim, if any. */
export function pendingInviteToken(): string | null {
  return readSession(SESSION_KEYS.inviteToken) ?? memo;
}

/** The claim finished (or the person chose to continue without it). */
export function forgetInviteToken(): void {
  memo = null;
  removeSession(SESSION_KEYS.inviteToken);
  setCookie(null);
}

/** Headers for an auth request made while an invite is pending. */
export function inviteRequestHeaders(): Record<string, string> {
  const token = pendingInviteToken();
  return token ? { "X-Onden-Invite": token } : {};
}

/** The full link the owner copies: the app's own address + the server's
 *  invite path (`/?invite=…`). With a configured server address (native app)
 *  that server's origin, which also serves the web app. */
export function inviteLinkFor(invitePath: string): string {
  const base = getApiBase();
  let origin = pageOrigin();
  if (base && /^https?:\/\//i.test(base)) {
    try { origin = new URL(base).origin; } catch { /* keep the page origin */ }
  }
  return origin + invitePath;
}
