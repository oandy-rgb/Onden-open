// ONDEN_SIGNUP: a personal server reachable from the network must not let a
// stranger register, because every later account becomes a workspace viewer.
// The default lets only the first account (the owner) through.

import { describe, it, expect } from "vitest";
import { assertSignupAllowed, resolveSignupMode } from "../auth.js";

describe("resolveSignupMode", () => {
  it("defaults to first-only", () => {
    expect(resolveSignupMode({})).toBe("first-only");
    expect(resolveSignupMode({ ONDEN_SIGNUP: "" })).toBe("first-only");
  });

  it("accepts the two modes, case-insensitively", () => {
    expect(resolveSignupMode({ ONDEN_SIGNUP: "first-only" })).toBe("first-only");
    expect(resolveSignupMode({ ONDEN_SIGNUP: " Open " })).toBe("open");
  });

  it("refuses an unknown value instead of guessing", () => {
    expect(() => resolveSignupMode({ ONDEN_SIGNUP: "closed" })).toThrow(/ONDEN_SIGNUP/);
  });
});

describe("assertSignupAllowed", () => {
  it("first-only lets the first account through", async () => {
    await expect(assertSignupAllowed("first-only", async () => false)).resolves.toBeUndefined();
  });

  it("first-only refuses every later account with SIGNUP_CLOSED", async () => {
    await expect(assertSignupAllowed("first-only", async () => true))
      .rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED" } });
  });

  it("first-only lets a sign-up with a valid invite link through, and says why a link does not (D110)", async () => {
    const closed = (answer: Awaited<ReturnType<Parameters<typeof assertSignupAllowed>[2] & object>>) =>
      assertSignupAllowed("first-only", async () => true, async () => answer);
    await expect(closed("admitted")).resolves.toBeUndefined();
    await expect(closed(null))
      .rejects.toMatchObject({ body: { code: "SIGNUP_CLOSED", message: expect.stringMatching(/invite this email/) } });
    await expect(closed("invite_expired"))
      .rejects.toMatchObject({ body: { code: "INVITE_EXPIRED", message: expect.stringMatching(/expired/) } });
    await expect(closed("invite_email_mismatch")).rejects.toMatchObject({ body: { code: "INVITE_EMAIL_MISMATCH" } });
    await expect(closed("invite_used")).rejects.toMatchObject({ body: { code: "INVITE_INVALID" } });
    await expect(closed("invite_invalid")).rejects.toMatchObject({ body: { code: "INVITE_INVALID" } });
  });

  it("open never looks at existing users", async () => {
    let asked = false;
    await assertSignupAllowed("open", async () => { asked = true; return true; });
    expect(asked).toBe(false);
  });
});
