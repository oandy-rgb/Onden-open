import { describe, it, expect } from "vitest";
import { parseCalendarUrl } from "./calendarUrl.js";

describe("parseCalendarUrl", () => {
  it("keeps https and http, trimmed, and reports only the host", () => {
    expect(parseCalendarUrl("  https://cal.example.com/private/abc123/basic.ics  ")).toEqual({ href: "https://cal.example.com/private/abc123/basic.ics", host: "cal.example.com" });
    expect(parseCalendarUrl("http://cal.example.com/a.ics")?.host).toBe("cal.example.com");
  });
  it("reads webcal as https", () => {
    expect(parseCalendarUrl("webcal://cal.example.com/a.ics")?.href).toBe("https://cal.example.com/a.ics");
  });
  it("refuses other schemes, empty text and non-text", () => {
    for (const bad of ["file:///etc/passwd", "ftp://x.test/a.ics", "javascript:alert(1)", "data:text/calendar,x", "", "not a url", 5, null]) {
      expect(parseCalendarUrl(bad)).toBeNull();
    }
    expect(parseCalendarUrl(`https://x.test/${"a".repeat(2100)}`)).toBeNull();
  });
});
