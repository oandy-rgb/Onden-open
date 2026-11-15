// The sign-in page loads only the gate: server setup, LoginGate, the auth
// client. The workspace is its own chunk (components/BuilderWorkspace.tsx),
// fetched after the session is known (or early, on a device that was signed in
// here before). docs/archive/research/perf-logged-in-2026-10-21.md, section A.
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = resolve(__dirname, "..");

/** Files reachable from `entry` through static import/export-from (not import()). */
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  const resolveSpec = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
      .find((c) => existsSync(c) && statSync(c).isFile());
  };
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s*["'](\.[^"']+)["']|^\s*import\s*["'](\.[^"']+)["']/gm)) {
      const next = resolveSpec(file, m[1] ?? m[2]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe("what the sign-in page statically imports", () => {
  const closure = [...staticClosure(join(SRC, "AppRoot.tsx"))].map((f) => relative(SRC, f));

  it.each([
    "components/BuilderWorkspace.tsx",
    "lib/data/index.ts",
    "lib/appStore.ts",
    "settings/registry.tsx",
    "lib/localDb.ts",
    "components/KnowledgeWorkspace.tsx",
  ])("does not include %s", (file) => {
    expect(closure).not.toContain(file);
  });

  it("does include the gate", () => {
    expect(closure).toEqual(expect.arrayContaining(["components/LoginGate.tsx", "components/ServerSetup.tsx", "lib/auth-client.ts"]));
  });
});

const loads = vi.hoisted(() => ({ workspace: vi.fn(), signedIn: false }));
vi.mock("../components/BuilderWorkspace", () => {
  loads.workspace();
  return { default: () => <div>workspace</div> };
});
vi.mock("../components/LoginGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => (loads.signedIn ? <>{children}</> : <div>login form</div>),
}));
vi.mock("../components/ServerSetup", () => ({ default: () => null }));
vi.mock("../lib/api", () => ({ shouldSkipServerSetup: () => true, getApiBase: () => "" }));

describe("BuilderApp", () => {
  beforeEach(() => {
    vi.resetModules();
    loads.workspace.mockClear();
    loads.signedIn = false;
    localStorage.clear();
  });
  afterEach(() => { localStorage.clear(); });

  it("does not load the workspace for a signed-out visitor with no earlier sign-in", async () => {
    const { default: BuilderApp } = await import("../components/BuilderApp");
    render(<BuilderApp />);
    expect(await screen.findByText("login form")).toBeTruthy();
    expect(loads.workspace).not.toHaveBeenCalled();
  });

  it("starts loading the workspace at once on a device that was signed in here before", async () => {
    localStorage.setItem("onden_verified_account", JSON.stringify({ server: window.location.origin, userId: "u1" }));
    // A fresh factory: vi.resetModules keeps the hoisted mock's evaluated module.
    vi.doMock("../components/BuilderWorkspace", () => {
      loads.workspace();
      return { default: () => <div>workspace</div> };
    });
    const { default: BuilderApp } = await import("../components/BuilderApp");
    render(<BuilderApp />);
    await waitFor(() => expect(loads.workspace).toHaveBeenCalledOnce());
    expect(screen.getByText("login form")).toBeTruthy();
  });

  it("shows the workspace once the gate lets it through", async () => {
    loads.signedIn = true;
    const { default: BuilderApp } = await import("../components/BuilderApp");
    render(<BuilderApp />);
    expect(await screen.findByText("workspace")).toBeTruthy();
  });
});
