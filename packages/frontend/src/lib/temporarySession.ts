// Whether this page is a temporary session of the browser app (`?temp=1`, docs/architecture/browser-app.md §17): it keeps
// nothing in the browser. Decided once, at load, by lib/temporaryStorage.ts (the browser app's entry); everything that must
// behave differently asks here. Kept tiny on purpose: the main app's boot bundle carries it, the storage replacement not.

let temporary = false;

/** Whether this page is a temporary session. */
export const isTemporarySession = (): boolean => temporary;

/** Only lib/temporaryStorage.ts, when it has replaced the page's storage. */
export function markTemporarySession(): void { temporary = true; }
