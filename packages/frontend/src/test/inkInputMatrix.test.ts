// The device's input settings × the tool × the pointer: every combination of
// who draws and who scrolls (lib/ink/inputPolicy.ts header). The pen setting
// (`penDraws`) and the finger setting (`stylusOnly`, "only scroll") are the only
// places a person chooses; the tool column is the toolbar's.
import { describe, expect, it } from "vitest";
import { InkInputPolicy, type InkInputAction, type InkPointerKind } from "../lib/ink/inputPolicy";

type Outcome = "draws" | "pans" | "nothing";

/** What a press-and-drag by this pointer does under these settings. */
function outcome(kind: InkPointerKind, o: { handTool: boolean; stylusOnly: boolean; penDraws: boolean; nativeTouch?: boolean }): Outcome {
  const policy = new InkInputPolicy({ gestures: true, ...o });
  const at = (x: number, t: number) => ({ id: 1, kind, x, y: 0, t, button: 0 });
  const actions: InkInputAction[] = [
    ...policy.down(at(0, 1000)),
    ...policy.move(at(30, 1016)),
    ...policy.move(at(60, 1032)),
    ...policy.up(at(60, 1048)),
  ];
  const types = actions.map((a) => a.type);
  if (types.includes("draw-start")) return "draws";
  if (types.includes("pan")) return "pans";
  return "nothing";
}

describe("pen", () => {
  const cases: Array<[handTool: boolean, penDraws: boolean, expected: Outcome]> = [
    [false, true, "draws"],  // a drawing tool: draws either way
    [false, false, "draws"],
    [true, true, "draws"],   // Hand / Select / Text with 「一碰就畫」: still draws (the last drawing tool)
    [true, false, "pans"],   // 「照工具列」 + Hand: the pen pans
  ];
  for (const [handTool, penDraws, expected] of cases) {
    for (const stylusOnly of [false, true]) {
      it(`${handTool ? "non-drawing tool" : "drawing tool"}, pen ${penDraws ? "draws on touch" : "follows the toolbar"}, finger ${stylusOnly ? "only scrolls" : "follows the toolbar"} → ${expected}`, () => {
        expect(outcome("pen", { handTool, stylusOnly, penDraws })).toBe(expected);
      });
    }
  }

  it("read-only: the pen never draws, whatever the setting", () => {
    const policy = new InkInputPolicy({ gestures: true, penDraws: true, readOnly: true });
    expect(policy.down({ id: 1, kind: "pen", x: 0, y: 0, t: 0, button: 0 }).map((a) => a.type)).not.toContain("draw-start");
  });

  it("space held pans with the pen even when it draws on touch (the desktop habit)", () => {
    const policy = new InkInputPolicy({ gestures: true, penDraws: true });
    policy.setSpaceHeld(true);
    const types = [
      ...policy.down({ id: 1, kind: "pen", x: 0, y: 0, t: 0, button: 0 }),
      ...policy.move({ id: 1, kind: "pen", x: 40, y: 0, t: 16 }),
    ].map((a) => a.type);
    expect(types).toEqual(["pan"]);
  });
});

describe("finger", () => {
  const cases: Array<[handTool: boolean, stylusOnly: boolean, expected: Outcome]> = [
    [false, false, "draws"], // follows the toolbar: draws with a drawing tool
    [false, true, "pans"],   // only scrolls
    [true, false, "pans"],   // Hand
    [true, true, "pans"],
  ];
  for (const [handTool, stylusOnly, expected] of cases) {
    for (const penDraws of [false, true]) {
      it(`${handTool ? "non-drawing tool" : "drawing tool"}, finger ${stylusOnly ? "only scrolls" : "follows the toolbar"}, pen ${penDraws ? "draws on touch" : "follows the toolbar"} → ${expected}`, () => {
        expect(outcome("touch", { handTool, stylusOnly, penDraws })).toBe(expected);
      });
    }
  }

  it("the pen setting never makes a finger draw: with the pen drawing everywhere, a finger on a non-drawing tool still pans", () => {
    expect(outcome("touch", { handTool: true, stylusOnly: false, penDraws: true })).toBe("pans");
  });

  it("native touch (the PDF): a finger that does not draw is left to the browser — no pan action at all", () => {
    expect(outcome("touch", { handTool: false, stylusOnly: true, penDraws: true, nativeTouch: true })).toBe("nothing");
  });
});

describe("mouse", () => {
  it("is unaffected by the pen setting: a drawing tool draws, Hand pans", () => {
    for (const penDraws of [false, true]) {
      expect(outcome("mouse", { handTool: false, stylusOnly: true, penDraws })).toBe("draws");
      expect(outcome("mouse", { handTool: true, stylusOnly: false, penDraws })).toBe("pans");
    }
  });
});

describe("a pen on a non-drawing tool with 「一碰就畫」 still wins over a resting palm", () => {
  it("the finger that lands after the pen is ignored", () => {
    const policy = new InkInputPolicy({ gestures: true, handTool: true, penDraws: true });
    expect(policy.down({ id: 1, kind: "pen", x: 0, y: 0, t: 0, button: 0 }).map((a) => a.type)).toEqual(["draw-start"]);
    expect(policy.down({ id: 2, kind: "touch", x: 200, y: 200, t: 100 })).toEqual([]);
    expect(policy.move({ id: 2, kind: "touch", x: 260, y: 200, t: 116 })).toEqual([]);
  });
});
