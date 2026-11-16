// A server older than this page accepts (X-Onden-Server-Protocol): the page says so in plain words, keeps changes on
// the device, and drops the notice when the server is updated.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CLIENT_PROTOCOL, SERVER_PROTOCOL_HEADER } from "@onden/markdown";
import { watchServerBuild } from "../lib/buildVersion";
import { apiFetch, setClientTooOldListener, setServerBuildListener } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetProtocolGate, noteServerProtocol } from "../lib/protocolGate";
import { setLocalePref } from "../lib/i18n";
import DeviceNotices from "../components/DeviceNotices";

beforeEach(() => {
  window.sessionStorage.clear();
  resetAppState();
  resetProtocolGate();
  bindAccountStorage("u", "");
  setLocalePref("en");
  watchServerBuild();
});
afterEach(() => { cleanup(); setServerBuildListener(null); setClientTooOldListener(null); resetProtocolGate(); vi.unstubAllGlobals(); });

const NOTICE = "The server needs an update. You are seeing this device's copy; your changes are kept here and will be sent once it is updated.";

describe("server too old for this page", () => {
  it("shows a plain notice while the server is too old, with no code, and removes it once it is updated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { [SERVER_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL - 1) } })));
    render(<DeviceNotices />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    await act(async () => { await apiFetch("/api/me"); });
    const shown = await screen.findByText(NOTICE);
    expect(shown.textContent).not.toMatch(/protocol|426|server_too_old/i);
    act(() => noteServerProtocol(String(CLIENT_PROTOCOL)));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("shows the Traditional Chinese sentence in that language", async () => {
    setLocalePref("zh-TW");
    act(() => noteServerProtocol(String(CLIENT_PROTOCOL - 1)));
    render(<DeviceNotices />);
    expect(await screen.findByText("伺服器需要更新。你現在看到的是這台裝置上的副本；修改會留在這裡，更新後自動送出。")).toBeTruthy();
  });
});
