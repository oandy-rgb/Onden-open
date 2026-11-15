import { describe, expect, it } from "vitest";
import { movedTo, siteRedirectsOf } from "./siteRedirects";
import { readSiteData } from "../components/siteFrame/siteModel";

describe("siteRedirectsOf", () => {
  it("reads the served pairs, leaving out what is not a site address", () => {
    const map = siteRedirectsOf([
      { from: "/site/plan/", to: "/site/roadmap/" },
      { from: "/site/tag/books/", to: "/site/tag/reading/" },
      { from: "https://evil.example/", to: "/site/x/" },
      { from: "/site/a/", to: "//evil.example/" },
      { from: 1, to: "/site/x/" },
      null,
    ]);
    expect([...map]).toEqual([["/site/plan/", "/site/roadmap/"], ["/site/tag/books/", "/site/tag/reading/"]]);
    expect(siteRedirectsOf(undefined).size).toBe(0);
  });
});

describe("movedTo", () => {
  const redirects = new Map([["/site/計畫/", "/site/路線圖/"], ["/site/plan/", "/site/roadmap/"]]);
  it("gives the current address, percent-encoded for a Location header", () => {
    expect(movedTo(redirects, "/site/plan/")).toBe("/site/roadmap/");
    expect(movedTo(redirects, "/site/計畫/")).toBe(`/site/${encodeURIComponent("路線圖")}/`);
  });
  it("matches with or without the trailing slash, and is null for an address with no redirect", () => {
    expect(movedTo(redirects, "/site/plan")).toBe("/site/roadmap/");
    expect(movedTo(redirects, "/site/other/")).toBeNull();
  });
});

describe("readSiteData", () => {
  it("carries the served redirects to the pages", () => {
    const data = readSiteData({ payload: { nodes: [], site_redirects: [{ from: "/site/plan/", to: "/site/roadmap/" }] } });
    expect(data.redirects.get("/site/plan/")).toBe("/site/roadmap/");
    expect(readSiteData({ payload: {} }).redirects.size).toBe(0);
  });
});
