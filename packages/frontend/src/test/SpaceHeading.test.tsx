import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SpaceHeading from "../components/SpaceHeading";
import { onSettingsRequest, spaceFilterStore } from "../lib/settingsRequest";

afterEach(() => { cleanup(); spaceFilterStore.clear(); });

describe("SpaceHeading (sidebar)", () => {
  it("a shared space's title opens its members and permissions, filtered to it", () => {
    const opened = vi.fn();
    const off = onSettingsRequest(opened);
    render(<SpaceHeading spaceId="lab" label="Lab" shared />);
    fireEvent.click(screen.getByRole("button", { name: "Members and permissions of Lab" }));
    expect(opened).toHaveBeenCalledWith("spaces");
    expect(spaceFilterStore.get()).toBe("lab");
    off();
  });

  it("a personal space's title is only a title", () => {
    render(<SpaceHeading spaceId="mine" label="Only me" shared={false} />);
    expect(screen.getByRole("heading", { name: "Only me" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
