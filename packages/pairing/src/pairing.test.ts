import { describe, expect, it } from "vitest";
import { acceptInvite, completeOnPage, createInvite, encodeInvite, fromBase64Url, PairingError, parseHello, parseInvite, toBase64Url } from "./index.ts";
import { pairedSession, seededRandom } from "./helpers.test-util.ts";

describe("invite", () => {
  it("round-trips through the QR text and carries no secret", () => {
    const page = createInvite("https://relay.example");
    const text = encodeInvite(page.invite);
    expect(parseInvite(text)).toEqual(page.invite);
    expect(text).not.toContain(toBase64Url(page.secretKey));
    expect(fromBase64Url(page.invite.sessionId)).toHaveLength(16);
  });

  it.each(["", "stp1:", "stp2:abc", "stp1:!!!", `stp1:${toBase64Url(new TextEncoder().encode('{"v":1}'))}`])("rejects malformed invite %j", (text) => {
    expect(() => parseInvite(text)).toThrowError(expect.objectContaining({ code: "bad_invite" }));
  });

  it("rejects a non-http relay address", () => {
    const page = createInvite("javascript:alert(1)");
    expect(() => parseInvite(encodeInvite(page.invite))).toThrow(PairingError);
  });
});

describe("pairing", () => {
  it("gives both sides identical codes, tokens and keys", () => {
    const { pageKeys, phoneKeys } = pairedSession();
    expect(pageKeys.confirmationCode()).toMatch(/^\d{6}$/);
    expect(phoneKeys.confirmationCode()).toBe(pageKeys.confirmationCode());
    expect(phoneKeys.writeToken()).toBe(pageKeys.writeToken());
    expect(phoneKeys.readToken()).toBe(pageKeys.readToken());
    expect(pageKeys.writeToken()).not.toBe(pageKeys.readToken());
  });

  it("derives different tokens for a different session", () => {
    expect(pairedSession().pageKeys.readToken()).not.toBe(pairedSession().pageKeys.readToken());
  });

  it("makes the two sides disagree when the relay swaps the phone's key", () => {
    const { page, phoneKeys } = pairedSession("https://relay.example", 7);
    const pageKeysUnderAttack = completeOnPage(page, acceptInvite(page.invite, seededRandom(99)).hello);
    expect(pageKeysUnderAttack.readToken()).not.toBe(phoneKeys.readToken());
    expect(pageKeysUnderAttack.confirmationCode()).not.toBe(phoneKeys.confirmationCode()); // fixed seeds, so deterministic
  });

  it("rejects a malformed hello and a low-order public key", () => {
    const { page } = pairedSession();
    expect(() => parseHello(new Uint8Array(10))).toThrowError(expect.objectContaining({ code: "bad_hello" }));
    const zeroKey = new Uint8Array(33);
    zeroKey[0] = 1;
    expect(() => completeOnPage(page, zeroKey)).toThrowError(expect.objectContaining({ code: "bad_key" }));
  });

  it("derives purpose-bound values (read token cannot be turned into the write token)", () => {
    const { pageKeys } = pairedSession();
    expect(pageKeys.derive("a")).not.toEqual(pageKeys.derive("b"));
    expect(pageKeys.derive("a", 32, new Uint8Array([1]))).not.toEqual(pageKeys.derive("a", 32, new Uint8Array([2])));
  });
});
