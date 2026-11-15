import { describe, expect, it } from "vitest";
import { parseSlidesData, serializeSlidesData, withPageLayout, withSlidesTheme, type SlidesData } from "./slidesData.js";

describe("slides_data", () => {
  it("reads nothing, damage and strangers as the defaults", () => {
    const defaults: SlidesData = { v: 1, theme: "site", layouts: {} };
    for (const raw of [undefined, null, "", "not json", "[]", "null", "42", '{"theme":"neon"}']) expect(parseSlidesData(raw)).toEqual(defaults);
  });

  it("keeps what is valid and drops what is not (an unknown layout id is kept)", () => {
    const raw = JSON.stringify({ v: 1, theme: "paper", layouts: { "第一頁": "quote", b: "futureLayout", c: 3, "": "text", d: "Bad-Id" } });
    expect(parseSlidesData(raw)).toEqual({ v: 1, theme: "paper", layouts: { "第一頁": "quote", b: "futureLayout" } });
  });

  it("stores nothing when there is nothing to keep, so the attribute is removed", () => {
    expect(serializeSlidesData(parseSlidesData(undefined))).toBeNull();
    expect(serializeSlidesData(withSlidesTheme(parseSlidesData(undefined), "dark"))).not.toBeNull();
  });

  it("takes a choice and takes it back", () => {
    const chosen = withPageLayout(parseSlidesData(undefined), "intro", "quote");
    expect(parseSlidesData(serializeSlidesData(chosen))).toEqual(chosen);
    expect(serializeSlidesData(withPageLayout(chosen, "intro", null))).toBeNull();
  });

  it("drops the oldest choices past 64, and the oldest to fit 8 KB", () => {
    let data = parseSlidesData(undefined);
    for (let i = 0; i < 80; i++) data = withPageLayout(data, `p${i}`, "text");
    const back = parseSlidesData(serializeSlidesData(data));
    expect(Object.keys(back.layouts)).toHaveLength(64);
    expect(back.layouts.p79).toBe("text");
    expect(back.layouts.p0).toBeUndefined();
    const long = "字".repeat(110);
    let big = parseSlidesData(undefined);
    for (let i = 0; i < 60; i++) big = withPageLayout(big, `${long}${i}`, "text");
    const text = serializeSlidesData(big)!;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8 * 1024);
    expect(Object.keys(parseSlidesData(text).layouts).length).toBeGreaterThan(0);
  });

  it("moves a changed choice to the newest end", () => {
    let data = withPageLayout(withPageLayout(parseSlidesData(undefined), "a", "text"), "b", "text");
    data = withPageLayout(data, "a", "quote");
    expect(Object.keys(data.layouts)).toEqual(["b", "a"]);
  });
});
