// Settings › External calendars: the list shows a host (never the link), plain
// words for what went wrong, and adding sends the link once and keeps the box on a refusal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const list = vi.fn();
const sendWrite = vi.fn();
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return { ...real, sendWrite: (...args: unknown[]) => sendWrite(...args), reads: { ...real.reads, workspace: { ...real.reads.workspace, externalCalendars: () => list() } } };
});

import CalendarsSetting from "../modules/external_calendars/CalendarsSetting";
import type { SettingContext } from "../lib/settingsTypes";
import { ApiError } from "../lib/api";

const ctx = (online = true): SettingContext => ({ online, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() });
const calendar = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Work", color: "#3b82f6", host: "calendar.example.com", enabled: true, last_fetched_at: "2026-10-31T08:00:00Z", last_error: null, ...over });

beforeEach(() => {
  list.mockReset().mockResolvedValue({ available: true, calendars: [calendar()] });
  sendWrite.mockReset().mockResolvedValue({});
});

describe("the calendars list", () => {
  it("names the host and the last update, and says plainly when a calendar could not be read", async () => {
    list.mockResolvedValue({ available: true, calendars: [calendar(), calendar({ id: "c2", name: "Other", last_error: "not_calendar" })] });
    render(<CalendarsSetting ctx={ctx()} />);
    expect((await screen.findAllByText("calendar.example.com")).length).toBe(2);
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(screen.getByText("That link isn't a calendar.")).toBeTruthy();
    expect(screen.getByText(/Showing what was read on/)).toBeTruthy();
  });

  it("explains a server that cannot keep links and offers no form", async () => {
    list.mockResolvedValue({ available: false, calendars: [] });
    render(<CalendarsSetting ctx={ctx()} />);
    expect(await screen.findByText(/isn't set up to keep calendar links safely/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add calendar" })).toBeNull();
  });

  it("adds a calendar with its name, colour and link, and clears the box", async () => {
    render(<CalendarsSetting ctx={ctx()} />);
    await userEvent.type(await screen.findByLabelText("Name"), "Home");
    await userEvent.type(screen.getByLabelText("The calendar's iCal link"), "https://cal.example.com/private/x.ics");
    await userEvent.click(screen.getByRole("button", { name: "Add calendar" }));
    await waitFor(() => expect(sendWrite).toHaveBeenCalled());
    const [method, path, body] = sendWrite.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/api/external-calendars");
    expect(body).toMatchObject({ name: "Home", url: "https://cal.example.com/private/x.ics", color: expect.stringMatching(/^#/) });
    await waitFor(() => expect((screen.getByLabelText("The calendar's iCal link") as HTMLInputElement).value).toBe(""));
  });

  it("keeps the typed link and says why when the server refuses it", async () => {
    sendWrite.mockRejectedValue(new ApiError(422, JSON.stringify({ error: "invalid_url" })));
    render(<CalendarsSetting ctx={ctx()} />);
    await userEvent.type(await screen.findByLabelText("Name"), "Home");
    await userEvent.type(screen.getByLabelText("The calendar's iCal link"), "ftp://nope");
    await userEvent.click(screen.getByRole("button", { name: "Add calendar" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("The calendar's iCal link") as HTMLInputElement).value).toBe("ftp://nope");
  });

  it("changes nothing while offline", async () => {
    render(<CalendarsSetting ctx={ctx(false)} />);
    expect(await screen.findByText("Connect to the server to add or change calendars.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
