// The stamp's promise: a challenge link carries a factory there and back unchanged, and a link
// written by a stranger can never hand the painter something it cannot draw.
import { expect, test } from "bun:test";
import sample from "../src/data/sample.json";
import { plan } from "../src/lib/plan";
import type { Scan } from "../src/lib/scan";
import { blueprintOf, pack, rankOf, sceneOf, scoreOf, unpack, type Blueprint, type Look } from "../src/lib/stamp";

const scan = sample as unknown as Scan;
const blueprint = blueprintOf(plan(scan), scan.commits);
const look: Look = { title: "corner-shop", paper: "#f0f2ec", ink: "#2f4a3b", accent: "#c8553d", style: "poster" };
const link = (payload: unknown) => btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

test("a blueprint holds what stands at the last step", () => {
  expect(blueprint.machines.length).toBe(13);
  expect(blueprint.machines.reduce((sum, [, , files]) => sum + files, 0)).toBe(60);
  expect(blueprint.belts.length).toBe(27);
  expect(blueprint.commits).toBe(21);
});

test("a link carries the factory and its look there and back", () => {
  const packed = pack(blueprint, look);
  expect(packed).toMatch(/^[A-Za-z0-9_-]+$/); // the only characters every host passes through a URL's fragment
  expect(unpack(packed)).toEqual({ blueprint, look });
  expect(unpack(pack(blueprint, { ...look, title: "Zażółć 工場" }))!.look.title).toBe("Zażółć 工場");
  // A folder's name fills the title unasked and can be any length: the link carries what the stamp has room for.
  expect(unpack(pack(blueprint, { ...look, title: "工".repeat(60) }))!.look.title).toBe("工".repeat(40));
});

test("the score counts files, kB and belts, and names a rank", () => {
  const small: Blueprint = { commits: 1, machines: [[0, 0, 10, 100], [1, 0, 5, 50]], belts: [[0, 1, 3]] };
  expect(scoreOf(small)).toBe(10 + 5 + 100 + 50 + 5);
  expect(rankOf(0)).toBe("Shed");
  expect(rankOf(scoreOf(small))).toBe("Shed");
  expect(rankOf(1_000_000)).toBe("Megafactory");
});

test("a link that is not a factory is turned away", () => {
  const good = [1, "t", "#000000", "#ffffff", "#ff0000", 3, [0, 0, 2, 9, 1, 0, 1, 4], [0, 1, 2]];
  expect(unpack(link(good))!.look.style).toBe("classic"); // a link from before there were styles still opens, as the one style there was
  expect(unpack(link([2, ...good.slice(1), "frame"]))!.look.style).toBe("frame");
  const broken: [why: string, payload: unknown][] = [
    ["not a list", { a: 1 }],
    ["another version", [3, ...good.slice(1), "frame"]],
    ["the newer layout with no style", [2, ...good.slice(1)]],
    ["the first layout wearing a style", [...good, "frame"]],
    ["a style that is not one", [2, ...good.slice(1), "foil"]],
    ["a colour that is not one", [...good.slice(0, 2), "red", ...good.slice(3)]],
    ["a title that is markup-length", [1, "x".repeat(500), ...good.slice(2)]],
    ["a belt to a machine that is not there", [...good.slice(0, 7), [0, 5, 2]]],
    ["a belt from a machine to itself", [...good.slice(0, 7), [1, 1, 2]]],
    ["two machines on one cell", [...good.slice(0, 6), [0, 0, 2, 9, 0, 0, 1, 4], []]],
    ["a machine off the lot", [...good.slice(0, 6), [9999, 0, 2, 9], []]],
    ["a count that is not a whole number", [...good.slice(0, 6), [0, 0, 2.5, 9], []]],
    ["a negative size", [...good.slice(0, 6), [0, 0, 2, -9], []]],
    ["more machines than any factory has", [...good.slice(0, 6), Array.from({ length: 500 }, (_, nth) => [nth % 60, Math.floor(nth / 60), 1, 1]).flat(), []]],
    ["a machine with no files", [...good.slice(0, 6), [0, 0, 0, 9], []]],
  ];
  for (const [why, payload] of broken) if (unpack(link(payload))) throw new Error(`accepted ${why}`);
  for (const junk of ["", "!!!", "e30", link("text"), link(null)]) expect(unpack(junk)).toBeUndefined();
});

test("a blueprint from a link builds a factory the painter can draw", () => {
  const scene = sceneOf(unpack(pack(blueprint, look))!.blueprint);
  expect(scene.machines.filter((machine) => machine.exists && machine.rise === 1).length).toBe(13);
  expect(scene.belts.filter((belt) => belt.wanted && belt.laid === belt.length).length).toBe(27);
  expect(scene.conveyor.boxes.length).toBeGreaterThan(0);
});
