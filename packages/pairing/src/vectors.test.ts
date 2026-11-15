import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { tokenHash } from "./index.ts";

// Official vectors, run through the same library entry points the module uses.
describe("X25519 (RFC 7748 §6.1)", () => {
  const alice = { sk: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", pk: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a" };
  const bob = { sk: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", pk: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f" };
  const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

  it("derives the published public keys and shared secret", () => {
    expect(bytesToHex(x25519.getPublicKey(hexToBytes(alice.sk)))).toBe(alice.pk);
    expect(bytesToHex(x25519.getPublicKey(hexToBytes(bob.sk)))).toBe(bob.pk);
    expect(bytesToHex(x25519.getSharedSecret(hexToBytes(alice.sk), hexToBytes(bob.pk)))).toBe(shared);
    expect(bytesToHex(x25519.getSharedSecret(hexToBytes(bob.sk), hexToBytes(alice.pk)))).toBe(shared);
  });
});

describe("HKDF-SHA256 (RFC 5869 A.1)", () => {
  it("matches the basic test case", () => {
    const okm = hkdf(sha256, new Uint8Array(22).fill(0x0b), hexToBytes("000102030405060708090a0b0c"), hexToBytes("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(bytesToHex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });
});

describe("ChaCha20-Poly1305 (RFC 8439 §2.8.2)", () => {
  it("matches the AEAD example", () => {
    const key = hexToBytes("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const nonce = hexToBytes("070000004041424344454647");
    const aad = hexToBytes("50515253c0c1c2c3c4c5c6c7");
    const plaintext = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const sealed = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    expect(bytesToHex(sealed)).toBe(
      "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116" +
        "1ae10b594f09e26a7e902ecbd0600691",
    );
    expect(chacha20poly1305(key, nonce, aad).decrypt(sealed)).toEqual(plaintext);
  });
});

describe("tokenHash", () => {
  it("is lowercase hex SHA-256 of the token text (FIPS 180-2 'abc' vector)", () => {
    expect(tokenHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
