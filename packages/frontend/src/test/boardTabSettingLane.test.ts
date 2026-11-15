import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./helpers/propsConfig";

// The server's copy of one board's whiteboard tab, and a slow connection: an update lands after `delay` ticks.
const server = vi.hoisted(() => ({ config: {} as Record<string, unknown>, delay: 0, updates: 0, bodies: [] as unknown[] }));
vi.mock("../lib/data", () => ({
  runBackgroundWrite: () => {},
  viewWriter: {
    // The server's rule: named keys change, null removes one, the rest stays as the server has it right now.
    update: async (_owner: unknown, _id: string, body: { layout_config_patch: Record<string, unknown> }) => {
      server.updates += 1;
      server.bodies.push(body);
      for (let i = 0; i < server.delay; i += 1) await Promise.resolve();
      const next = { ...server.config };
      for (const [key, value] of Object.entries(body.layout_config_patch)) { if (value === null) delete next[key]; else next[key] = value; }
      server.config = next;
    },
  },
}));
vi.mock("../lib/ownerViews", () => ({
  peekOwnerViews: () => [{ id: "tab", layout: "canvas", layout_config: server.config }],
  reloadOwnerViews: async () => {},
  useOwnerViews: () => ({ views: [] }),
}));
vi.mock("../lib/whiteboardTab", () => ({ ensureWhiteboardTab: async () => {} }));
import { writeBoardTabSetting, type BoardTabSetting } from "../hooks/useBoardTabSetting";

const keyed = (key: string): BoardTabSetting<number> => ({
  read: (config) => Number(config?.[key] ?? 0),
  write: (config, value) => ({ ...config, [key]: value }),
});
beforeEach(() => { server.config = {}; server.delay = 0; server.updates = 0; server.bodies = []; });

// Scan 08 #5b: two settings saved at once (the tree's key and the card display's key) must both be kept.
describe("settings of one board's tab are written one after another", () => {
  it("the tree key and the display key saved together both end up stored", async () => {
    server.delay = 3;
    await Promise.all([writeBoardTabSetting("board", keyed("tree"), 1), writeBoardTabSetting("board", keyed("display"), 2)]);
    expect(server.config).toEqual({ tree: 1, display: 2 });
  });

  it("random concurrent saves: every key ends as its last save said, and no write is lost or reordered", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ key: fc.constantFrom("tree", "display", "hidden"), value: fc.nat(9) }), { minLength: 1, maxLength: 8 }),
      fc.nat(4),
      async (saves, delay) => {
        server.config = {}; server.delay = delay; server.updates = 0;
        await Promise.all(saves.map((s) => writeBoardTabSetting("board", keyed(s.key), s.value)));
        const expected: Record<string, number> = {};
        for (const s of saves) expected[s.key] = s.value;
        expect(server.config).toEqual(expected);
        expect(server.updates).toBe(saves.length);
      },
    ), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });

  it("a failed save does not stop the ones after it", async () => {
    const first = writeBoardTabSetting("board", { read: () => 0, write: () => { throw new Error("no"); } }, 1);
    const second = writeBoardTabSetting("board", keyed("tree"), 5);
    await expect(first).rejects.toThrow("no");
    await second;
    expect(server.config).toEqual({ tree: 5 });
  });
});

// Scan 08 #5a: two devices. This device's copy of the tab is the screen's last read (`peekOwnerViews`); the other
// device changes the server's copy meanwhile. A write names only its own key, so the other device's key survives.
describe("two devices changing different settings of one board", () => {
  it("fixed case: this device saves `tree` from a copy that lacks `display`, which the other device set", async () => {
    const stale = {};
    server.config = { display: 2 };
    const peek = vi.spyOn(await import("../lib/ownerViews"), "peekOwnerViews");
    peek.mockReturnValue([{ id: "tab", layout: "canvas", layout_config: stale } as never]);
    await writeBoardTabSetting("board", keyed("tree"), 1);
    expect(server.config).toEqual({ display: 2, tree: 1 });
    expect(server.bodies).toEqual([{ layout_config_patch: { tree: 1 } }]);
    peek.mockRestore();
  });

  it("random: the other device's keys, set after this device read its copy, are never lost; the same key is last write wins", async () => {
    const ownerViews = await import("../lib/ownerViews");
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ key: fc.constantFrom("tree", "display", "hidden"), value: fc.nat(9) }), { maxLength: 4 }),
      fc.array(fc.record({ key: fc.constantFrom("tree", "display", "hidden"), value: fc.nat(9) }), { minLength: 1, maxLength: 6 }),
      async (otherDevice, mine) => {
        const copy = {};
        server.config = {}; server.delay = 0;
        const peek = vi.spyOn(ownerViews, "peekOwnerViews").mockReturnValue([{ id: "tab", layout: "canvas", layout_config: copy } as never]);
        for (const o of otherDevice) server.config = { ...server.config, [o.key]: o.value };
        const before = { ...server.config };
        for (const m of mine) await writeBoardTabSetting("board", keyed(m.key), m.value);
        peek.mockRestore();
        const written = new Set<string>(mine.map((m) => m.key));
        for (const [key, value] of Object.entries(before)) if (!written.has(key)) expect(server.config[key]).toBe(value);
        for (const key of written) expect(server.config[key]).toBe(mine.filter((m) => m.key === key).at(-1)!.value);
      },
    ), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });
});
