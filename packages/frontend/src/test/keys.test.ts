import { describe, it, expect } from "vitest";
import { isEnterKey, isEscapeKey, isImeComposing } from "../lib/keys";

// Enter and Esc mean "submit" / "cancel" only when no input method is
// composing: in zh-TW, Enter picks a candidate and Esc drops the candidate list.

describe("lib/keys", () => {
  it("treats a composing key event as the IME's, from React or the DOM", () => {
    expect(isImeComposing({ key: "Escape", nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ key: "Escape", isComposing: true })).toBe(true);
    // Safari and older Chrome fire keydown after compositionend with keyCode 229.
    expect(isImeComposing({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: "Escape" })).toBe(false);
  });

  it("Escape cancels only outside a composition", () => {
    expect(isEscapeKey({ key: "Escape" })).toBe(true);
    expect(isEscapeKey({ key: "Escape", nativeEvent: { isComposing: true } })).toBe(false);
    expect(isEscapeKey({ key: "Escape", isComposing: true })).toBe(false);
    expect(isEscapeKey({ key: "Esc" })).toBe(false);
  });

  it("Enter submits only outside a composition", () => {
    expect(isEnterKey({ key: "Enter" })).toBe(true);
    expect(isEnterKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
  });
});
