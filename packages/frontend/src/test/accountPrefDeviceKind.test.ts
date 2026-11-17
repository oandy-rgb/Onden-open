import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccountStorage } from "../lib/accountStorage";
import { setPrefJson, type Pref } from "../lib/prefs";

// What the account holds on the server: key → value. Reads and writes go through it.
const server = new Map<string, unknown>();
const writes: { path: string; value: unknown }[] = [];
let mobile = false;
vi.mock("../lib/data", () => ({
  reads: { people: { myPref: async (key: string) => ({ value: server.get(key) ?? null }) } },
  accountPrefWriter: {
    save: async (key: string, body: { value: unknown }) => {
      writes.push({ path: `/api/me/prefs/${key}`, value: body.value });
      server.set(key, body.value);
    },
  },
}));
vi.mock("../lib/mediaQuery", async (original) => ({
  ...await original<typeof import("../lib/mediaQuery")>(),
  isMobileLayout: () => mobile,
  mediaQueryList: () => null,
}));

const { createAccountPref } = await import("../lib/accountPrefStore");

const copy: Pref = { key: "onden.test.paneCopy", scope: "account" };
const parse = (value: unknown) => (typeof value === "string" ? value : null);
const make = () => createAccountPref<string>({ serverKey: "pane", follows: "deviceKind", copy, parse });

describe("createAccountPref follows: deviceKind", () => {
  beforeEach(() => {
    localStorage.clear();
    server.clear();
    writes.length = 0;
    mobile = false;
    bindAccountStorage("me", "https://onden.test");
  });

  it("keeps one value per kind of screen and writes each under its own key", async () => {
    const pref = make();
    pref.store.save("desktop-value");
    await pref.store.sync();
    mobile = true;
    expect(pref.store.get().value).toBeNull();
    pref.store.save("phone-value");
    await pref.store.sync();
    expect(writes).toEqual([
      { path: "/api/me/prefs/pane.desktop", value: "desktop-value" },
      { path: "/api/me/prefs/pane.phone", value: "phone-value" },
    ]);
    mobile = false;
    expect(pref.store.get().value).toBe("desktop-value");
  });

  it("a second device of the other kind does not see this kind's value", async () => {
    server.set("pane.desktop", "from-desktop");
    mobile = true;
    const phone = make();
    await phone.store.sync();
    expect(phone.store.get().value).toBeNull();
    mobile = false;
    const desktop = make();
    await desktop.store.sync();
    expect(desktop.store.get().value).toBe("from-desktop");
  });

  it("starts each kind from the old single value, on the server and in the local copy", async () => {
    server.set("pane", "old");
    const pref = make();
    await pref.store.sync();
    expect(pref.store.get().value).toBe("old");
    mobile = true;
    await pref.store.sync();
    expect(pref.store.get().value).toBe("old");
    expect(writes).toEqual([]); // reading the old value writes nothing

    localStorage.clear();
    bindAccountStorage("me", "https://onden.test");
    setPrefJson(copy, { value: "old-local", dirty: false, editedAt: null });
    expect(make().store.get().value).toBe("old-local");
  });
});
