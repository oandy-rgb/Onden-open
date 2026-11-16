// Side-effect import, FIRST in a test file whose screens load data on mount (spaces, preferences, counts, the session…) while the
// test is about something else: from here to the end of the file the network is down, and every request fails at once the way a
// refused connection does, instead of going out and failing later in another file (see noRealNetwork.ts).
//
// It must be the first import: better-auth's session store, among others, asks for the session on a timer started while the app
// modules load, before any beforeAll runs. The function is assigned, not stubbed with vi.stubGlobal, because setup.ts undoes stubs
// after each test and a screen that is still mounted asks again in the gap before the next one. A test that wants an answer
// stubs `fetch` itself (vi.stubGlobal); undoing that stub brings this back.
const offline = (): Promise<never> => Promise.reject(new TypeError("Failed to fetch"));
const scope = globalThis as Record<string, unknown>;
for (const target of new Set([scope, scope.window as Record<string, unknown> | undefined])) if (target) target.fetch = offline;

export {};
