import { describe, expect, it } from "vitest";
import { shouldUrgeHomeScreen } from "../lib/browserAppInstall";

// When the trial version urges "add to the Home Screen" (lib/browserAppInstall.ts): an iPad or iPhone whose Safari clears a
// site's data after seven days without a visit, unless the app runs from the Home Screen.
const env = (over: Partial<Parameters<typeof shouldUrgeHomeScreen>[0]>) => ({ userAgent: "", platform: "", hasTouch: false, standalone: false, ...over });

describe("urging the Home Screen", () => {
  it("an iPhone and an iPad in Safari are urged; an iPad calls itself a Mac and is known by taking touch", () => {
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", hasTouch: true }))).toBe(true);
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", hasTouch: true }))).toBe(true);
  });

  it("not once it runs from the Home Screen", () => {
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", platform: "iPad", hasTouch: true, standalone: true }))).toBe(false);
  });

  it("not a Mac without touch, an Android phone or a desktop browser", () => {
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", hasTouch: false }))).toBe(false);
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130", platform: "Linux armv81", hasTouch: true }))).toBe(false);
    expect(shouldUrgeHomeScreen(env({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130", platform: "Linux x86_64", hasTouch: false }))).toBe(false);
  });
});
