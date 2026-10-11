// Turns a repo into the part data the factory draws: which files exist at each step,
// how big they are and which files they import. No file contents are kept.
import { Git, type Commit, type Folder } from "./git";

export type Step = {
  hash: string;
  date: string;
  subject: string;
  /** Which commit of the branch this is, counting from 1. */
  nth: number;
  /** Files that are new, resized or import something different: [file, bytes, files it imports]. */
  set: [file: number, bytes: number, imports: number[]][];
  gone: number[];
  /** Files whose contents changed in this step. */
  touched: number[];
};
export type Scan = { name: string; commits: number; paths: string[]; steps: Step[] };
export type Progress = (phase: "history" | "steps", done: number, total: number) => void;

const MAX_STEPS = 150; // ponytail: longer histories are sampled evenly along the first-parent line. Raise it, or sample by change size, if replays feel coarse.
const MAX_PARSED = 1 << 20; // bytes. Anything larger is a bundle or data: it counts as a file but lays no belts.
const HISTORY_TICK = 50; // commits between progress reports while walking back
const MAX_CONFIG = 64 << 10; // bytes. A real tsconfig or package.json is a few kB; a larger one is skipped rather than parsed.
const MAX_PATH = 4096; // characters. No real path is longer, so a longer one is a folder that contains itself.
const MAX_TREES = 300_000; // folders read in one scan, far past any repo we have read. Beyond it the tree is damaged or built to exhaust the tab.

const SOURCE = /\.(tsx?|jsx?|mts|cts|mjs|cjs|astro|vue|svelte|mdx|css|scss|html|swift|py|go|rs|rb|java|kt|c|h|cc|cpp|m|mm|sh)$/;
const IMPORTING = /\.(tsx?|jsx?|mts|cts|mjs|cjs|astro|vue|svelte|mdx|css|scss)$/;
const CONFIG = /(^|\/)(package|tsconfig[^/]*|jsconfig)\.json$/;
const TS_CONFIG = /(^|\/)[tj]sconfig[^/]*\.json$/;
const STYLESHEET = /\.s?css$/;
export const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".next", ".git", ".venv", "__pycache__"]);
// `from "x"`, `import "x"`, `import("x")`, `require("x")` and CSS `@import "x"`.
// The bracket and the space after it are one optional group: as two optional runs of space they made a long blank line cost its length squared.
const IMPORT = /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?["']([^"'\n]+)["']/g;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".astro", ".vue", ".svelte", ".css", ".scss"];
const JS_EXTENSION = /\.[mc]?jsx?$/; // TypeScript's ESM style writes "./x.js" for x.ts

const utf8 = new TextDecoder();
export const wanted = (path: string) => SOURCE.test(path) || CONFIG.test(path);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Undefined when the path climbs out of the repo. */
function join(base: string, relative: string): string | undefined {
  const parts = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// tsconfig allows comments and trailing commas. Strings are matched first so "@/*" survives.
function parseLoose(text: string): Record<string, any> | undefined {
  const bare = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match[0] === '"' ? match : ""));
  try {
    return JSON.parse(bare.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, (match) => (match === "," ? "" : match)));
  } catch {
    return undefined;
  }
}

type Source = { bytes: number; specs: string[] };
type Aliases = { home: string; base: string; hasBase: boolean; paths: [pattern: string, targets: string[]][] };

/** What the tree holds right now: source files and the configs that say how imports resolve. */
class Work {
  files = new Map<string, Source>();
  configs = new Map<string, Record<string, any>>();

  put(path: string, data: Uint8Array) {
    if (CONFIG.test(path)) {
      const json = data.length <= MAX_CONFIG ? parseLoose(utf8.decode(data)) : undefined;
      if (json && typeof json === "object") this.configs.set(path, json);
      else this.configs.delete(path);
    } else {
      const parse = IMPORTING.test(path) && data.length <= MAX_PARSED;
      this.files.set(path, { bytes: data.length, specs: parse ? Array.from(utf8.decode(data).matchAll(IMPORT), (match) => match[1]!) : [] });
    }
  }

  drop(path: string) {
    this.files.delete(path);
    this.configs.delete(path);
  }

