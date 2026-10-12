// The reader against git itself: a small repo is built with the CLI, read loose and again
// once packed, and every step has to list the files and sizes `git ls-tree` does.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { disk } from "./disk";
import { scanGit, type Scan } from "../src/lib/scan";

const fixture = (repo: string) => {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const commit = (subject: string, files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(repo, path));
      else {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  return { git, commit };
};
const repo = mkdtempSync(join(tmpdir(), "isometric-git-"));
const { git, commit } = fixture(repo);
const filler = (seed: string) => Array.from({ length: 400 }, (_, line) => `export const ${seed}${line} = ${line};`).join("\n");

git("init", "-q");
commit("readme only", { "README.md": "not source" });
commit("shared and an alias", {
  "tsconfig.json": `{ // comments are allowed\n "compilerOptions": { "paths": { "@/*": ["./src/*"], }, } }`,
  "src/shared/time.ts": filler("time"),
  "src/core/run.ts": `import { time0 } from "@/shared/time";\nimport "./missing";\n`,
});
commit("ui imports core, js extension for a ts file", { "src/ui/App.tsx": `import { run } from "../core/run.js";\nexport {\n  time0,\n} from "../shared/time";\n` });
commit("grow a file so packing has something to delta", { "src/shared/time.ts": `${filler("time")}\nexport const more = 1;\n` });
commit("drop ui", { "src/ui/App.tsx": null });

const filesAt = (scan: Scan, upTo: number) => {
  const files = new Map<string, { bytes: number; imports: string[] }>();
  for (const step of scan.steps.slice(0, upTo + 1)) {
    for (const [file, bytes, imports] of step.set) files.set(scan.paths[file]!, { bytes, imports: imports.map((id) => scan.paths[id]!) });
    for (const file of step.gone) files.delete(scan.paths[file]!);
  }
  return files;
};

async function check() {
  const scan = (await scanGit(disk(join(repo, ".git")), "fixture"))!;
  expect(scan.commits).toBe(5);
  expect(scan.steps.map((step) => step.subject)).toEqual(["shared and an alias", "ui imports core, js extension for a ts file", "grow a file so packing has something to delta", "drop ui"]);
  scan.steps.forEach((step, index) => {
    const truth = git("ls-tree", "-r", "-l", step.hash).split("\n").filter((line) => /\.tsx?$/.test(line)).map((line) => [line.split("\t")[1], Number(line.split(/\s+/)[3])]);
    expect([...filesAt(scan, index)].map(([path, { bytes }]) => [path, bytes]).sort()).toEqual(truth.sort());
  });
  expect(filesAt(scan, 0).get("src/core/run.ts")!.imports).toEqual(["src/shared/time.ts"]);
  expect(filesAt(scan, 1).get("src/ui/App.tsx")!.imports.sort()).toEqual(["src/core/run.ts", "src/shared/time.ts"]);
  expect(filesAt(scan, 3).has("src/ui/App.tsx")).toBe(false);
}

test("reads loose objects", check);
test("reads the same history from a packfile", async () => {
  git("gc", "-q", "--aggressive", "--prune=now");
  await check();
  rmSync(repo, { recursive: true });
});

test("a tsconfig-only commit that changes paths reroutes imports in its own step", async () => {
  const repo = mkdtempSync(join(tmpdir(), "isometric-git-"));
  const { git, commit } = fixture(repo);
  const paths = (to: string) => `{ "compilerOptions": { "paths": { "@/*": ["./${to}/*"] } } }`;
  try {
    git("init", "-q");
    commit("two homes for a module", { "tsconfig.json": paths("one"), "src/run.ts": `import "@/model";`, "one/model.ts": "export {};", "two/model.ts": "export {};" });
    commit("reroute the alias", { "tsconfig.json": paths("two") });
    commit("unrelated config", { "package.json": `{ "name": "app" }` });
    const scan = (await scanGit(disk(join(repo, ".git")), "alias"))!;
    expect(scan.steps.map((step) => step.subject)).toEqual(["two homes for a module", "reroute the alias"]); // a config that reroutes nothing draws nothing
    expect(filesAt(scan, 0).get("src/run.ts")!.imports).toEqual(["one/model.ts"]);
    expect(filesAt(scan, 1).get("src/run.ts")!.imports).toEqual(["two/model.ts"]);
    expect(scan.steps[1]!.touched).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true });
  }
});
