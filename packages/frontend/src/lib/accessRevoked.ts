// Access revoked: the server said this account is no longer a member of the
// workspace (401 membership_removed). That is NOT "offline": the session is
// valid, the server is reachable, and it refuses on purpose. Treating it as
// offline kept showing the cached mirror of a workspace the person was removed
// from, indefinitely.
//
// api() reports every such refusal here; the app owns the response (wipe the
// local mirror, replace the workspace with a notice). One listener keeps
// api.ts free of app-state imports.

type Listener = () => void;
let listener: Listener | null = null;
let revoked = false;

/** Register the app's handler. Returns an unsubscribe. */
export function onAccessRevoked(next: Listener): () => void {
  listener = next;
  if (revoked) next();
  return () => { if (listener === next) listener = null; };
}

/** Called by api() for a 401 whose code says the membership is gone. */
export function notifyAccessRevoked(): void {
  if (revoked) return;
  revoked = true;
  listener?.();
}

/** The 401 codes that mean "removed", as opposed to "not signed in". */
export function isAccessRevokedCode(status: number, code: string | undefined): boolean {
  return status === 401 && code === "membership_removed";
}
