// What a publish sends: the site's name and settings only. The home design and
// the home page are the server's (the saved design, else its default; the
// workspace's home, D116), so the body carries neither unless a caller names a
// home explicitly.
import { describe, expect, it } from "vitest";
import { siteSettingsFromConfig } from "../../lib/siteSettings";
import { homePublishBody } from "./usePublishReview";

const settings = siteSettingsFromConfig({ brand: "Acme", tagline: "t", locale: "en", nav: [{ label: "H", nodeId: "h" }] });

describe("homePublishBody", () => {
  it("carries the site chunk and nothing of the design", () => {
    const body = homePublishBody(settings);
    expect(body.title).toBe("Acme");
    expect(body.presentation).toEqual({ site: { brand: "Acme", tagline: "t", logo: "", nav: [{ label: "H", nodeId: "h" }], locale: "en" } });
  });

  it("names no home: the server decides it from the workspace's home (D116)", () => {
    expect(homePublishBody(settings)).not.toHaveProperty("home_node_id");
  });

  it("names a home only when the caller overrides it", () => {
    expect(homePublishBody(settings, "h1")).toMatchObject({ home_node_id: "h1" });
  });

  it("falls back to a title when the brand is empty", () => {
    expect(homePublishBody({ ...settings, brand: "" }).title).toBe("Onden Site");
  });
});
