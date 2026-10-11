// Reads a .git directory with the platform alone: refs, loose objects and packfiles.
// ponytail: SHA-1 repos only, no alternates, no partial clones. Add them when a repo needs one.
// Nothing here trusts what it reads: a dropped folder can be damaged or written to do harm, so every
// size, offset and chain is bounded and a hash is never checked, only followed.

/** The .git directory, wherever it lives: dropped files in a browser, the disk under bun. */
export interface Folder {
  /** A file's bytes, or the slice [start, end). Undefined when the file does not exist. */
  read(path: string, start?: number, end?: number): Promise<Uint8Array | undefined>;
  size(path: string): Promise<number | undefined>;
  /** Names directly inside a directory. Empty when it does not exist. */
  list(path: string): Promise<string[]>;
}

export type GitObject = { type: "commit" | "tree" | "blob" | "tag"; data: Uint8Array };
export type Commit = { hash: string; tree: string; parent?: string; date: string; subject: string };
export type Entry = { name: string; hash: string; folder: boolean; file: boolean };

const SHA = 20; // bytes in a SHA-1
const NAME = /^[0-9a-f]{40}$/; // an object's name
const IDX_MAGIC = 0xff744f63; // "\377tOc", then the version
const IDX_VERSION = 2;
const IDX_HEADER = 8; // magic and version
const IDX_FANOUT = 256 * 4;
const PACK_TRAILER = SHA; // checksum closing a packfile
const PACK_TYPES = [undefined, "commit", "tree", "blob", "tag"] as const;
const OFS_DELTA = 6;
const REF_DELTA = 7;
const CACHE_BYTES = 64 << 20; // resolved pack objects kept as delta bases; cleared whole when full
const MAX_OBJECT = 256 << 20; // bytes one object may inflate to. A few bytes of deflate can ask for gigabytes.
const MAX_CHAIN = 4096; // deltas between an object and its base. Git itself stops at 4095, so a longer chain is a loop.
const TREE_MODE = "40000";
const FILE_MODES = /^100/; // regular and executable files; symlinks and submodules are neither

const utf8 = new TextDecoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tooLarge = () => new Error("an object in this repository is too large to read");

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_OBJECT) {
      void reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let at = 0;
  const size = () => {
    let value = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = delta[at++]!;
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  };
  size(); // the base's length, which we already hold
  const length = size();
  if (length > MAX_OBJECT) throw tooLarge();
  const out = new Uint8Array(length);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      // Copy from the base: the low bits say which offset and length bytes follow.
      let from = 0;
      let length = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) from += delta[at++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) length += delta[at++]! * 2 ** (8 * bit);
      if (!length) length = 0x10000;
      if (written + length > out.length) break; // a damaged delta writes past the size it declared
      out.set(base.subarray(from, from + length), written);
      written += length;
    } else {
      if (written + op > out.length) break;
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    }
  }
  return out;
}

class Pack {
  private cache = new Map<number, GitObject>();
  private cached = 0;
  private constructor(
    private folder: Folder,
    private path: string,
    private index: DataView,
    private count: number,
    private starts: Float64Array, // every object's offset, ascending
    private end: number,
  ) {}

  static async open(folder: Folder, idxPath: string): Promise<Pack | undefined> {
    const path = idxPath.replace(/\.idx$/, ".pack");
    const [idx, size] = await Promise.all([folder.read(idxPath), folder.size(path)]);
    if (!idx || size === undefined) return undefined;
    const index = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    // A version 1 or cut-short index is skipped, so the other packs can still be read.
    if (idx.byteLength < IDX_HEADER + IDX_FANOUT || index.getUint32(0) !== IDX_MAGIC || index.getUint32(4) !== IDX_VERSION) return undefined;
    const count = index.getUint32(IDX_HEADER + IDX_FANOUT - 4);
    if (idx.byteLength < IDX_HEADER + IDX_FANOUT + count * (SHA + 4 + 4)) return undefined; // names, CRCs and offsets
    const pack = new Pack(folder, path, index, count, new Float64Array(count), size - PACK_TRAILER);
    for (let nth = 0; nth < count; nth++) pack.starts[nth] = pack.offsetOf(nth);
    pack.starts.sort();
    return pack;
  }

  private offsetOf(nth: number): number {
    const table = IDX_HEADER + IDX_FANOUT + this.count * (SHA + 4); // past the names and their CRCs
    const offset = this.index.getUint32(table + nth * 4);
    if (!(offset & 0x80000000)) return offset;
    // Packs over 2 GB keep long offsets in a second table.
    const long = table + this.count * 4 + (offset & 0x7fffffff) * 8;
    return this.index.getUint32(long) * 2 ** 32 + this.index.getUint32(long + 4);
  }

  find(hash: string): number | undefined {
    const first = parseInt(hash.slice(0, 2), 16);
    let low = first ? this.index.getUint32(IDX_HEADER + (first - 1) * 4) : 0;
    let high = this.index.getUint32(IDX_HEADER + first * 4);
    const names = IDX_HEADER + IDX_FANOUT;
    while (low < high) {
      const middle = (low + high) >> 1;
      let name = "";
      for (let byte = 0; byte < SHA; byte++) name += this.index.getUint8(names + middle * SHA + byte).toString(16).padStart(2, "0");
      if (name === hash) return this.offsetOf(middle);
      if (name < hash) low = middle + 1;
      else high = middle;
    }
    return undefined;
  }

