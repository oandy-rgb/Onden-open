// Storage full (QuotaExceededError on the local snapshot): the page says so
// once, offers Retry, keeps the notice off the writes, and drops it when a
// save works again (components/DeviceNotices, lib/localCopyStatus).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const retry = vi.fn<() => Promise<void>>();
vi.mock("../lib/data", () => ({ retryLocalCopySave: () => retry(), isBrowserOnline: () => true }));

import { setLocalePref } from "../lib/i18n";
import "../lib/i18n.zh-TW";
import DeviceNotices from "../components/DeviceNotices";
import { setLocalCopyUnavailable } from "../lib/localCopyStatus";
import { resetAppState } from "../lib/appStore";
import { _resetLocalCopyForTests } from "../lib/localCopyState";

const NOTICE = /儲存空間滿了/;

describe("storage-full notice", () => {
  beforeEach(() => { setLocalePref("zh-TW"); resetAppState(); _resetLocalCopyForTests(); setLocalCopyUnavailable(false); retry.mockReset(); });
  afterEach(() => { setLocalCopyUnavailable(false); setLocalePref("system"); });

  it("shows nothing while the local copy saves", () => {
    const { container } = render(<DeviceNotices />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says what happened, what may be missing and what to do, once, without overclaiming or technical text", () => {
    render(<DeviceNotices />);
    act(() => { setLocalCopyUnavailable(true); setLocalCopyUnavailable(true); });
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/可能還沒存到/);
    expect(text).toMatch(/網路恢復後會再同步/);
    expect(text).not.toMatch(/只存在這個分頁|不要關/);
    expect(text).not.toMatch(/Quota|JSON|\{|_/);
    expect(screen.getByRole("button", { name: "重試" })).toBeTruthy();
  });

  it("Retry asks for another save, and the notice goes away when the save works", async () => {
    retry.mockImplementation(async () => { setLocalCopyUnavailable(false); });
    render(<DeviceNotices />);
    act(() => setLocalCopyUnavailable(true));
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("a Retry that fails again keeps the notice and the button usable", async () => {
    retry.mockRejectedValue(new Error("QuotaExceededError"));
    render(<DeviceNotices />);
    act(() => setLocalCopyUnavailable(true));
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "重試" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByText(/QuotaExceeded/)).toBeNull();
  });
});
