import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AppErrorBoundary from "../components/AppErrorBoundary";

function Bomb(): never {
  throw new Error("kaboom-for-test");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <div>healthy app</div>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("healthy app")).toBeTruthy();
  });

  it("shows the fallback (not a white screen) when a child throws", () => {
    // React logs the error twice in dev; silence the noise, keep the assert.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    // the error text and stack are for the console, never the page
    expect(screen.queryByText(/kaboom-for-test/)).toBeNull();
  });

  it("Reload triggers location.reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(
        <AppErrorBoundary>
          <Bomb />
        </AppErrorBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("a code file that did not load offline says so, not that Onden was updated", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    function MissingChunk(): never {
      throw new TypeError("Failed to fetch dynamically imported module: /_astro/QuickCapture.js");
    }
    render(
      <AppErrorBoundary>
        <MissingChunk />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Not available offline yet")).toBeTruthy();
    expect(screen.queryByText("Onden was updated")).toBeNull();
  });
});
