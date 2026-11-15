// `?capture=1` opens the capture box; a share in the URL fills it. Either way the
// parameters are taken off the address once, so a reload does not open it again.
import { afterEach, describe, expect, it } from "vitest";
import { consumeCaptureArrival } from "../lib/captureArrival";

function visit(search: string) {
  window.history.replaceState(null, "", `/${search}#top`);
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("consumeCaptureArrival", () => {
  it("?capture=1 alone opens the box, empty, and leaves the address clean", () => {
    visit("?capture=1");
    expect(consumeCaptureArrival()).toEqual({ share: null, open: true });
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#top");
    expect(consumeCaptureArrival()).toEqual({ share: null, open: false });
  });

  it("a shared title, text or link opens the box with it", () => {
    visit("?capture=1&title=T&text=hello&url=https%3A%2F%2Fexample.com");
    expect(consumeCaptureArrival()).toEqual({ share: { title: "T", text: "hello", url: "https://example.com" }, open: true });
  });

  it("other parameters stay", () => {
    visit("?view=tasks&capture=1");
    expect(consumeCaptureArrival().open).toBe(true);
    expect(window.location.search).toBe("?view=tasks");
  });

  it("an ordinary address opens nothing", () => {
    visit("?view=tasks");
    expect(consumeCaptureArrival()).toEqual({ share: null, open: false });
    expect(window.location.search).toBe("?view=tasks");
  });
});
