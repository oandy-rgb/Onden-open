import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

beforeEach(() => { vi.resetModules(); });
afterEach(() => vi.unstubAllGlobals());

describe("page request account", () => {
  it("binds once and refuses A→B→A rebinding without changing existing work", async () => {
    const account = await import("../lib/accountStorage");
    expect(account.boundAccountId()).toBeNull();
    expect(account.bindAccountStorage("", "/")).toBe(false);
    expect(account.bindAccountStorage("a", "/")).toBe(true);
    expect(account.bindAccountStorage("b", "/")).toBe(false);
    expect(account.boundAccountId()).toBe("a");
    expect(account.bindAccountStorage("a", "/")).toBe(true);
  });

  it("JSON and raw fetch use the same expected account, preserving upload bodies and supplied headers", async () => {
    const { bindAccountStorage } = await import("../lib/accountStorage");
    const { api, apiFetch, getApiBase } = await import("../lib/api");
    bindAccountStorage("a", getApiBase());
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await api("/api/nodes/n", { method: "PATCH", body: '{"title":"A"}', headers: { "X-Onden-Expected-User": "b", "Idempotency-Key": "same-key" } });
    const body = new FormData(); body.set("file", "fixture");
    await apiFetch("/api/media/upload", { method: "POST", body });
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).get("X-Onden-Expected-User")).toBe("a");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("same-key");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).has("Content-Type")).toBe(false);
    expect(fetcher.mock.calls[1][1]?.body).toBe(body);
  });

  it("native and unbound clients retain their existing request contract", async () => {
    const { apiFetch } = await import("../lib/api");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await apiFetch("/api/bootstrap");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("X-Onden-Expected-User")).toBe(false);
  });

  it("a changed account cannot mount into the original page's workspace stores", async () => {
    const { default: Boundary } = await import("../components/AccountSessionBoundary");
    const { rerender } = render(<Boundary userId="a">A workspace</Boundary>);
    expect(screen.getByText("A workspace")).toBeInTheDocument();
    rerender(<Boundary userId="b">B workspace</Boundary>);
    expect(screen.queryByText("A workspace")).toBeNull();
    expect(screen.queryByText("B workspace")).toBeNull();
    expect(screen.getByRole("heading", { name: "Your account has changed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
  });

  it("account mismatch uses the authentication recovery policy", async () => {
    const { ApiError } = await import("../lib/api");
    const { classifyWriteFailure, writeFailureMessage } = await import("../lib/data/writeErrors");
    const error = new ApiError(401, '{"error":"account_changed"}');
    expect(classifyWriteFailure(error)).toBe("authentication");
    expect(writeFailureMessage(error)).toContain("original account");
  });
});
