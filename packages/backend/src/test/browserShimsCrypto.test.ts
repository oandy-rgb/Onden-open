import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs shim the browser build swaps in for node:crypto (scripts/build-browser.mjs)
import { withBase64url } from "../../browser-shims/crypto.mjs";
// The npm `buffer` package, the stand-in for Node's Buffer inside the browser app's worker.
import { Buffer as BrowserBuffer } from "../../../../node_modules/buffer/index.js";

// Tokens (agentTokens.ts), invite links (actorInvites.ts) and the admin password (admin.ts) are
// randomBytes(n).toString("base64url"). The `buffer` package throws "Unknown encoding: base64url",
// so minting a token or an invite was a 500 in the browser app until the shim handled it.
describe("browser shim: crypto base64url", () => {
  it("the stand-in Buffer alone does not know base64url", () => {
    expect(() => BrowserBuffer.from([251, 255, 254]).toString("base64url")).toThrow(/Unknown encoding/);
  });
  it("withBase64url turns it into URL-safe base64 without padding, like Node", () => {
    const bytes = [251, 255, 254, 1, 2];
    expect(withBase64url(BrowserBuffer.from(bytes)).toString("base64url")).toBe(Buffer.from(bytes).toString("base64url"));
    expect(withBase64url(BrowserBuffer.from(bytes)).toString("base64url")).not.toMatch(/[+/=]/);
  });
  it("other encodings are untouched", () => {
    expect(withBase64url(BrowserBuffer.from("onden")).toString("hex")).toBe(Buffer.from("onden").toString("hex"));
    expect(withBase64url(BrowserBuffer.from("onden")).toString()).toBe("onden");
  });
});
