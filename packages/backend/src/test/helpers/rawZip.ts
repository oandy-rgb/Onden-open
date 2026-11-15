import { crc32, deflateRawSync } from "node:zlib";

/** A stored (uncompressed) zip with exactly these entry names — including
 *  names an archiver would refuse to write (`../x`) — for testing a reader.
 *  `deflate` compresses the entry; `declaredSize` overrides the uncompressed
 *  size the headers state (with deflate: a zip bomb's claim). */
export function rawZip(entries: Array<{ name: string; data: Buffer | string; deflate?: boolean; declaredSize?: number;
  /** Unix mode bits in the external attributes (e.g. 0o120777: a symlink). */
  unixMode?: number;
  /** Set the "encrypted" general-purpose flag bit. */
  encrypted?: boolean;
  /** Store the bytes as they are but say they are deflated (a corrupt entry). */
  claimDeflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const plain = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const data = entry.deflate ? deflateRawSync(plain) : plain;
    const method = entry.deflate || entry.claimDeflate ? 8 : 0;
    const crc = crc32(plain);
    const size = entry.declaredSize ?? plain.length;
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : 0x0314, 4);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    if (entry.unixMode !== undefined) central.writeUInt32LE((entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
