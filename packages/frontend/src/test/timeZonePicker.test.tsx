// The time zone picker (components/TimeZonePicker): a button that opens a typeable
// list. Typing filters, ↑/↓ move, Enter picks, Esc closes; rows are drawn a page
// at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeZonePicker } from "../components/TimeZonePicker";
import { zoneOffsetMinutes } from "../lib/localDate";
import { registerDictionary, setLocalePref } from "../lib/i18n";
import { ZH_TW } from "../lib/i18n.zh-TW";

beforeEach(() => setLocalePref("en"));

function setup(props: Partial<Parameters<typeof TimeZonePicker>[0]> = {}) {
  const onPick = vi.fn();
  render(<TimeZonePicker zone="UTC" device="Asia/Taipei" onPick={onPick} {...props} />);
  return { onPick, user: userEvent.setup() };
}
const field = () => screen.getByRole("combobox", { name: /^(Time zone|時區)$/ });
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(field());
  return field();
};
const options = () => screen.getAllByRole("option");
const names = () => options().map((o) => o.textContent);

describe("opening", () => {
  it("shows the zone in use in the field, and lists this device, the one in use and the common ones first", async () => {
    const { user } = setup();
    expect(field()).toHaveValue("UTC");
    const search = await open(user);
    expect(search).toHaveFocus();
    const rows = options();
    expect(rows[0]).toHaveTextContent("Taipei（UTC+8）");
    expect(rows[0]).toHaveTextContent("This device");
    expect(rows[1]).toHaveTextContent("UTC");
    expect(rows[1]).toHaveTextContent("In use");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Suggested")).toBeInTheDocument();
  });

  it("draws a page of rows and says how many are left; Show more adds a page", async () => {
    const { user } = setup();
    await open(user);
    expect(options()).toHaveLength(80);
    const more = screen.getByText(/more time zones\. Keep typing to narrow the list\./);
    const left = Number(/^(\d+)/.exec(more.textContent!)![1]);
    expect(left).toBeGreaterThan(300);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(options()).toHaveLength(160);
    expect(screen.getByText(/more time zones/).textContent).toContain(String(left - 80));
  });

  it("is a disabled field when it cannot change", () => {
    setup({ disabled: true });
    expect(field()).toBeDisabled();
  });
});

describe("typing", () => {
  it("filters as you type: a city in the zone, a country", async () => {
    const { user } = setup();
    const search = await open(user);
    await user.type(search, "Beijing");
    await waitFor(() => expect(names()[0]).toContain("Shanghai"));
    expect(options()).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "China");
    await waitFor(() => expect(names().some((n) => n?.includes("Shanghai"))).toBe(true));
    await user.clear(search);
    await user.type(search, "zzz-nothing");
    expect(screen.getByText("No time zone matches.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("finds 北京 and 美國 in Chinese, and shows the country under the name", async () => {
    registerDictionary("zh-TW", ZH_TW);
    setLocalePref("zh-TW");
    const { user } = setup();
    const search = await open(user);
    await user.type(search, "北京");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]).toHaveTextContent("上海（UTC+8）");
    expect(options()[0]).toHaveTextContent("中國");
    await user.clear(search);
    await user.type(search, "美國");
    await waitFor(() => expect(names().some((n) => n?.includes("丹佛") && n.includes("美國"))).toBe(true));
  });
});

describe("keys", () => {
  it("↓/↑ move the highlight, Enter picks it, and the list closes", async () => {
    const { user, onPick } = setup();
    const search = await open(user);
    await user.type(search, "+9");
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    const rows = options();
    expect(search).toHaveAttribute("aria-activedescendant", rows[0]!.id);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(search).toHaveAttribute("aria-activedescendant", rows[1]!.id);
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(zoneOffsetMinutes(onPick.mock.calls[0]![0] as string)).toBe(540);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("UTC");
  });

  it("Esc closes without picking and keeps focus in the field", async () => {
    const { user, onPick } = setup();
    await open(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(field()).toHaveFocus();
  });

  it("Enter with nothing found picks nothing", async () => {
    const { user, onPick } = setup();
    const search = await open(user);
    await user.type(search, "zzz-nothing{Enter}");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("focus leaving the field closes the list", async () => {
    const { user } = setup();
    await open(user);
    await user.tab(); // onto "Show more", still inside the picker
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("clicking a row picks it; the zone already in use is not 'picked' again", async () => {
    const { user, onPick } = setup();
    await open(user);
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^Tokyo/ }));
    expect(onPick).toHaveBeenCalledWith("Asia/Tokyo");
    await user.click(field());
    await user.click(options().find((row) => row.getAttribute("aria-selected") === "true")!);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
