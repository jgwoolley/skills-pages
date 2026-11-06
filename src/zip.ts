// Minimal deterministic zip writer (no dependencies): fixed timestamps and sorted entries, so the same files
// always give the same bytes and the same sha256. Files are deflated unless that doesn't make them smaller.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** POSIX path inside the archive, e.g. "skills/pdf/SKILL.md". */
  path: string;
  data: Buffer;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1 << 5) | 1; // 1980-01-01, the earliest zip date

export function zip(entries: ZipEntry[]): Buffer {
  const files = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..")) throw new Error(`Unsafe zip path: ${f.path}`);
    const name = Buffer.from(f.path, "utf8");
    const deflated = deflateRawSync(f.data, { level: 9 });
    const stored = deflated.length >= f.data.length;
    const body = stored ? f.data : deflated;
    const crc = crc32(f.data);
    const header = (central: boolean) => {
      const b = Buffer.alloc(central ? 46 : 30);
      let o = 0;
      const u32 = (v: number) => (b.writeUInt32LE(v >>> 0, o), (o += 4));
      const u16 = (v: number) => (b.writeUInt16LE(v, o), (o += 2));
      u32(central ? 0x02014b50 : 0x04034b50);
      if (central) u16(0x031e); // made by: UNIX, zip 3.0
      u16(20); // version needed
      u16(0x0800); // UTF-8 names
      u16(stored ? 0 : 8);
      u16(DOS_TIME);
      u16(DOS_DATE);
      u32(crc);
      u32(body.length);
      u32(f.data.length);
      u16(name.length);
      u16(0); // extra
      if (central) {
        u16(0); // comment
        u16(0); // disk
        u16(0); // internal attrs
        u32((0o100644 << 16) >>> 0); // external attrs: regular file, rw-r--r--
        u32(offset);
      }
      return b;
    };
    const local = Buffer.concat([header(false), name, body]);
    locals.push(local);
    centrals.push(Buffer.concat([header(true), name]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
