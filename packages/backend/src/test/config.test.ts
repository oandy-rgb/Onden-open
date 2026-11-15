import { afterEach, describe, expect, it, vi } from "vitest";
import { config, isProduction, isTest } from "../config.js";
import "../logger.js"; // config's warnings reach the console through the logger, which registers on load

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("config.int", () => {
  it("unset or empty gives the fallback without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(config.int("ONDEN_TEST_UNSET", 7)).toBe(7);
    vi.stubEnv("ONDEN_TEST_INT", "  ");
    expect(config.int("ONDEN_TEST_INT", 7)).toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a valid integer", () => {
    vi.stubEnv("ONDEN_TEST_INT", "42");
    expect(config.int("ONDEN_TEST_INT", 7)).toBe(42);
  });

  it("a bad or too-small value falls back and warns (never NaN)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["abc", "1.5", "-3", "0"]) {
      vi.stubEnv("ONDEN_TEST_INT", bad);
      expect(config.int("ONDEN_TEST_INT", 20, { min: 1 })).toBe(20);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toContain("ONDEN_TEST_INT");
  });
});

describe("config.is / environment checks", () => {
  it("compares the exact value", () => {
    vi.stubEnv("ONDEN_TEST_FLAG", "1");
    expect(config.is("ONDEN_TEST_FLAG", "1")).toBe(true);
    expect(config.is("ONDEN_TEST_FLAG", "on")).toBe(false);
  });

  it("isTest / isProduction follow NODE_ENV at call time", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect([isTest(), isProduction()]).toEqual([false, true]);
    vi.stubEnv("NODE_ENV", "test");
    expect([isTest(), isProduction()]).toEqual([true, false]);
  });
});

describe("config.listenHost", () => {
  it("unset or blank means all interfaces (undefined), as server and Docker deployments need", () => {
    expect(config.listenHost()).toBeUndefined();
    vi.stubEnv("ONDEN_LISTEN_HOST", "  ");
    expect(config.listenHost()).toBeUndefined();
  });

  it("the desktop value binds to loopback only", () => {
    vi.stubEnv("ONDEN_LISTEN_HOST", "127.0.0.1");
    expect(config.listenHost()).toBe("127.0.0.1");
  });
});
