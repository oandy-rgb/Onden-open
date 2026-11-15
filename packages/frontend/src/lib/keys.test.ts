import { describe, expect, it, vi } from "vitest";
import { isEnterKey, isImeComposing, onEnter } from "./keys";

const key = (k: string, native: { isComposing?: boolean; keyCode?: number } = {}) => ({ key: k, nativeEvent: native });

describe("Enter vs IME composition", () => {
  it("a plain Enter submits", () => {
    expect(isEnterKey(key("Enter"))).toBe(true);
    expect(isEnterKey(key("a"))).toBe(false);
  });
  it("Enter that confirms a candidate does not (isComposing, or keyCode 229)", () => {
    expect(isImeComposing(key("Enter", { isComposing: true }))).toBe(true);
    expect(isEnterKey(key("Enter", { isComposing: true }))).toBe(false);
    expect(isEnterKey(key("Enter", { keyCode: 229 }))).toBe(false);
  });
  it("reads a DOM KeyboardEvent too", () => {
    expect(isEnterKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isEnterKey({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
  });
  it("onEnter runs the handler only on a plain Enter", () => {
    const handler = vi.fn();
    const onKeyDown = onEnter(handler);
    onKeyDown(key("Enter", { isComposing: true }));
    onKeyDown(key("x"));
    expect(handler).not.toHaveBeenCalled();
    onKeyDown(key("Enter"));
    expect(handler).toHaveBeenCalledOnce();
  });
});
