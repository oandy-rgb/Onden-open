/** Why a decrypt or pairing step refused its input. Stable codes so callers can show one plain sentence each. */
export type PairingErrorCode =
  | "bad_invite"
  | "bad_hello"
  | "bad_key"
  | "session_mismatch"
  | "bad_chunk" // wrong key, wrong session/file/index/final-flag, or altered bytes (AEAD failure)
  | "bad_chunk_size"
  | "out_of_order"
  | "replay"
  | "missing_chunk"
  | "truncated"
  | "unknown_item"
  | "bad_manifest"
  | "bad_size";

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  constructor(code: PairingErrorCode) {
    super(code);
    this.name = "PairingError";
    this.code = code;
  }
}
