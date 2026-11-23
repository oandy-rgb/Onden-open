import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components", name), "utf8");

// With the on-screen keyboard up the window is ~370px tall (Galaxy Tab S9, measured by the owner) and the place
// list showed a row and a half. The list takes what its card leaves; nothing guesses the card's chrome in px.
describe("the place list's height", () => {
  it("is not a height minus a guessed amount of chrome", () => {
    expect(css("PlacePicker.css")).not.toMatch(/max-height:[^;]*dvh\s*-\s*\d+px/);
  });
  it("the create popover's card is bounded by what can be seen above the keyboard (usePopover's room)", () => {
    expect(css("CreateSheet.css")).toMatch(/\.create-sheet\s*\{[^}]*max-height:[^;]*var\(--popover-room/);
  });
});
