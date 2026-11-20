// The server key seals every secret for a purpose and a row (services/serverSecret.ts). No database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { isLegacySealed, openStoredSecret, sealSecret } from "../services/serverSecret.js";
import { legacySealed } from "./helpers/legacySealed.js";

const KEY = randomBytes(32).toString("hex");
const saved = process.env.ONDEN_SECRET_KEY;
beforeAll(() => { process.env.ONDEN_SECRET_KEY = KEY; });
afterAll(() => { if (saved === undefined) delete process.env.ONDEN_SECRET_KEY; else process.env.ONDEN_SECRET_KEY = saved; });

/** Open a stored value; a test that reads a current value expects no rewrite. */
const open = (purpose: Parameters<typeof openStoredSecret>[0], rowId: string, sealed: Buffer) =>
  openStoredSecret(purpose, rowId, sealed, async () => { throw new Error("rewrote a value that was already current"); });
const unreadable = (opening: Promise<unknown>) => expect(opening).rejects.toMatchObject({ code: "credential_unreadable" });

describe("server secrets", () => {
  it("a value opens for the purpose and row it was sealed for", async () => {
    const id = randomUUID();
    expect(await open("ai-credential", id, sealSecret("ai-credential", id, "sk-test-1234"))).toBe("sk-test-1234");
  });

  it("a value sealed for one purpose does not open for the other, even under the same row id", async () => {
    const id = randomUUID();
    await unreadable(open("external-calendar", id, sealSecret("ai-credential", id, "sk-test-1234")));
    await unreadable(open("ai-credential", id, sealSecret("external-calendar", id, "https://cal.example/x.ics")));
  });

  it("a value moved to another row does not open", async () => {
    await unreadable(open("ai-credential", randomUUID(), sealSecret("ai-credential", randomUUID(), "sk-test-1234")));
  });

  it("any changed byte (version, iv, tag, ciphertext) or a cut value does not open", async () => {
    const id = randomUUID();
    const sealed = sealSecret("external-calendar", id, "https://cal.example/private.ics");
    for (const at of [0, 1, 12, 13, 28, 29, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[at] = tampered[at]! ^ 0x01;
      await unreadable(open("external-calendar", id, tampered));
    }
    await unreadable(open("external-calendar", id, sealed.subarray(0, 20)));
    await unreadable(open("external-calendar", id, Buffer.alloc(0)));
  });

  it("an old (version 1) value still opens, and is rewritten in the current form the first time it is read", async () => {
    const id = randomUUID();
    const old = legacySealed(KEY, id, "sk-old-key-5678");
    const writes: Array<{ from: Buffer; to: Buffer }> = [];
    expect(await openStoredSecret("ai-credential", id, old, async (from, to) => { writes.push({ from, to }); })).toBe("sk-old-key-5678");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.from.equals(old)).toBe(true);
    expect(isLegacySealed(writes[0]!.to)).toBe(false);
    expect(await open("ai-credential", id, writes[0]!.to)).toBe("sk-old-key-5678");
    // Once rewritten it is bound to its purpose; the old form never was.
    expect(await openStoredSecret("external-calendar", id, old, async () => {})).toBe("sk-old-key-5678");
    await unreadable(open("external-calendar", id, writes[0]!.to));
  });

  it("a current value is not rewritten when read", async () => {
    const id = randomUUID();
    const writes: Buffer[] = [];
    expect(await openStoredSecret("external-calendar", id, sealSecret("external-calendar", id, "https://cal.example/a.ics"), async (_from, to) => { writes.push(to); }))
      .toBe("https://cal.example/a.ics");
    expect(writes).toEqual([]);
  });

  it("an old value that does not open (another key, another row) is refused and never written", async () => {
    const id = randomUUID();
    const writes: Buffer[] = [];
    const save = async (_from: Buffer, to: Buffer) => { writes.push(to); };
    await expect(openStoredSecret("ai-credential", id, legacySealed(randomBytes(32).toString("hex"), id, "sk-other-server"), save))
      .rejects.toMatchObject({ code: "credential_unreadable" });
    await expect(openStoredSecret("ai-credential", id, legacySealed(KEY, randomUUID(), "sk-moved"), save))
      .rejects.toMatchObject({ code: "credential_unreadable" });
    expect(writes).toEqual([]);
  });

  it("a failed rewrite fails the read: nothing is swallowed", async () => {
    const id = randomUUID();
    await expect(openStoredSecret("ai-credential", id, legacySealed(KEY, id, "sk-old"), async () => { throw new Error("disk full"); }))
      .rejects.toThrow("disk full");
  });

  it("without a key nothing opens or is sealed", async () => {
    delete process.env.ONDEN_SECRET_KEY;
    try {
      const id = randomUUID();
      expect(() => sealSecret("ai-credential", id, "x")).toThrow(expect.objectContaining({ code: "secret_key_missing" }));
      await expect(open("ai-credential", id, legacySealed(KEY, id, "x"))).rejects.toMatchObject({ code: "secret_key_missing" });
    } finally { process.env.ONDEN_SECRET_KEY = KEY; }
  });
});
