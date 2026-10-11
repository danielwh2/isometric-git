// Anything can be dropped on the page: a damaged repo, a hostile one, a file written to stall a parser.
// None of it may hang the tab or end in an error nobody can read.
import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import type { Folder } from "../src/lib/git";
import { scanFiles, scanGit, type Scan } from "../src/lib/scan";

const text = new TextEncoder();
const hash = (letter: string) => letter.repeat(40);
const raw = (name: string) => Uint8Array.from(name.match(/../g)!, (pair) => parseInt(pair, 16));

/** A .git directory held in memory, of loose objects named whatever the test likes: nothing checks a hash. */
function repo(head: string, objects: Record<string, [type: string, body: Uint8Array | string]>): Folder {
  const files = new Map<string, Uint8Array>([["HEAD", text.encode(`${head}\n`)]]);
  for (const [name, [type, body]] of Object.entries(objects)) {
    const bytes = typeof body === "string" ? text.encode(body) : body;
    files.set(`objects/${name.slice(0, 2)}/${name.slice(2)}`, deflateSync(Buffer.concat([text.encode(`${type} ${bytes.length}\0`), bytes])));
  }
  return { read: async (path) => files.get(path), size: async (path) => files.get(path)?.length, list: async () => [] };
}
const commit = (tree: string, parent: string | undefined, seconds = 1_700_000_000) => `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author a <a@a> ${seconds} +0000\n\nsubject\n`;
const tree = (...entries: [mode: string, name: string, hash: string][]) => Buffer.concat(entries.flatMap(([mode, name, of]) => [text.encode(`${mode} ${name}\0`), raw(of)]));

const files = (given: Record<string, string>) => Object.entries(given).map(([path, body]) => ({ path, read: async () => text.encode(body) }));
const importsOf = (scan: Scan, path: string) => scan.steps[0]!.set.find(([file]) => scan.paths[file] === path)![2].map((id) => scan.paths[id]);

test("a commit that names itself as its parent ends the walk", async () => {
  const scan = await scanGit(repo(hash("c"), {
    [hash("c")]: ["commit", commit(hash("e"), hash("c"))],
    [hash("e")]: ["tree", tree(["100644", "a.ts", hash("b")])],
    [hash("b")]: ["blob", "export {};"],
  }), "loop");
  expect(scan!.commits).toBe(1);
});

test("a tree that holds itself is refused", async () => {
  const folder = repo(hash("c"), {
    [hash("c")]: ["commit", commit(hash("e"), undefined)],
    [hash("e")]: ["tree", tree(["40000", "a", hash("e")])],
  });
  await expect(scanGit(folder, "loop")).rejects.toThrow(/folders/);
});

test("a date past the end of the calendar is left blank", async () => {
  const scan = await scanGit(repo(hash("c"), {
    [hash("c")]: ["commit", commit(hash("e"), undefined, 99_999_999_999_999_999)],
    [hash("e")]: ["tree", tree(["100644", "a.ts", hash("b")])],
    [hash("b")]: ["blob", "export {};"],
  }), "late");
  expect(scan!.steps[0]!.date).toBe("");
});

test("a SHA-256 repo says so", async () => {
  await expect(scanGit(repo("a".repeat(64), {}), "sha256")).rejects.toThrow(/SHA-256/);
});

test("a file written to stall the import pattern does not", async () => {
  const QUICK = 300; // ms. Before the pattern was fixed this input took seconds, and grew with the square of its length.
  const began = performance.now();
  await scanFiles("stall", files({ "a.ts": `from${" ".repeat(60_000)}` }));
  expect(performance.now() - began).toBeLessThan(QUICK);
});

test("a tsconfig with the wrong shapes in it is ignored", async () => {
  const scan = await scanFiles("odd", files({
    "tsconfig.json": `{ "compilerOptions": { "baseUrl": 5, "paths": { "@/*": null, "#/*": "lib" } } }`,
    "a.ts": `import "@/b";`,
    "src/b.ts": "",
  }));
  expect(importsOf(scan, "a.ts")).toEqual(["src/b.ts"]);
});

test("imports resolve the way the common frameworks mean them", async () => {
  const scan = await scanFiles("apps", files({
    "src/lib/store.ts": "",
    "src/routes/page.svelte": `import { store } from "$lib/store";`,
    "components/card.vue": "",
    "pages/index.vue": `import Card from "~/components/card.vue";`,
    "styles/tokens.css": "",
    "styles/site.css": `@import "tokens.css";`,
    "tsconfig.json": `{ "compilerOptions": { "paths": { "#/*": ["./kit/*"] } } }`,
    "web/tsconfig.json": `{ "extends": "../tsconfig.json", "compilerOptions": { "baseUrl": "." } }`,
    "kit/button.ts": "",
    "web/app.ts": `import "#/button";`,
    "shared/x.ts": "",
    "root.ts": `import "../shared/x";`,
  }));
  expect(importsOf(scan, "src/routes/page.svelte")).toEqual(["src/lib/store.ts"]);
  expect(importsOf(scan, "pages/index.vue")).toEqual(["components/card.vue"]);
  expect(importsOf(scan, "styles/site.css")).toEqual(["styles/tokens.css"]);
  expect(importsOf(scan, "web/app.ts")).toEqual(["kit/button.ts"]);
  expect(importsOf(scan, "root.ts")).toEqual([]); // "../" from the top leaves the repo
});
