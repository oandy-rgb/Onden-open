// serverTruth.ts is a late chunk (lib/data/serverTruthLoad.ts). After a deploy its file can be gone while this page
// still runs the old build; a note opened then (syncEngine.hydrateNode) has no way to read the server's row. Review of
// #1794 (second half, point 6): asked again, still missing while online, the person is told once to reload the page.
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/data/serverTruth", () => { throw new TypeError("Failed to fetch dynamically imported module"); });
const toasts = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock("../lib/appStore", async (original) => ({
  ...await original<typeof import("../lib/appStore")>(),
  addToast: (message: string, kind: string) => { toasts.push([message, kind]); },
}));
const online = vi.hoisted(() => ({ value: false }));
vi.mock("../lib/browserNetwork", async (original) => ({
  ...await original<typeof import("../lib/browserNetwork")>(),
  isBrowserOnline: () => online.value,
}));

import { serverTruthOrTell } from "../lib/data/serverTruthLoad";

describe("the late chunk of the server's answers cannot load", () => {
  it("offline: nothing is said (the stored body stays); online: the person is told once to reload", async () => {
    expect(await serverTruthOrTell()).toBeNull();
    expect(toasts).toEqual([]);
    online.value = true;
    expect(await serverTruthOrTell()).toBeNull();
    expect(await serverTruthOrTell()).toBeNull();
    expect(toasts).toEqual([["This version of the app is out of date. Reload the page.", "warning"]]);
  });
});
