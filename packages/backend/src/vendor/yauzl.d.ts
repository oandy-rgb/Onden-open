// The part of yauzl 3.x (no @types package in the lockfile) that
// services/backupFile.ts uses (and `fromBuffer`, for tests that read an archive in memory).
declare module "yauzl" {
  import type { Readable } from "node:stream";
  import type { EventEmitter } from "node:events";

  export interface Entry {
    fileName: string;
    compressedSize: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    isEncrypted(): boolean;
    isCompressed(): boolean;
  }

  export interface ZipFile extends EventEmitter {
    entryCount: number;
    readEntry(): void;
    openReadStream(entry: Entry, callback: (err: Error | null, stream: Readable) => void): void;
    close(): void;
    on(event: "entry", listener: (entry: Entry) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  }

  export interface Options {
    autoClose?: boolean;
    lazyEntries?: boolean;
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    strictFileNames?: boolean;
  }

  export function open(path: string, options: Options, callback: (err: Error | null, zipfile: ZipFile) => void): void;
  export function fromBuffer(buffer: Buffer, options: Options, callback: (err: Error | null, zipfile: ZipFile) => void): void;
}
