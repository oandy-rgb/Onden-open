// The engine keeps the last drawing tool apart from Hand, so a pen that draws
// in every tool (inputPolicy `penDraws`) knows what to draw with.
import { describe, expect, it, vi } from "vitest";
import { InkEngine } from "../lib/ink/engine";
import { getFingerSetting, notePenSeen, setFingerSetting } from "../lib/inkInputPrefs";

function engine(options: { penDraws?: boolean; onPenSeen?: () => void } = {}) {
  const committed = document.createElement("canvas");
  const wet = document.createElement("canvas");
  return new InkEngine({ committedCanvas: committed, wetCanvas: wet, gestures: { pan: () => {}, zoom: () => {} }, ...options });
}

describe("InkEngine tool vs Hand", () => {
  it("getTool says Hand while it is on, and the drawing tool comes back as it was", () => {
    const e = engine();
    e.setTool("highlighter");
    e.setTool("hand");
    expect(e.getTool()).toBe("hand");
    e.setTool("eraser");
    expect(e.getTool()).toBe("eraser");
    e.setTool("hand");
    e.setTool("pen");
    expect(e.getTool()).toBe("pen");
    e.destroy();
  });

  it("the first pen touch tells the host once", () => {
    const onPenSeen = vi.fn();
    const e = engine({ onPenSeen });
    const el = document.createElement("div");
    const dispose = e.addPointerHandlers(el);
    const pen = (id: number) => { const ev = new Event("pointerdown", { bubbles: true, cancelable: true }); Object.assign(ev, { pointerType: "pen", pointerId: id, clientX: 1, clientY: 1, button: 0, buttons: 1, pressure: 0.5 }); el.dispatchEvent(ev); };
    pen(1);
    pen(2);
    expect(onPenSeen).toHaveBeenCalledTimes(1);
    dispose();
    e.destroy();
  });
});

describe("the first pen puts a new device into pen mode", () => {
  it("a device that never chose: fingers go to 'only scroll' once", () => {
    localStorage.clear();
    expect(getFingerSetting()).toBe("toolbar");
    expect(notePenSeen()).toBe(true);
    expect(getFingerSetting()).toBe("scroll");
    setFingerSetting("toolbar"); // the person turns 「手指也能畫」 back on
    expect(notePenSeen()).toBe(false);
    expect(getFingerSetting()).toBe("toolbar");
    localStorage.clear();
  });

  it("an explicit earlier choice (even 'follows the toolbar') is never overridden", () => {
    localStorage.clear();
    setFingerSetting("toolbar");
    expect(notePenSeen()).toBe(false);
    expect(getFingerSetting()).toBe("toolbar");
    localStorage.clear();
  });
});
