import { describe, expect, it } from "vitest";
import { publicOrigin, publicUrl } from "./siteOrigin";

const request = new URL("http://frontend:80/site/foo/?access=x");

describe("publicOrigin", () => {
  it("uses the configured APP_URL, not the proxied request address", () => {
    expect(publicOrigin(request, { APP_URL: "https://notes.example.com/" })).toBe("https://notes.example.com");
    expect(publicUrl(request, "/site/foo/", { APP_URL: "https://notes.example.com" })).toBe("https://notes.example.com/site/foo/");
  });
  it("falls back to the request origin when APP_URL is missing or malformed", () => {
    expect(publicOrigin(request, {})).toBe("http://frontend");
    expect(publicOrigin(request, { APP_URL: "not a url" })).toBe("http://frontend");
  });
});
