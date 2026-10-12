// Branches, merges and conflicts, against git itself. The factory follows the line the branch itself took,
// so a merge is one step: it has to hold what the merge commit holds, and say how many commits it brought in.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { disk } from "./disk";
import { scanGit } from "../src/lib/scan";

const repo = mkdtempSync(join(tmpdir(), "isometric-git-merge-"));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const commit = (subject: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", subject);
};
const scan = async () => (await scanGit(disk(join(repo, ".git")), "merges"))!;
const sizes = (hash: string) => git("ls-tree", "-r", "-l", hash).split("\n").filter((line) => /\.ts$/.test(line)).map((line) => [line.split("\t")[1], Number(line.split(/\s+/)[3])]).sort();

const CARD = 'import { till } from "../till";\n';

git("init", "-q", "-b", "main");
commit("till", { "src/till.ts": "export const till = 1;\n" });

// Two commits on a branch, and one on main that changes the same line: the merge stops on a conflict.
git("checkout", "-q", "-b", "gift-cards");
commit("gift cards", { "src/cards/card.ts": CARD });
commit("the till takes cards", { "src/till.ts": "export const till = 2; // cards\n" });
git("checkout", "-q", "main");
commit("the till takes cash", { "src/till.ts": "export const till = 3; // cash\n" });
const RESOLVED = "export const till = 4; // cards and cash, settled by hand\n";

test("a repo dropped halfway through a merge shows its last commit and says so", async () => {
  expect(() => git("merge", "gift-cards")).toThrow(); // the conflict
  const found = await scan();
  expect(found.midway).toBe("merge");
  expect(found.steps.map((step) => step.subject)).toEqual(["till", "the till takes cash"]);
});

test("a merge is one step, holding the conflict as it was settled and the commits it brought in", async () => {
  writeFileSync(join(repo, "src/till.ts"), RESOLVED);
  git("add", "-A");
  git("commit", "-q", "--no-edit");
  const found = await scan();
  expect(found.midway).toBeUndefined();
  expect(found.steps.map((step) => [step.subject, step.merge])).toEqual([["till", undefined], ["the till takes cash", undefined], ["Merge branch 'gift-cards'", 2]]);
  const merge = found.steps.at(-1)!;
  // The till is what both branches changed. The card came from one of them alone.
  expect(merge.contested?.map((file) => found.paths[file])).toEqual(["src/till.ts"]);
  expect(merge.delivered?.map((file) => found.paths[file]).sort()).toEqual(["src/cards/card.ts", "src/till.ts"]);
  expect(merge.set.map(([file, bytes]) => [found.paths[file], bytes]).sort()).toEqual([["src/cards/card.ts", CARD.length], ["src/till.ts", RESOLVED.length]]);
  const standing = new Map(found.steps.flatMap((step) => step.set.map(([file, bytes]) => [found.paths[file], bytes] as const)));
  expect([...standing].sort()).toEqual(sizes("HEAD"));
});

test("a branch grown from one already merged brings in only its own commits", async () => {
  git("checkout", "-q", "-b", "receipts", "gift-cards"); // from the old branch's tip, not from main
  commit("receipts", { "src/cards/receipt.ts": "export {};\n" });
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "--no-edit", "receipts");
  const joined = (await scan()).steps.at(-1)!;
  expect(joined.merge).toBe(1);
  expect(joined.contested).toBeUndefined(); // nothing on main had moved under it
});

test("three branches joined at once count together", async () => {
  for (const branch of ["a", "b"]) {
    git("checkout", "-q", "-b", branch, "main");
    commit(branch, { [`src/${branch}/index.ts`]: "export {};\n" });
  }
  git("checkout", "-q", "main");
  commit("main moves on", { "src/till.ts": `${RESOLVED}export {};\n` }); // or git fast-forwards to the first branch and joins only the second
  git("merge", "-q", "--no-edit", "a", "b");
  const found = await scan();
  expect(found.steps.at(-1)!.merge).toBe(2);
  expect(found.steps.at(-1)!.contested).toBeUndefined(); // each file is as one branch left it, so no two of the three met
  expect([...new Map(found.steps.flatMap((step) => step.set.map(([file, bytes]) => [found.paths[file], bytes] as const)))].sort()).toEqual(sizes("HEAD"));
});

test("a shallow clone marks its merges without counting them, and one cut at a merge delivers nothing", async () => {
  // Three commits on main while a branch of one waits: by the branch, a shallow clone reaches a commit of main's that its own line does not.
  git("checkout", "-q", "-b", "late");
  commit("late", { "src/late/index.ts": "export {};\n" });
  git("checkout", "-q", "main");
  for (const nth of [1, 2, 3]) commit(`main ${nth}`, { "src/till.ts": `${RESOLVED}// ${nth}\n` });
  git("merge", "-q", "--no-edit", "late");
  const shallow = (depth: number) => {
    const copy = mkdtempSync(join(tmpdir(), "isometric-git-shallow-"));
    execFileSync("git", ["clone", "-q", "--depth", String(depth), `file://${repo}`, copy], { stdio: "ignore" });
    return scanGit(disk(join(copy, ".git")), "shallow").finally(() => rmSync(copy, { recursive: true }));
  };
  expect((await scan()).steps.at(-1)!.merge).toBe(1);
  const cut = (await shallow(3))!.steps.at(-1)!;
  expect(cut.merge).toBe(0);
  expect(cut.delivered?.length).toBe(1);
  const tip = (await shallow(1))!;
  expect(tip.steps.length).toBe(1);
  expect(tip.steps[0]!.merge).toBe(0);
  expect(tip.steps[0]!.delivered).toBeUndefined(); // its one step is the whole repo, not what the merge changed
  rmSync(repo, { recursive: true });
});
