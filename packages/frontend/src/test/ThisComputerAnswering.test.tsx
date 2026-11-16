// 「Answer with the AI on this computer」: not offered in a browser; in the desktop app one button per target, with
// the shell's refusals worded plainly, nothing made on the server when the shell would refuse, the connection code
// handed over once and never shown, and 「Turn off」 stopping the shell first and then revoking the code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../settings/ai/actions", () => ({
  createAiWithConnection: vi.fn(), giveCode: vi.fn(), revokeCodeNow: vi.fn(async () => true), ensureAiModuleOn: vi.fn(async () => {}),
}));
const tokenLists: Record<string, Array<{ id: string; revoked_at: string | null }>> = {};
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, reads: { ...real.reads,
    people: { ...real.reads.people, actorTokens: vi.fn(async (actorId: string) => tokenLists[actorId] ?? []) },
    aiRuntime: { ...real.reads.aiRuntime, roles: vi.fn(async () => ({ roles: freshRoles })) },
  } };
});
let freshRoles: Array<Record<string, unknown>> = [];

import { createAiWithConnection, giveCode, revokeCodeNow } from "../settings/ai/actions";
import ThisComputerAnswering from "../settings/ai/ThisComputerAnswering";
import type { AnswerResult, DesktopAi } from "../lib/desktopBridge";

type AnswerStatus = Awaited<ReturnType<DesktopAi["status"]>>;
import type { AiPageData } from "../settings/ai/model";

const CODE = "ondt_" + "a".repeat(43);
const ACTOR = "11111111-2222-4333-8444-555555555555";
const OFF: AnswerStatus = { own: { enabled: false, phase: "stopped" }, remote: { enabled: false, phase: "stopped" }, canStoreSecurely: true };
const emptyData: AiPageData = { offered: true, keys: [], codes: [], roles: [] };

let status: AnswerStatus;
let listener: ((s: AnswerStatus) => void) | null;
let bridge: { [K in keyof DesktopAi]: ReturnType<typeof vi.fn> };