  // Objects sit back to back, so one ends where the next starts. That gives the exact
  // compressed bytes, which is all DecompressionStream needs.
  private endOf(offset: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    return low < this.count ? this.starts[low]! : this.end;
  }

  /** `depth` counts the deltas followed to get here, so a chain that loops back on itself ends. */
  async at(offset: number, lookup: (hash: string, depth: number) => Promise<GitObject | undefined>, depth: number): Promise<GitObject | undefined> {
    const hit = this.cache.get(offset);
    if (hit) return hit;
    if (depth > MAX_CHAIN) throw new Error("this repository has a delta chain that never ends");
    const raw = await this.folder.read(this.path, offset, this.endOf(offset));
    if (!raw) return undefined;
    let at = 0;
    let byte = raw[at++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = raw[at++]!; // the inflated size, which inflating tells us anyway

    let object: GitObject | undefined;
    if (type === OFS_DELTA || type === REF_DELTA) {
      let base: GitObject | undefined;
      if (type === OFS_DELTA) {
        byte = raw[at++]!;
        let back = byte & 0x7f;
        while (byte & 0x80) {
          byte = raw[at++]!;
          back = (back + 1) * 128 + (byte & 0x7f);
        }
        if (back <= 0 || back > offset) return undefined; // a base is always earlier in the pack
        base = await this.at(offset - back, lookup, depth + 1);
      } else {
        base = await lookup(hex(raw.subarray(at, at + SHA)), depth + 1);
        at += SHA;
      }
      if (!base) return undefined;
      object = { type: base.type, data: applyDelta(base.data, await inflate(raw.subarray(at))) };
    } else {
      const named = PACK_TYPES[type];
      if (!named) return undefined;
      object = { type: named, data: await inflate(raw.subarray(at)) };
    }

    if (this.cached > CACHE_BYTES) {
      this.cache.clear();
      this.cached = 0;
    }
    this.cache.set(offset, object);
    this.cached += object.data.length;
    return object;
  }
}

/** A ref's value, once it is known to be a name this reader can follow. */
function named(hash: string | undefined): string | undefined {
  if (hash && /^[0-9a-f]{64}$/.test(hash)) throw new Error("SHA-256 repositories are not supported yet");
  return hash;
}

export class Git {
  private constructor(
    private folder: Folder,
    private packs: Pack[],
  ) {}

  static async open(folder: Folder): Promise<Git> {
    const indexes = (await folder.list("objects/pack")).filter((name) => name.endsWith(".idx"));
    const packs = await Promise.all(indexes.map((name) => Pack.open(folder, `objects/pack/${name}`)));
    return new Git(folder, packs.filter((pack) => pack !== undefined));
  }

  /** The commit HEAD points at, or undefined in an empty repo. */
  async head(): Promise<string | undefined> {
    const head = utf8.decode((await this.folder.read("HEAD")) ?? new Uint8Array()).trim();
    if (!head.startsWith("ref: ")) return named(head || undefined);
    const ref = head.slice("ref: ".length);
    if (ref.endsWith("/.invalid")) throw new Error("this repository keeps its refs in a reftable, which is not supported yet");
    const loose = await this.folder.read(ref);
    if (loose) return named(utf8.decode(loose).trim());
    const packed = utf8.decode((await this.folder.read("packed-refs")) ?? new Uint8Array());
    return named(packed.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0]);
  }

  async object(hash: string, depth = 0): Promise<GitObject | undefined> {
    if (!NAME.test(hash)) return undefined; // a damaged tree or commit can name anything
    const loose = await this.folder.read(`objects/${hash.slice(0, 2)}/${hash.slice(2)}`);
    if (loose) {
      const whole = await inflate(loose);
      const header = whole.indexOf(0);
      const type = utf8.decode(whole.subarray(0, header)).split(" ")[0] as GitObject["type"];
      return { type, data: whole.subarray(header + 1) };
    }
    for (const pack of this.packs) {
      const offset = pack.find(hash);
      if (offset !== undefined) return pack.at(offset, (base, deeper) => this.object(base, deeper), depth);
    }
    return undefined;
  }

  async commit(hash: string): Promise<Commit | undefined> {
    const object = await this.object(hash);
    if (object?.type !== "commit") return undefined;
    const text = utf8.decode(object.data);
    const [headers = "", ...message] = text.split("\n\n");
    const header = (name: string) => headers.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    const when = new Date(Number(header("author")?.match(/> (\d+) /)?.[1] ?? 0) * 1000);
    return {
      hash,
      tree: header("tree") ?? "",
      parent: header("parent"), // the first parent: the line the branch itself took
      date: Number.isNaN(when.getTime()) ? "" : when.toISOString().slice(0, 10), // a timestamp can run past the calendar
      subject: message.join("\n\n").split("\n")[0] ?? "",
    };
  }

  async tree(hash: string): Promise<Entry[]> {
    const object = await this.object(hash);
    if (object?.type !== "tree") return [];
    const { data } = object;
    const entries: Entry[] = [];
    for (let at = 0; at < data.length; ) {
      const space = data.indexOf(0x20, at);
      const zero = data.indexOf(0, space);
      if (space < 0 || zero < 0) break; // a damaged tree ends here instead of looping
      const mode = utf8.decode(data.subarray(at, space));
      entries.push({
        name: utf8.decode(data.subarray(space + 1, zero)),
        hash: hex(data.subarray(zero + 1, zero + 1 + SHA)),
        folder: mode === TREE_MODE,
        file: FILE_MODES.test(mode),
      });
      at = zero + 1 + SHA;
    }
    return entries;
  }
}
