// Send-to-phone pairing and encryption. Design, derivations and threat model:
// docs/architecture/send-to-phone-crypto.md. Load this only when the feature is opened (never from the boot path).
export { PairingError, type PairingErrorCode } from "./errors.ts";
export { fromBase64Url, toBase64Url } from "./encoding.ts";
export {
  PROTOCOL_VERSION,
  SessionKeys,
  acceptInvite,
  completeOnPage,
  completeOnPhone,
  createInvite,
  encodeInvite,
  parseHello,
  parseInvite,
  tokenHash,
  type InviteContents,
  type PagePairing,
  type PhonePairing,
  type RandomSource,
} from "./pairing.ts";
export {
  DEFAULT_CHUNK_BYTES,
  FileReceiver,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  TAG_BYTES,
  chunkCountFor,
  decryptChunk,
  decryptFile,
  encryptChunk,
  encryptFileChunks,
} from "./stream.ts";
export {
  FinalManifest,
  ITEM_ID_PATTERN,
  ManifestWriter,
  describeItem,
  openProgressManifest,
  type ManifestItem,
  type ManifestItemKind,
} from "./manifest.ts";
