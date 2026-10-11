// A .git directory on disk, for the tests. The page reads dropped files instead.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Folder } from "../src/lib/git";

export const disk = (root: string): Folder => ({
  async read(path, start, end) {
    try {
      if (start === undefined || end === undefined) return new Uint8Array(await readFile(join(root, path)));
      const file = await open(join(root, path));
      const bytes = new Uint8Array(end - start);
      await file.read(bytes, 0, bytes.length, start);
      await file.close();
      return bytes;
    } catch {
      return undefined;
    }
  },
  size: (path) => stat(join(root, path)).then((found) => found.size, () => undefined),
  list: (path) => readdir(join(root, path)).catch(() => []),
});
