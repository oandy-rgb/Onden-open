// The server key's one helper (services/serverSecret.ts), step 1 of the two-deploy rollout: it opens both stored versions and
// still writes version 1, which the previous deploy reads. No database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { openSecret, sealSecret } from "../services/serverSecret.js";
import { legacySealed, openAsPreviousDeploy, purposeSealed } from "./helpers/legacySealed.js";

const KEY = randomBytes(32).toString("hex");
const saved = process.env.ONDEN_SECRET_KEY;
beforeAll(() => { process.env.ONDEN_SECRET_KEY = KEY; });
afterAll(() => { if (saved === undefined) delete process.env.ONDEN_SECRET_KEY; else process.env.ONDEN_SECRET_KEY = saved; });

const unreadable = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ code: "credential_unreadable" }));

describe("server secrets", () => {
  it("writes the form the previous deploy reads (version 1), so going back one version loses nothing", () => {
    const id = randomUUID();
    const sealed = sealSecret("ai-credential", id, "sk-test-1234");
    expect(sealed[0]).toBe(1);
    expect(openAsPreviousDeploy(KEY, id, sealed)).toBe("sk-test-1234");
    expect(openSecret("ai-credential", id, sealed)).toBe("sk-test-1234");
  });

  it("opens a value the previous deploy wrote", () => {
    const id = randomUUID();
    expect(openSecret("external-calendar", id, legacySealed(KEY, id, "https://cal.example/a.ics"))).toBe("https://cal.example/a.ics");
  });

  it("opens a version 2 value for its own purpose and row, and not for the other purpose or another row", () => {
    const id = randomUUID();
    const sealed = purposeSealed(KEY, "ai-credential", id, "sk-test-1234");
    expect(openSecret("ai-credential", id, sealed)).toBe("sk-test-1234");
    unreadable(() => openSecret("external-calendar", id, sealed));
    unreadable(() => openSecret("ai-credential", randomUUID(), sealed));
    unreadable(() => openSecret("ai-credential", id, purposeSealed(KEY, "external-calendar", id, "https://cal.example/x.ics")));
  });

  it("a version 1 value is bound to its row only: it opens for either purpose (step 2 of the rollout ends this)", () => {
    const id = randomUUID();
    const sealed = sealSecret("ai-credential", id, "sk-test-1234");
    expect(openSecret("external-calendar", id, sealed)).toBe("sk-test-1234");
    unreadable(() => openSecret("ai-credential", randomUUID(), sealed));
  });

  it("any changed byte (version, iv, tag, ciphertext) or a cut value does not open, in either version", () => {
    const id = randomUUID();
    for (const sealed of [sealSecret("external-calendar", id, "https://cal.example/private.ics"), purposeSealed(KEY, "external-calendar", id, "https://cal.example/private.ics")]) {
      for (const at of [0, 1, 12, 13, 28, 29, sealed.length - 1]) {
        const tampered = Buffer.from(sealed);
        tampered[at] = tampered[at]! ^ 0x01;
        unreadable(() => openSecret("external-calendar", id, tampered));
      }
      unreadable(() => openSecret("external-calendar", id, sealed.subarray(0, 20)));
    }
    unreadable(() => openSecret("external-calendar", id, Buffer.alloc(0)));
  });

  it("a value under another server's key does not open", () => {
    const id = randomUUID();
    unreadable(() => openSecret("ai-credential", id, legacySealed(randomBytes(32).toString("hex"), id, "sk-other-server")));
  });

  it("without a key nothing opens or is sealed", () => {
    delete process.env.ONDEN_SECRET_KEY;
    try {
      const id = randomUUID();
      expect(() => sealSecret("ai-credential", id, "x")).toThrow(expect.objectContaining({ code: "secret_key_missing" }));
      expect(() => openSecret("ai-credential", id, legacySealed(KEY, id, "x"))).toThrow(expect.objectContaining({ code: "secret_key_missing" }));
    } finally { process.env.ONDEN_SECRET_KEY = KEY; }
  });
});