function installBridge(over: Partial<Record<keyof DesktopAi, unknown>> = {}) {
  bridge = {
    detect: vi.fn(async (): Promise<AnswerResult> => ({ ok: true })),
    status: vi.fn(async () => status),
    previewAddress: vi.fn(async (text: string) => /^https:\/\//.test(text) ? { ok: true, address: text.replace(/\/$/, "") } : { ok: false }),
    enableOwn: vi.fn(async (): Promise<AnswerResult> => ({ ok: true })),
    disableOwn: vi.fn(async () => ({ ok: true })),
    enableRemote: vi.fn(async (): Promise<AnswerResult> => ({ ok: true })),
    disableRemote: vi.fn(async () => ({ ok: true })),
    onStatus: vi.fn((cb: (s: AnswerStatus) => void) => { listener = cb; return () => { listener = null; }; }),
    ...over,
  } as typeof bridge;
  (window as unknown as { ondenDesktop?: unknown }).ondenDesktop = { ai: bridge };
}
const renderSection = (data: AiPageData = emptyData, onChanged = vi.fn()) =>
  render(<ThisComputerAnswering data={data} aiOn online onChanged={onChanged} />);
const turnOnOwn = () => screen.findByRole("button", { name: "Answer with the AI on this computer" });

beforeEach(() => { status = OFF; listener = null; freshRoles = []; for (const k of Object.keys(tokenLists)) delete tokenLists[k]; vi.clearAllMocks(); installBridge(); });
afterEach(() => { cleanup(); delete (window as unknown as { ondenDesktop?: unknown }).ondenDesktop; });

describe("in a normal browser", () => {
  it("shows nothing at all (no button, no file names)", () => {
    delete (window as unknown as { ondenDesktop?: unknown }).ondenDesktop;
    const { container } = renderSection();
    expect(container.innerHTML).toBe("");
  });
});

describe("notes in this app", () => {
  it("says the tool is missing, and makes nothing on the server", async () => {
    installBridge({ detect: vi.fn(async () => ({ ok: false, reason: "missing" })) });
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/No AI tool was found/);
    expect(createAiWithConnection).not.toHaveBeenCalled();
    expect(bridge.enableOwn).not.toHaveBeenCalled();
  });

  it("says the tool is not signed in", async () => {
    installBridge({ detect: vi.fn(async () => ({ ok: false, reason: "not_logged_in" })) });
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/not signed in/);
    expect(giveCode).not.toHaveBeenCalled();
  });

  it("refuses up front when the code cannot be kept safely", async () => {
    status = { ...OFF, canStoreSecurely: false };
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot keep the connection code safely/);
    expect(createAiWithConnection).not.toHaveBeenCalled();
  });

  it("makes the AI, hands the code to the shell once, and shows no code", async () => {
    vi.mocked(createAiWithConnection).mockImplementation(async () => { tokenLists[ACTOR] = [{ id: "tok-new", revoked_at: null }]; return { deduped: false, token: CODE, actorId: ACTOR }; });
    const onChanged = vi.fn();
    renderSection(emptyData, onChanged);
    await userEvent.click(await turnOnOwn());
    await waitFor(() => expect(bridge.enableOwn).toHaveBeenCalledWith({ actorId: ACTOR, code: CODE, codeId: "tok-new" }));
    expect(vi.mocked(createAiWithConnection).mock.calls[0]![0]).toMatchObject({ connection: { kind: "mcp" } });
    expect(document.body.textContent).not.toContain(CODE);
    expect(onChanged).toHaveBeenCalled();
  });

  it("reuses the AI it made before (gives it a new code) instead of making another", async () => {
    status = { ...OFF, own: { enabled: false, phase: "stopped", actorId: ACTOR } };
    tokenLists[ACTOR] = [{ id: "tok-other", revoked_at: null }];
    vi.mocked(giveCode).mockImplementation(async () => { tokenLists[ACTOR] = [{ id: "tok-other", revoked_at: null }, { id: "tok-new", revoked_at: null }]; return CODE; });
    const data: AiPageData = { ...emptyData, roles: [{ actor_id: ACTOR, default_runtime: "mcp", name: "AI", handle: "ai" } as never] };
    renderSection(data);
    await userEvent.click(await turnOnOwn());
    await waitFor(() => expect(bridge.enableOwn).toHaveBeenCalledWith({ actorId: ACTOR, code: CODE, codeId: "tok-new" }));
    expect(createAiWithConnection).not.toHaveBeenCalled();
  });

  it("when on, shows what it is doing; turning off stops the shell, then revokes only the code this button made", async () => {
    status = { ...OFF, own: { enabled: true, phase: "answering", actorId: ACTOR, codeId: "t1" } };
    const order: string[] = [];
    installBridge({ disableOwn: vi.fn(async () => { order.push("shell"); return { ok: true }; }) });
    vi.mocked(revokeCodeNow).mockImplementation(async () => { order.push("revoke"); return true; });
    const data: AiPageData = { ...emptyData, codes: [
      { kind: "code", id: "t1", actorId: ACTOR, name: "This computer", lastUsedAt: null, access: "write" },
      { kind: "code", id: "t2", actorId: ACTOR, name: "second computer", lastUsedAt: null, access: "write" },
    ] };
    renderSection(data);
    expect((await screen.findByRole("status")).textContent).toBe("Answering a question now.");
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(order).toEqual(["shell", "revoke"]));
    expect(vi.mocked(revokeCodeNow).mock.calls.map((c) => c[0].id)).toEqual(["t1"]);
  });

  it("after a lost reply (deduped) the next press finds the AI by name and gives it a new code", async () => {
    vi.mocked(createAiWithConnection).mockResolvedValueOnce({ deduped: true, token: null, actorId: null });
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Press the button again/);
    expect(bridge.enableOwn).not.toHaveBeenCalled();
    freshRoles = [{ actor_id: ACTOR, default_runtime: "mcp", name: "AI on this computer", handle: "ai" }];
    vi.mocked(giveCode).mockImplementation(async () => { tokenLists[ACTOR] = [{ id: "tok-new", revoked_at: null }]; return CODE; });
    await userEvent.click(await turnOnOwn());
    await waitFor(() => expect(bridge.enableOwn).toHaveBeenCalledWith({ actorId: ACTOR, code: CODE, codeId: "tok-new" }));
    expect(createAiWithConnection).toHaveBeenCalledTimes(1);
  });

  it("says so when the shell is not available, and when a bridge call throws", async () => {
    installBridge({ detect: vi.fn(async () => ({ ok: false, reason: "unavailable" })) });
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/not available in this app/);
    cleanup();
    installBridge({ detect: vi.fn(async () => { throw new Error("ipc"); }) });
    renderSection();
    await userEvent.click(await turnOnOwn());
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
  });

  it("follows the shell's status changes", async () => {
    status = { ...OFF, own: { enabled: true, phase: "waiting", actorId: ACTOR } };
    renderSection();
    expect((await screen.findByRole("status")).textContent).toMatch(/Questions are answered as they come in/);
    act(() => listener!({ ...status, own: { enabled: true, phase: "refused", actorId: ACTOR } }));
    expect((await screen.findByRole("status")).textContent).toMatch(/does not accept the connection code/);
  });
});

