import { describe, expect, it } from "vitest";
import { createSyncedPrefStore } from "../lib/syncedPrefStore";

const memory = () => {
  let copy: unknown = null;
  return { scope: () => "me", read: () => copy, write: (next: unknown) => { copy = next; }, clear: () => { copy = null; } };
};

describe("forget()", () => {
  it("drops the answer of a sync that was already on its way", async () => {
    let answer: (value: string) => void = () => {};
    const local = memory();
    const store = createSyncedPrefStore<string>({
      load: () => new Promise<string>((resolve) => { answer = resolve; }),
      save: async (value) => value,
    }, local, (value) => (typeof value === "string" ? value : null));
    const late = store.sync();
    // The local copy is replaced from outside (another account, a test's reset)…
    local.clear();
    store.forget();
    // …and the earlier read answers only now: it is about a copy that is gone.
    answer("old");
    await late;
    expect(store.get().value).toBeNull();
    expect(local.read()).toBeNull();
  });
});

// Logseq 2.0.2 cross-check: a missing or unreadable stored value never blocks saving a new one.
describe("an unreadable stored value", () => {
  const toText = (value: unknown) => (typeof value === "string" ? value : null);

  it("a damaged local copy reads as no value and the next save still goes through", async () => {
    const saved: unknown[] = [];
    const local = { scope: () => "me", read: () => "{not json", write: () => {}, clear: () => {} };
    const store = createSyncedPrefStore<string>({ load: async () => null, save: async (value) => { saved.push(value); return value; } }, local, toText);
    expect(store.get().value).toBeNull();
    store.save("dark");
    await store.sync();
    expect(store.get().value).toBe("dark");
    expect(saved).toEqual(["dark"]);
  });

  // (createAccountPref.load parses the server value before the store sees it.)
  it("a server value of the wrong shape reads as none, and saving replaces it", async () => {
    const saved: unknown[] = [];
    const store = createSyncedPrefStore<string>({ load: async () => toText(42), save: async (value) => { saved.push(value); return value; } }, memory(), toText);
    await store.sync();
    expect(store.get().value).toBeNull();
    store.save("light");
    await store.sync();
    expect(saved).toEqual(["light"]);
  });
});
