// The page's account, established once before mounting workspace code: the
// one record of who this page works for. It keys the local copies, and every
// request names it (X-Onden-Expected-User, lib/api.ts) so work queued here is
// never replayed as another account. It is neither a credential nor an
// authorization. Displays read the session through useAccountSession
// (lib/accountSession.ts), which shows only this account.
import { pageOrigin } from "./pageUrl";

let storageScope: string | undefined;

/** Bind the authenticated server/user pair once. A different pair needs a new
 * page lifetime, so delayed work cannot be redirected into another account. */
export function bindAccountStorage(userId: string, serverUrl: string): boolean {
  if (!userId) return false;
  const scope = JSON.stringify([canonicalServer(serverUrl), userId]);
  if (storageScope === undefined) {
    storageScope = scope;
    claimLegacyNativeStore(scope);
  }
  return storageScope === scope;
}

/** The account this page is bound to (null before the boundary binds it). */
export function boundAccountId(): string | null {
  return storageScope === undefined ? null : (JSON.parse(storageScope) as [string, string])[1];
}

/** Callers must wait for authentication, on the web and in the native app
 * alike. No account ever falls back to an unowned legacy store; the native
 * one is adopted only as described at claimLegacyNativeStore. */
export function getAccountStorageScope(): string {
  if (storageScope === undefined) throw new Error("Sign in before opening local account data");
  return storageScope;
}

export function accountStorageKey(key: string): string {
  return `${key}:account-v1:${getAccountStorageScope()}`;
}

// The native app used to keep one unscoped store (local database + account
// preferences) for whatever server Settings pointed at. Its queued writes
// belong to the server they were made against, which is the server saved
// when this build first starts: stampLegacyNativeStore records it once, before
// anything can change the setting. The first account that signs in to THAT
// server adopts the store (claimLegacyNativeStore); on any other server it
// stays quarantined, unopened, under its old key, and is never replayed.
const LEGACY_NATIVE_KEY = "onden.legacyNativeStore";
type LegacyNativeStore = { server: string; claimedBy?: string };

function readLegacyNativeStore(): LegacyNativeStore | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_NATIVE_KEY) ?? "null") as LegacyNativeStore | null;
    return saved && typeof saved.server === "string" ? saved : null;
  } catch { return null; }
}

/** Native boot (bootApp): remember which server the old unscoped store was
 *  made against. Written once; a later server change never moves it. */
export function stampLegacyNativeStore(serverUrl: string): void {
  if (import.meta.env.VITE_NATIVE !== "true" || readLegacyNativeStore()) return;
  try { localStorage.setItem(LEGACY_NATIVE_KEY, JSON.stringify({ server: canonicalServer(serverUrl) })); }
  catch { /* storage unavailable: the old store stays quarantined */ }
}

function claimLegacyNativeStore(scope: string): void {
  const legacy = readLegacyNativeStore();
  if (!legacy || legacy.claimedBy !== undefined || legacy.server !== JSON.parse(scope)[0]) return;
  try { localStorage.setItem(LEGACY_NATIVE_KEY, JSON.stringify({ ...legacy, claimedBy: scope })); }
  catch { /* not claimed: the old store stays quarantined */ }
}

/** Whether this page's account owns the old unscoped native store: it moves
 *  the unscoped database and preferences onto its own keys once. */
export function adoptsLegacyNativeStore(): boolean {
  return storageScope !== undefined && readLegacyNativeStore()?.claimedBy === storageScope;
}

function canonicalServer(serverUrl: string): string {
  const server = new URL(serverUrl || "/", pageOrigin());
  return server.origin + server.pathname.replace(/\/+$/, "");
}

/** Changing the server preference cannot redirect an already open queue. */
export function matchesAccountStorageServer(serverUrl: string): boolean {
  return storageScope === undefined || JSON.parse(storageScope)[0] === canonicalServer(serverUrl);
}

// GAP-20: offline cold start. The last account the server VERIFIED on this
// device, per server, so a reload without a connection can open that account's
// local copy instead of stopping at "Unable to check your sign-in status".
// Never set from local data alone; cleared by sign-out and by a 401 (the server
// says there is no session). Queued writes still carry X-Onden-Expected-User,
// so if a different account signs in later the server refuses them (401
// account_changed) and they are never replayed as that account.
const VERIFIED_ACCOUNT_KEY = "onden_verified_account";

export function rememberVerifiedAccount(userId: string, serverUrl: string): void {
  if (!userId) return;
  try { localStorage.setItem(VERIFIED_ACCOUNT_KEY, JSON.stringify({ server: canonicalServer(serverUrl), userId })); }
  catch { /* storage unavailable: offline start stays locked */ }
}

export function forgetVerifiedAccount(): void {
  try { localStorage.removeItem(VERIFIED_ACCOUNT_KEY); } catch { /* nothing stored */ }
}

/** The account last verified against this server, or null. */
export function verifiedAccountFor(serverUrl: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(VERIFIED_ACCOUNT_KEY) ?? "null") as { server?: string; userId?: string } | null;
    return saved?.userId && saved.server === canonicalServer(serverUrl) ? saved.userId : null;
  } catch { return null; }
}