describe("another Onden server", () => {
  const fill = async (address: string, code: string) => {
    await userEvent.type(await screen.findByLabelText("Server address"), address);
    await userEvent.type(screen.getByLabelText("Connection code"), code);
  };

  it("shows the address back before saving, then turns on and clears the inputs", async () => {
    renderSection();
    await fill("https://notes.example.com/", CODE);
    await userEvent.click(screen.getByRole("button", { name: "Check the address" }));
    expect((await screen.findByRole("status")).textContent).toContain("https://notes.example.com. Is that right?");
    expect(bridge.enableRemote).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save and turn on" }));
    await waitFor(() => expect(bridge.enableRemote).toHaveBeenCalledWith({ address: "https://notes.example.com", code: CODE }));
    await waitFor(() => expect((screen.getByLabelText("Connection code") as HTMLInputElement).value).toBe(""));
  });

  it("refuses an address that is not https and keeps what was typed", async () => {
    renderSection();
    await fill("http://notes.example.com", CODE);
    await userEvent.click(screen.getByRole("button", { name: "Check the address" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/must start with https/);
    expect(bridge.enableRemote).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Connection code") as HTMLInputElement).value).toBe(CODE);
  });

  it("says when the code is incomplete", async () => {
    installBridge({ enableRemote: vi.fn(async () => ({ ok: false, reason: "bad_code" })) });
    renderSection();
    await fill("https://notes.example.com", "ondt_short");
    await userEvent.click(screen.getByRole("button", { name: "Check the address" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and turn on" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/looks incomplete/);
  });

  it("says when the server refuses the code, and keeps the input to try again", async () => {
    installBridge({ enableRemote: vi.fn(async () => ({ ok: false, reason: "code_refused" })) });
    renderSection();
    await fill("https://notes.example.com", CODE);
    await userEvent.click(screen.getByRole("button", { name: "Check the address" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and turn on" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not accept this connection code/);
    expect((screen.getByLabelText("Connection code") as HTMLInputElement).value).toBe(CODE);
  });

  it("once saved, shows the address and state but never a code, and turns off", async () => {
    status = { ...OFF, remote: { enabled: true, phase: "waiting", address: "https://notes.example.com" } };
    renderSection();
    expect(await screen.findByText("Answering for https://notes.example.com")).toBeTruthy();
    expect(screen.queryByLabelText("Connection code")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(bridge.disableRemote).toHaveBeenCalled());
  });
});
