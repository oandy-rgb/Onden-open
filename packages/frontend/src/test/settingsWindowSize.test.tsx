// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
vi.mock("../settings/ModulesSetting", () => ({ default: () => <div>modules widget</div> }));

import SettingsModal from "../settings/SettingsModal";
import { resetAppState } from "../lib/appStore";
import { TABS } from "../settings/registry";

beforeEach(() => { localStorage.clear(); resetAppState(); });

// jsdom has no layout, so this pins what the size comes from: the window is the same element with the same
// classes and no inline size on every page. The measured sizes (Playwright, real CSS) are in the PR.
describe("settings window size", () => {
  it("stays one element with one class list, and no inline size, while switching through every page", async () => {
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} />);
    const user = userEvent.setup();
    const modal = document.querySelector<HTMLElement>(".settings-modal")!;
    const classes = modal.className;
    for (const tab of TABS) {
      await user.click(document.querySelector<HTMLElement>(`.settings-sidebar [data-tab="${tab.id}"]`)!);
      expect(document.querySelector(".settings-modal")).toBe(modal);
      expect(modal.className).toBe(classes);
      expect(modal.getAttribute("style")).toBeNull();
      expect(document.querySelector<HTMLElement>(".settings-content")!.getAttribute("style")).toBeNull();
    }
    expect(classes).toBe("settings-modal");
  });
});