  /** A function from (importing file, specifier) to the file it means, if that file is in the repo. */
  resolver(): (file: string, spec: string) => string | undefined {
    const aliases: Aliases[] = [];
    const packages: [name: string, home: string][] = [];
    for (const [path, json] of this.configs) {
      const home = dirname(path);
      if (TS_CONFIG.test(path)) {
        // Only the shapes TypeScript itself accepts: a string, and lists of strings.
        const options = json.compilerOptions ?? {};
        const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
        const paths = Object.entries(options.paths && typeof options.paths === "object" ? options.paths : {}).flatMap(([pattern, targets]): Aliases["paths"] =>
          Array.isArray(targets) ? [[pattern, targets.filter((target) => typeof target === "string")]] : [],
        );
        const base = join(home, baseUrl ?? ".");
        // ponytail: `extends` is not followed. Every config above a file is asked in turn instead, nearest first, which finds the paths a parent holds.
        if (base !== undefined && (baseUrl !== undefined || paths.length)) aliases.push({ home, base, hasBase: baseUrl !== undefined, paths });
      } else if (typeof json.name === "string") packages.push([json.name, home]);
    }
    // Nearest first: a file answers to the deepest config above it.
    aliases.sort((p, q) => q.home.length - p.home.length);
    packages.sort((p, q) => q[1].length - p[1].length);
    const under = (file: string, home: string) => !home || file.startsWith(`${home}/`);

    const probe = (path: string | undefined): string | undefined => {
      if (path === undefined) return undefined;
      if (this.files.has(path)) return path;
      const stem = JS_EXTENSION.test(path) ? path.replace(JS_EXTENSION, "") : undefined;
      for (const extension of EXTENSIONS) {
        if (stem && this.files.has(stem + extension)) return stem + extension;
        if (this.files.has(path + extension)) return path + extension;
      }
      for (const extension of EXTENSIONS) if (this.files.has(`${path}/index${extension}`)) return `${path}/index${extension}`;
      return undefined;
    };

    return (file, spec) => {
      if (spec.startsWith(".")) return probe(join(dirname(file), spec));

      for (const config of aliases) {
        if (!under(file, config.home)) continue;
        for (const [pattern, targets] of config.paths) {
          const star = pattern.indexOf("*");
          const head = star < 0 ? pattern : pattern.slice(0, star);
          const tail = star < 0 ? "" : pattern.slice(star + 1);
          const fits = star < 0 ? spec === pattern : spec.length >= pattern.length - 1 && spec.startsWith(head) && spec.endsWith(tail);
          if (!fits) continue;
          const middle = spec.slice(head.length, spec.length - tail.length);
          for (const target of targets) {
            const hit = probe(join(config.base, target.replace("*", middle)));
            if (hit) return hit;
          }
        }
        if (config.hasBase) {
          const hit = probe(join(config.base, spec));
          if (hit) return hit;
        }
      }

      // A workspace package: its name is the specifier, its folder is in the repo.
      for (const [name, home] of packages) {
        if (spec !== name && !spec.startsWith(`${name}/`)) continue;
        const rest = spec.slice(name.length + 1);
        return probe(join(home, rest)) ?? probe(join(home, `src/${rest}`));
      }

      // ponytail: bundler aliases live in vite, astro, nuxt and svelte configs we do not read. "@/x" and "~/x" nearly
      // always mean x under src, the app's own folder (Nuxt 3) or app (Nuxt 4), and "$lib/x" is SvelteKit's src/lib/x.
      const rest = spec.startsWith("$lib/") ? `lib/${spec.slice("$lib/".length)}` : /^[@~]\//.test(spec) ? spec.slice(2) : undefined;
      if (rest !== undefined) {
        const home = packages.find(([, at]) => under(file, at))?.[1] ?? "";
        for (const root of ["src/", "", "app/"]) {
          const hit = probe(join(home, root + rest));
          if (hit) return hit;
        }
      }
      // A stylesheet's bare "tokens.css" is a neighbour, not a package.
      if (STYLESHEET.test(file)) return probe(join(dirname(file), spec));
      return undefined;
    };
  }
}

/** Builds steps one at a time, each as the difference from the one before. */
class Steps {
  paths: string[] = [];
  steps: Step[] = [];
  private ids = new Map<string, number>();
  private prior = new Map<string, { bytes: number; imports: number[] }>();

  private id(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) {
      id = this.paths.push(path) - 1;
      this.ids.set(path, id);
    }
    return id;
  }

  add(work: Work, touched: string[], label: Pick<Step, "hash" | "date" | "subject" | "nth">) {
    const resolve = work.resolver();
    const next = new Map<string, { bytes: number; imports: number[] }>();
    for (const [path, source] of work.files) {
      const targets = new Set<number>();
      for (const spec of source.specs) {
        const hit = resolve(path, spec);
        if (hit && hit !== path) targets.add(this.id(hit));
      }
      next.set(path, { bytes: source.bytes, imports: [...targets].sort((p, q) => p - q) });
    }
    const set: Step["set"] = [];
    for (const [path, now] of next) {
      const was = this.prior.get(path);
      if (!was || was.bytes !== now.bytes || was.imports.join() !== now.imports.join()) set.push([this.id(path), now.bytes, now.imports]);
    }
    const gone = [...this.prior.keys()].filter((path) => !next.has(path)).map((path) => this.id(path));
    this.steps.push({ ...label, set, gone, touched: touched.map((path) => this.id(path)) });
    this.prior = next;
  }
}

