// 設定 › AI, an AI that connects with a connection code: the one-time steps (order, what each copy button copies, leaving
// before copying), the card's status from facts (never / lately / before), and that an open page notices a connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(), postRead: vi.fn() }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { api } from "../lib/api";
import { confirmDialog } from "../components/ConfirmDialog";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetSpacesForTest } from "../lib/spaces";
import AiSettings from "../settings/ai";
import ConnectionCodeSteps from "../settings/ai/ConnectionCodeSteps";
import { roleState } from "../settings/ai/model";
import { pageOrigin } from "../lib/pageUrl";
import { REFRESH_MS } from "../settings/ai/useAiPage";
import type { AiRoleInfo } from "../settings/ai/aiRoleInfo";
import type { SettingContext } from "../lib/settingsTypes";

/** The address the page tells an AI to connect to (ConnectionCodeSteps), and how long a connection counts as recent (settings/ai/model.ts). */
const connectAddress = (): string => `${pageOrigin()}/api/mcp/protocol`;
const CONNECTED_RECENTLY_MS = 2 * 60_000;

const apiMock = vi.mocked(api);
const confirmMock = vi.mocked(confirmDialog);
const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() } as unknown as SettingContext;
const CODE = "onden_0123456789abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

beforeEach(() => {
  confirmMock.mockClear(); confirmMock.mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("連線碼的步驟", () => {
  const renderFresh = (onDone = vi.fn()) => {
    render(<ConnectionCodeSteps fresh={{ aiName: "Helper", plaintext: CODE }} onDone={onDone} />);
    return { user: userEvent.setup(), onDone };
  };

  it("says whose code it is by the AI's name, and says 'shown only once' once", () => {
    renderFresh();
    expect(screen.getByText("Connection code of Helper")).toBeInTheDocument();
    expect(screen.getAllByText(/only this once|only once|never be shown again/i)).toHaveLength(1);
  });

  it("is one numbered list: step 1 holds the code, step 2 the address under its sentence, step 3 where the code goes", () => {
    renderFresh();
    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(within(steps[0]!).getByText(CODE)).toBeInTheDocument();
    expect(within(steps[0]!).getByRole("button", { name: "Copy connection code" })).toBeInTheDocument();
    expect(within(steps[1]!).getByText(connectAddress())).toBeInTheDocument();
    expect(within(steps[1]!).getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    // The sentence comes before its address, which comes before its button.
    const sentence = within(steps[1]!).getByText(/add a new MCP server/);
    const address = within(steps[1]!).getByText(connectAddress());
    expect(sentence.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(steps[2]!).queryByRole("button")).toBeNull();
    expect(steps[2]!.textContent).toMatch(/paste the connection code/);
  });

  it("each copy button copies exactly its own string; copying the code is the main (primary) action", async () => {
    const { user } = renderFresh();
    const copyCode = screen.getByRole("button", { name: "Copy connection code" });
    expect(copyCode.className).toMatch(/primary/);
    // user-event's own clipboard stands in for the browser's: what the button wrote is what a paste would give.
    await user.click(copyCode);
    expect(await navigator.clipboard.readText()).toBe(CODE);
    await user.click(screen.getByRole("button", { name: "Copy address" }));
    expect(await navigator.clipboard.readText()).toBe(connectAddress());
    expect(screen.getByText(CODE).tagName).toBe("CODE");
    expect(screen.getByText(connectAddress()).tagName).toBe("CODE");
  });

  it("tells that questions from inside Onden need a program that fetches them, and names no product", () => {
    renderFresh();
    expect(screen.getByText(/keeps fetching them/)).toBeInTheDocument();
  });

  it("leaving before the code was copied asks first; no leaves it open, yes leaves", async () => {
    const { user, onDone } = renderFresh();
    confirmMock.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0]![0])).toMatch(/revoke it on the AI's card and make another/);
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("leaving after the code was copied does not ask", async () => {
    const { user, onDone } = renderFresh();
    await user.click(screen.getByRole("button", { name: "Copy connection code" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("copying the address alone does not count as copying the code", async () => {
    const { user } = renderFresh();
    await user.click(screen.getByRole("button", { name: "Copy address" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });
});

const NOW = Date.parse("2026-11-14T12:00:00Z");
const mcpRole = (seenAt: string | null, over: Partial<AiRoleInfo> = {}): AiRoleInfo => ({
  actor_id: "ai", handle: "ai", name: "Helper", enabled: true, default_runtime: "mcp",
  runtimes: [{ kind: "mcp", available: true, unavailable_reason: null, last_seen_at: seenAt }],
  review_rule: "suggest", review_rule_locked: false, spaces: {},
  usage_this_month: { input_tokens: 0, output_tokens: 0, cost_estimate_micro_usd: null }, runner_seen_at: null, api: null, ...over,
});
const code = { kind: "code" as const, code: { kind: "code" as const, id: "t1", actorId: "ai", name: "x", lastUsedAt: null, access: "write" as const } };

describe("狀態來自事實", () => {
  it("never connected is waiting, not ready; lately is ready; before is away with the time", () => {
    expect(roleState(mcpRole(null), code, NOW)).toEqual({ state: "waiting" });
    expect(roleState(mcpRole(new Date(NOW - 30_000).toISOString()), code, NOW)).toEqual({ state: "ready" });
    const old = new Date(NOW - CONNECTED_RECENTLY_MS - 1000).toISOString();
    expect(roleState(mcpRole(old), code, NOW)).toEqual({ state: "away", seenAt: old });
  });
  it("a code AI whose connection code is missing or paused is not 'waiting'", () => {
    expect(roleState(mcpRole(null, { enabled: false }), code, NOW)).toEqual({ state: "paused" });
    expect(roleState(mcpRole(null), { kind: "none" }, NOW)).toMatchObject({ state: "off" });
  });
});

describe("設定 › AI 卡片上的連線狀態", () => {
  let role: AiRoleInfo;
  beforeEach(() => {
    resetAppState(); resetSpacesForTest();
    setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules: ["ai"] } } }));
    role = mcpRole(null);
    apiMock.mockImplementation((async (path: string) => {
      if (path === "/api/spaces") return { spaces: [], is_owner: true };
      if (path === "/api/ai/status") return { api_runtime_offered: false };
      if (path === "/api/ai/roles") return { roles: [role] };
      if (/^\/api\/actors\/[^/]+\/tokens$/.test(path)) return [{ id: "t1", name: "x", access: "write", last_used_at: null, revoked_at: null }];
      return { ok: true };
    }) as never);
  });

  const pill = () => document.querySelector(".ai-state")!.textContent;
  const rolesCalls = () => apiMock.mock.calls.filter(([path]) => path === "/api/ai/roles").length;

  it("never connected says it is waiting, with no full stop in the pill", async () => {
    render(<AiSettings ctx={ctx} />);
    await screen.findByText(/Nothing has connected yet/);
    expect(pill()).toBe("Waiting for it to connect");
  });

  it("connected lately says connected; connected before says when it last came", async () => {
    role = mcpRole(new Date(Date.now() - 20_000).toISOString());
    const view = render(<AiSettings ctx={ctx} />);
    await screen.findByText(/Last connected/);
    expect(pill()).toBe("Connected");
    view.unmount();
    role = mcpRole(new Date(Date.now() - 3 * 3600_000).toISOString());
    render(<AiSettings ctx={ctx} />);
    await screen.findByText(/Last connected/);
    expect(pill()).toBe("Not connected now");
  });

  it("an open page notices the connection without a reload: on a timer, and when the person comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AiSettings ctx={ctx} />);
    await screen.findByText(/Nothing has connected yet/);
    const before = rolesCalls();
    role = mcpRole(new Date().toISOString());
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS + 100); });
    await waitFor(() => expect(pill()).toBe("Connected"));
    expect(rolesCalls()).toBeGreaterThan(before);
    // Coming back to the tab reads again at once.
    const mid = rolesCalls();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(rolesCalls()).toBeGreaterThan(mid));
  });
});
