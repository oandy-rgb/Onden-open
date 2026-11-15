// A unit test never reaches the network. A component that fetches on mount in a test that did not stub `fetch` used to send a
// real request to the test window's own address (http://localhost:3000, where nothing listens); the refusal arrived later, in
// another test file, as an unhandled "AggregateError … connect ECONNREFUSED" that vitest pinned on whatever file was running
// and failed the whole run ("971 files passed, 1 error"). Here the request fails the test that made it, at once, with its URL.
//
// What is guarded is only what a test has not replaced: `vi.stubGlobal("fetch", …)`, `vi.spyOn(globalThis, "fetch")` or a
// fake WebSocket class sit on top of these and work as before (setup.ts restores to these after each test).
// The check is also run after each test (assertNoRealNetwork), because code may catch the thrown error and carry on.

type Offence = { kind: string; target: string; stack: string };
let offences: Offence[] = [];

const targetOf = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") return (input as { url: string }).url;
  return String(input);
};

function refuse(kind: string, target: string): never {
  const error = new Error(`Real network request in a test: ${kind} ${target}. Stub it (vi.stubGlobal("fetch", …) or mock the module that calls it); a unit test must not reach the network.`);
  error.name = "RealNetworkRequestInTest";
  offences.push({ kind, target, stack: error.stack ?? "" });
  throw error;
}

/** Fails the running test for every real request it made, even one the code under test caught. Called from setup.ts afterEach. */
export function assertNoRealNetwork(): void {
  if (offences.length === 0) return;
  const found = offences;
  offences = [];
  throw new Error(`The test made ${found.length} real network request(s):\n${found.map((o) => `  ${o.kind} ${o.target}\n${o.stack.split("\n").slice(2, 8).join("\n")}`).join("\n")}`);
}

export function forbidRealNetwork(): void {
  const scope = globalThis as Record<string, unknown>;
  const guardedFetch = function fetch(input?: unknown): never { return refuse("fetch", targetOf(input)); };
  for (const target of new Set([scope, scope.window as Record<string, unknown> | undefined])) {
    if (!target) continue;
    target.fetch = guardedFetch;
  }
  for (const name of ["WebSocket", "EventSource"] as const) {
    if (typeof scope[name] !== "function") continue;
    const guarded = class { constructor(url?: unknown) { refuse(`new ${name}`, targetOf(url)); } };
    for (const target of new Set([scope, scope.window as Record<string, unknown> | undefined])) if (target) target[name] = guarded;
  }
  const Xhr = scope.XMLHttpRequest as { prototype: { open: (...args: unknown[]) => void; send: () => void } } | undefined;
  if (Xhr) {
    const open = Xhr.prototype.open;
    let lastTarget = "";
    Xhr.prototype.open = function (this: unknown, ...args: unknown[]) { lastTarget = targetOf(args[1]); return open.apply(this, args); };
    Xhr.prototype.send = function () { return refuse("XMLHttpRequest", lastTarget); };
  }
}
