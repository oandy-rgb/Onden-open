// The first screen of a first visit and when it appears (browserApp/startChoice.ts, StartChoice.tsx).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { needsStartChoice } from "../browserApp/startChoice";
import StartChoice from "../browserApp/StartChoice";

const first = { enabled: true, temporary: false, askedForApp: false, hadNotes: false };

describe("when the choice appears", () => {
  it("on a first visit of a build made for it", () => { expect(needsStartChoice(first)).toBe(true); });
  it("not in a build without --start-choice (the page opens straight into the app)", () => { expect(needsStartChoice({ ...first, enabled: false })).toBe(false); });
  it("not for a browser that already has notes of ours", () => { expect(needsStartChoice({ ...first, hadNotes: true })).toBe(false); });
  it("not when the address already decided: the temporary session, or ?app=1", () => {
    expect(needsStartChoice({ ...first, temporary: true })).toBe(false);
    expect(needsStartChoice({ ...first, askedForApp: true })).toBe(false);
  });
});

describe("the choice", () => {
  it("offers both ways in, each saying what it means, and calls the one pressed (zh-TW)", () => {
    const onUse = vi.fn(); const onTemporary = vi.fn();
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("zh-TW");
    render(<StartChoice onUse={onUse} onTemporary={onTemporary} />);
    expect(screen.getByText("借用別人的電腦時用：這裡寫的東西不會留在這台電腦，關掉分頁前要先下載。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在這台電腦上暫時使用" }));
    expect(onTemporary).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "開始使用" }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it("is in English for an English browser", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-US");
    render(<StartChoice onUse={() => {}} onTemporary={() => {}} />);
    expect(screen.getByRole("button", { name: "Use it temporarily on this computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start using it" })).toBeTruthy();
  });
});
