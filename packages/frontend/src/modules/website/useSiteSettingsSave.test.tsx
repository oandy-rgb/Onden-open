// GAP-243: another device's newer setting must show here, and a later save on
// this device must not send the old value of a key it did not change.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SiteConfig } from "../../lib/api";
import { useSiteSettingsSave } from "./useSiteSettingsSave";

afterEach(cleanup);

type Save = { changes: SiteConfig; settle: (ok: boolean) => void };

function setup(initial: SiteConfig) {
  const saves: Save[] = [];
  const writer = {
    saveSettings: vi.fn((changes: SiteConfig) => new Promise<void>((resolve, reject) => {
      saves.push({ changes, settle: (ok) => (ok ? resolve() : reject(new Error("refused"))) });
    })),
  };
  // Runs the scheduled save at once, like autosave after its delay.
  const autosave = { schedule: vi.fn((_key: string, run: (options?: unknown) => unknown) => { void run(undefined); }) };
  const hook = renderHook(
    ({ config }: { config: SiteConfig }) => useSiteSettingsSave(
      { site_config: config },
      writer as never,
      autosave as never,
    ),
    { initialProps: { config: initial } },
  );
  return { hook, saves, writer };
}

describe("useSiteSettingsSave", () => {
  it("sends only the key that changed", async () => {
    const { hook, saves } = setup({ brand: "A", tagline: "old" });
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "B" })));
    expect(saves).toHaveLength(1);
    expect(saves[0]!.changes).toEqual({ brand: "B" });
  });

  it("shows another device's newer value once its own save has settled, and never sends it back", async () => {
    const { hook, saves } = setup({ brand: "A", tagline: "old" });
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "B" })));
    await act(async () => { saves[0]!.settle(true); });
    // Another device changed the tagline; sync brings the stored config here.
    hook.rerender({ config: { brand: "B", tagline: "from other device" } });
    expect(hook.result.current[0].tagline).toBe("from other device");
    // A later edit of a different key sends that key alone, not the old tagline.
    act(() => hook.result.current[1]((s) => ({ ...s, description: "about" })));
    expect(saves[1]!.changes).toEqual({ description: "about" });
  });

  it("keeps this device's unsaved edit over a stored value that arrives meanwhile", async () => {
    const { hook, saves } = setup({ brand: "A" });
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "mine" })));
    hook.rerender({ config: { brand: "theirs" } }); // arrives before the save settles
    expect(hook.result.current[0].brand).toBe("mine");
    await act(async () => { saves[0]!.settle(true); });
    hook.rerender({ config: { brand: "mine" } });
    expect(hook.result.current[0].brand).toBe("mine");
  });

  it("a refused save stops overriding too, so the stored value shows again", async () => {
    const { hook, saves } = setup({ brand: "A" });
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "B" })));
    await act(async () => { saves[0]!.settle(false); });
    hook.rerender({ config: { brand: "A" } });
    expect(hook.result.current[0].brand).toBe("A");
  });

  it("an edit made while a save is in flight is kept when that save settles", async () => {
    const { hook, saves } = setup({ brand: "A" });
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "B" })));
    act(() => hook.result.current[1]((s) => ({ ...s, brand: "C" })));
    await act(async () => { saves[0]!.settle(true); });
    hook.rerender({ config: { brand: "B" } }); // the first save's value comes back from the server
    expect(hook.result.current[0].brand).toBe("C");
  });
});