type Change = { changed: { path: string; blob: string }[]; removed: string[]; /** Folders read so far in this scan. */ trees: { read: number } };

// Walks two trees side by side and stops at any subtree whose hash is unchanged,
// so a commit costs only the folders it touched.
async function diff(git: Git, before: string | undefined, after: string | undefined, dir: string, out: Change) {
  if (before === after) return;
  // Hashes are followed, never checked, so a tree can hold itself or fan out without end.
  if (dir.length > MAX_PATH || (out.trees.read += 1) > MAX_TREES) throw new Error("this repository nests folders deeper or wider than can be read");
  const [was, now] = await Promise.all([before ? git.tree(before) : [], after ? git.tree(after) : []]);
  // A name that turns from file to folder is a removal and an addition, so the kind is part of the key.
  const kept = (entries: typeof was) => new Map(entries.filter((entry) => entry.folder || entry.file).map((entry) => [`${entry.folder}:${entry.name}`, entry]));
  const old = kept(was);
  for (const [name, entry] of kept(now)) {
    const prior = old.get(name);
    old.delete(name);
    if (prior?.hash === entry.hash) continue;
    const path = dir + entry.name;
    if (entry.folder) {
      if (!IGNORED.has(entry.name)) await diff(git, prior?.hash, entry.hash, `${path}/`, out);
    } else if (wanted(path)) out.changed.push({ path, blob: entry.hash });
  }
  for (const prior of old.values()) {
    const path = dir + prior.name;
    if (prior.folder) {
      if (!IGNORED.has(prior.name)) await diff(git, prior.hash, undefined, `${path}/`, out);
    } else if (wanted(path)) out.removed.push(path);
  }
}

/** A repo's history, oldest first, from its .git directory. Undefined when there are no commits to read. */
export async function scanGit(folder: Folder, name: string, progress: Progress = () => {}): Promise<Scan | undefined> {
  const git = await Git.open(folder);
  const chain: Commit[] = [];
  const walked = new Set<string>();
  for (let hash = await git.head(); hash && !walked.has(hash); ) {
    const commit = await git.commit(hash);
    if (!commit) break; // a shallow clone: history ends where its objects do
    walked.add(hash); // a damaged commit can name itself, or one after it, as its parent
    chain.push(commit);
    hash = commit.parent;
    if (chain.length % HISTORY_TICK === 0) progress("history", chain.length, 0);
  }
  if (!chain.length) return undefined;
  chain.reverse();
  const picks = chain.length <= MAX_STEPS ? chain.map((_, index) => index) : Array.from({ length: MAX_STEPS }, (_, index) => Math.round((index * (chain.length - 1)) / (MAX_STEPS - 1)));

  const work = new Work();
  const steps = new Steps();
  let tree: string | undefined;
  const trees = { read: 0 };
  for (const [done, pick] of picks.entries()) {
    const commit = chain[pick]!;
    const change: Change = { changed: [], removed: [], trees };
    await diff(git, tree, commit.tree, "", change);
    tree = commit.tree;
    // A partial clone holds every tree but not every blob. A file it cannot read was never here, as far as the factory goes.
    const removed = change.removed.filter((path) => work.files.has(path) || work.configs.has(path));
    for (const path of removed) work.drop(path);
    const read: string[] = [];
    for (const { path, blob } of change.changed) {
      const data = (await git.object(blob))?.data;
      if (!data) continue;
      work.put(path, data);
      read.push(path);
    }
    const touched = [...removed, ...read].filter((path) => SOURCE.test(path));
    // A commit that changed no source file draws nothing new, so it is not a step.
    if (touched.length) steps.add(work, touched, { hash: commit.hash.slice(0, 7), date: commit.date, subject: commit.subject, nth: pick + 1 });
    progress("steps", done + 1, picks.length);
  }
  return { name, commits: chain.length, paths: steps.paths, steps: steps.steps };
}

/** A folder with no history: one step holding everything in it. */
export async function scanFiles(name: string, files: { path: string; read(): Promise<Uint8Array> }[], progress: Progress = () => {}): Promise<Scan> {
  const work = new Work();
  for (const [done, file] of files.entries()) {
    work.put(file.path, await file.read());
    progress("steps", done + 1, files.length);
  }
  const steps = new Steps();
  steps.add(work, [], { hash: "", date: "", subject: "The folder as it is. No .git history was found in it.", nth: 1 });
  return { name, commits: 0, paths: steps.paths, steps: steps.steps };
}
