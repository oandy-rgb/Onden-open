// Scan 14 #22: the Markdown export link carries the app's language, so an English interface gets Tasks/Tasks.md.
import { afterEach, describe, expect, it } from "vitest";
import { markdownExportUrl } from "../lib/api";
import { setLocalePref } from "../lib/i18n";

afterEach(() => setLocalePref("system"));

describe("markdownExportUrl", () => {
  it("asks for English names in an English interface and the default ones otherwise", () => {
    setLocalePref("en");
    expect(markdownExportUrl()).toMatch(/\/api\/export\/markdown\.zip\?lang=en$/);
    setLocalePref("zh-TW");
    expect(markdownExportUrl()).toMatch(/\/api\/export\/markdown\.zip$/);
  });
});
