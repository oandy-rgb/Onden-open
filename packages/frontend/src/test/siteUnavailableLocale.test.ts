import { describe, expect, it } from "vitest";

import { makeT } from "../components/templates";

// The plain page a published site falls back to when its snapshot can't be loaded
// has no site locale to read, so it speaks the default (zh-TW), not hard-coded English.
describe("site unavailable page", () => {
  it("reads in the default site language when no locale is known", () => {
    const t = makeT();
    expect(t("siteUnavailable")).toBe("網站暫時無法顯示");
    expect(t("siteUnavailableLead")).toBe("目前讀不到網站內容，請稍後再試。");
  });

  it("follows a site's own locale", () => {
    expect(makeT("en")("siteUnavailable")).toBe("Site unavailable");
    expect(makeT("ja")("siteUnavailable")).toBe("サイトを表示できません");
  });
});
