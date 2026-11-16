// The one place the backend carries "who and what is this call part of" across
// awaits: the open transaction (db.ts), the cascade's root actor (spine/mutate),
// post-commit hooks (spine/txHooks), the idempotency key, the agent-tool chain,
// the tag dispatch chain and an MCP request's actor.
//
//   const slot = createContextSlot<Tx>();
//   await slot.run(tx, async () => { … await somethingDeeper(); slot.getStore() === tx … });
//
// A slot is a typed AsyncLocalStorage-shaped cell (`run`, `getStore`, nothing
// else — that is all the backend ever used). What backs it is a ContextProvider:
//
//   • Node (default): AsyncLocalStorage. Context follows every await, timer and
//     promise callback started inside run(), however many requests overlap.
//   • Serial stack (createSerialContextProvider): for a host that runs ONE flow at
//     a time (the in-browser backend: PGlite has a single connection anyway). The
//     "current" context is the innermost run() still on the stack. It needs no
//     zone.js, no async-hooks and does not touch the global Promise. Its contract
//     and limits are in docs/architecture/portable-backend.md.
//
// Only this file may touch `node:async_hooks` (allowlist rule be-async-hooks).
// A host that is not Node installs its provider with useContextProvider() before
// the first slot is used (before importing app.ts).

import { nodeBuiltin } from "./nodeBuiltins.js";

export interface ContextSlot<T> {
  /** Run `fn` with `value` as the current context for everything it starts. */
  run<R>(value: T, fn: () => R): R;
  /** The innermost enclosing run()'s value, or undefined outside any. */
  getStore(): T | undefined;
}

export interface ContextProvider {
  readonly name: string;
  createSlot<T>(): ContextSlot<T>;
}

let provider: ContextProvider | null = null;
let slotsCreated = 0;

/** Install the provider for this process. Must run before any slot is used. */
export function useContextProvider(next: ContextProvider): void {
  if (provider && provider !== next && slotsCreated > 0) {
    throw new Error("request context provider must be installed before any context slot is used");
  }
  provider = next;
}

/** AsyncLocalStorage-backed provider (the default on Node). */
export function createNodeContextProvider(): ContextProvider {
  const asyncHooks = nodeBuiltin<typeof import("node:async_hooks")>("node:async_hooks");
  if (!asyncHooks) {
    throw new Error("no request context provider: not running on Node, call useContextProvider() first");
  }
  return { name: "async-local-storage", createSlot: <T>() => new asyncHooks.AsyncLocalStorage<T>() };
}

export function createContextSlot<T>(): ContextSlot<T> {
  // Resolved on first use, so a module can create its slot at import time and a
  // browser host can still install its provider before the first request.
  let backing: ContextSlot<T> | null = null;
  const slot = (): ContextSlot<T> => {
    if (!backing) {
      provider ??= createNodeContextProvider();
      slotsCreated++;
      backing = provider.createSlot<T>();
    }
    return backing;
  };
  return { run: (value, fn) => slot().run(value, fn), getStore: () => slot().getStore() };
}

/** For a host that serialises every flow (requests AND background work) through
 *  one queue. run() pushes the value, and pops it when fn's promise settles.
 *  Anything running while another flow is mid-await would see that flow's
 *  context, which is why the host must never overlap flows. */
export function createSerialContextProvider(): ContextProvider {
  return {
    name: "serial-stack",
    createSlot<T>(): ContextSlot<T> {
      const stack: T[] = [];
      return {
        run<R>(value: T, fn: () => R): R {
          stack.push(value);
          const pop = () => {
            const at = stack.lastIndexOf(value);
            if (at >= 0) stack.splice(at, 1);
          };
          let result: R;
          try {
            result = fn();
          } catch (error) {
            pop();
            throw error;
          }
          if (result && typeof (result as { then?: unknown }).then === "function") {
            return (result as unknown as Promise<unknown>).finally(pop) as R;
          }
          pop();
          return result;
        },
        getStore: () => stack[stack.length - 1],
      };
    },
  };
}

/** The device (X-Onden-Device-Id) the request in flight came from, for the event its write appends
 *  (db.ts insertEvent). Set per request by the middleware in app.ts, so a cascade started by that
 *  request keeps its root's device; background work and tokens run outside any request and have none. */
const requestDevice = createContextSlot<string>();
export const withRequestDevice = <R>(deviceId: string, fn: () => R): R => requestDevice.run(deviceId, fn);
export const currentDeviceId = (): string | undefined => requestDevice.getStore();

/** The sign-in session (better-auth's session id) the request arrived with, set by the actor middleware in app.ts for a person's request. Bearer tokens, native
 *  requests and background work have none. Read by services/freshProof.ts, which binds a ticket to the session it was handed to. */
const requestSession = createContextSlot<string>();
export const withRequestSession = <R>(sessionId: string, fn: () => R): R => requestSession.run(sessionId, fn);
export const currentSessionId = (): string | undefined => requestSession.getStore();
