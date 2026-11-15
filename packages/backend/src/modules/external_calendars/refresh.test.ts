import { describe, it, expect } from "vitest";
import { fetchCalendar } from "./refresh.js";

// The outbound gate is services/safeFetch; these pin that this module goes through it
// (no network is reached: a refused address fails before any connection).
describe("fetchCalendar refuses addresses the server must not dial", () => {
  for (const url of [
    "http://127.0.0.1/a.ics", "http://localhost/a.ics", "http://10.0.0.5/a.ics", "http://192.168.1.2/a.ics",
    "http://169.254.169.254/latest/meta-data", "http://[::1]/a.ics", "http://[::ffff:7f00:1]/a.ics", "http://0.0.0.0/a.ics",
  ]) {
    it(url, async () => {
      expect(await fetchCalendar(url)).toEqual({ ok: false, reason: "blocked" });
    });
  }
  it("refuses a scheme that is not http(s)", async () => {
    expect(await fetchCalendar("file:///etc/passwd")).toEqual({ ok: false, reason: "blocked" });
  });
});
