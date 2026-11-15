import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { saveSettings } = vi.hoisted(() => ({ saveSettings: vi.fn(async () => ({ status: "synced" })) }));
vi.mock("./websiteWriter", () => ({ makeWebsiteWriter: () => ({ saveSettings }) }));

import { getAppState, setAppState } from "../../lib/appStore";
import SiteBasicsSettings from "./SiteBasicsSettings";
import { setLocalePref } from "../../lib/i18n";

const ctx = { online: true, onClose: () => {}, onImportDone: () => {}, onConnect: () => {} };

function setup(site_config: Record<string, unknown>, owner = true) {
  setAppState({ data: { ...getAppState().data, site_config, actor_is_owner: owner } });
  return render(<SiteBasicsSettings ctx={ctx} />);
}

beforeEach(() => saveSettings.mockClear());
afterEach(cleanup);

describe("Settings › Website", () => {
  it("writes nothing just from opening the page, even when the site has no language", async () => {
    setup({});
    await new Promise((r) => setTimeout(r, 800));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("stores a language only when the owner picks one", async () => {
    setup({});
    await userEvent.selectOptions(screen.getAllByRole("combobox")[0], "en");
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ locale: "en" }, expect.anything()));
  });

  it("shows a changed choice at once, and returns to the stored one when the save fails", async () => {
    saveSettings.mockRejectedValueOnce(new Error("refused"));
    setup({ locale: "en" });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(box.checked).toBe(false);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it("says changes apply to the public site right away", () => {
    setup({ locale: "en" });
    expect(screen.getByText("Changes apply to the public site right away.")).toBeTruthy();
    expect(screen.queryByText(/next time you publish/i)).toBeNull();
  });

  it("leaves a language that was already set alone", async () => {
    setup({ locale: "en" });
    await new Promise((r) => setTimeout(r, 50));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("saves only the key that changed", async () => {
    setup({ locale: "en", brand: "Mine" });
    await userEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ allow_indexing: false }, expect.anything()));
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the ID field only after a provider is chosen", async () => {
    setup({ locale: "en", analytics_provider: "" });
    expect(screen.queryByText("Measurement ID")).toBeNull();
    cleanup();
    setup({ locale: "en", analytics_provider: "ga4", analytics_id: "G-1" });
    expect(screen.getByDisplayValue("G-1")).toBeTruthy();
  });

  it("saves a valid domain and explains an invalid one without saving it", async () => {
    setup({ locale: "en" });
    const input = screen.getByPlaceholderText("www.example.com");
    await userEvent.type(input, "not a domain");
    expect(screen.getByRole("alert").textContent).toMatch(/www\.example\.com/);
    await new Promise((r) => setTimeout(r, 800));
    expect(saveSettings).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "https://Blog.Example.com/");
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ custom_domain: "blog.example.com" }, expect.anything()));
  });

  it("a valid prefix typed on the way to an invalid address is not saved", async () => {
    setup({ locale: "en" });
    // "www.ex" parses as a host; the typo after it does not.
    await userEvent.type(screen.getByPlaceholderText("www.example.com"), "www.ex!");
    await new Promise((r) => setTimeout(r, 800));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("shows the account's language when none was chosen for the site", () => {
    setLocalePref("zh-TW");
    setup({});
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("zh-TW");
    cleanup();
    setLocalePref("en");
    setup({});
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("en");
    setLocalePref("system");
  });

  it("is read-only for someone who is not the owner", () => {
    setup({ locale: "en" }, false);
    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  });
});
