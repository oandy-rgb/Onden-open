import { afterEach, describe, expect, it } from "vitest";
import { shouldSkipServerSetup } from "./api";

// shouldSkipServerSetup decides whether the "Connect to backend server"
// (ServerSetup) jargon wall must appear. The dealbreaker bug was that every
// newcomer hit that wall; the common same-origin case must skip it.
describe("shouldSkipServerSetup", () => {
  afterEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("skips the wall for the common same-origin browser case (no config)", () => {
    // No native flag, no baked base, empty localStorage → still skip in a
    // browser, because relative /api works through the reverse proxy.
    expect(
      shouldSkipServerSetup({ isNative: false, hasBuiltInBase: false, inBrowser: true }),
    ).toBe(true);
  });

  it("shows the wall only when there is no browser to reach same-origin (SSR, no config)", () => {
    expect(
      shouldSkipServerSetup({ isNative: false, hasBuiltInBase: false, inBrowser: false }),
    ).toBe(false);
  });

  it("shows the wall in a native shell with no server saved (no same-origin backend there)", () => {
    expect(
      shouldSkipServerSetup({ isNative: true, hasBuiltInBase: false, inBrowser: true }),
    ).toBe(false);
  });

  it("skips the wall in a native shell once a server is saved", () => {
    localStorage.setItem("onden_api_base", "https://my.onden.example");
    expect(
      shouldSkipServerSetup({ isNative: true, hasBuiltInBase: false, inBrowser: true }),
    ).toBe(true);
  });

  it("skips the wall when the build baked a PUBLIC_API_BASE_URL (even empty)", () => {
    expect(
      shouldSkipServerSetup({ isNative: false, hasBuiltInBase: true, inBrowser: false }),
    ).toBe(true);
  });

  it("skips the wall when an explicit backend URL is stored", () => {
    localStorage.setItem("onden_api_base", "https://my.onden.example");
    expect(
      shouldSkipServerSetup({ isNative: false, hasBuiltInBase: false, inBrowser: false }),
    ).toBe(true);
  });
});
