import type React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SETTINGS } from "../settings/registry";
import type { SettingContext } from "../lib/settingsTypes";

// Regression: Settings' "Export all notes (.zip)" must hit the LOSSLESS
// exporter (/api/export/markdown.zip — frontmatter, tags, aliases, media),
// NOT the bare /api/export which falls through to the publish router's
// title+markdown-only dump. The command palette already used the lossless
// path; the Settings widget was the lone caller pointing at /api/export.
describe("Settings zip export link (lossless route)", () => {
  it("targets the lossless /api/export/markdown.zip endpoint", () => {
    const def = SETTINGS.find((s) => s.id === "data.export");
    expect(def, "data.export setting should be registered").toBeTruthy();
    expect(def!.type, "zip export should be a custom widget").toBe("custom");
    const Widget = (def as { component: React.ComponentType<{ ctx: SettingContext }> }).component;
    const { container } = render(<Widget ctx={{} as SettingContext} />);

    const link = container.querySelector("a[download]") as HTMLAnchorElement | null;
    expect(link, "export widget should render a download link").toBeTruthy();

    // Robust to whatever getApiBase() resolves to (empty same-origin in tests):
    // assert the path (it carries the app's language: "?lang=en" in an English interface),
    // and explicitly reject the lossy bare endpoint.
    expect(link!.getAttribute("href")).toMatch(/\/api\/export\/markdown\.zip(\?lang=en)?$/);
    expect(link!.getAttribute("href")).not.toMatch(/\/api\/export$/);
  });
});
