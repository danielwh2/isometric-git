// The layout's promise: every machine has its own cell and no belt runs through a machine it does not serve.
import { expect, test } from "bun:test";
import sample from "../src/data/sample.json";
import { BELT, plan } from "../src/lib/plan";
import type { Scan } from "../src/lib/scan";

test("belts keep to the gutters", () => {
  const { machines, belts, frames } = plan(sample as unknown as Scan);
  expect(new Set(machines.map((machine) => `${machine.col},${machine.row}`)).size).toBe(machines.length);
  expect(belts.length).toBeGreaterThan(0);

  // Clearance is checked against the largest each machine ever gets.
  const largest = machines.map((machine) => ({
    a: Math.max(...frames.map((frame) => frame.sizes[machine.id]!.a)) + BELT / 2,
    b: Math.max(...frames.map((frame) => frame.sizes[machine.id]!.b)) + BELT / 2,
  }));
  for (const belt of belts) {
    belt.points.forEach(([x, y], index) => {
      if (!index) return;
      const [px, py] = belt.points[index - 1]!;
      expect(x === px || y === py).toBe(true);
      for (const machine of machines) {
        const own = (index === 1 && machine.id === belt.from) || (index === belt.points.length - 1 && machine.id === belt.to);
        if (own) continue;
        const { a, b } = largest[machine.id]!;
        const clear = Math.max(px, x) < machine.x - a || Math.min(px, x) > machine.x + a || Math.max(py, y) < machine.y - b || Math.min(py, y) > machine.y + b;
        if (!clear) throw new Error(`${machines[belt.from]!.name} > ${machines[belt.to]!.name} runs through ${machine.name}`);
      }
    });
  }
});

test("a path that never held a file does not stall the layout", () => {
  // A partial clone names files whose contents it does not hold: they are touched and then gone, never set.
  const folders = ["a", "b", "c", "d"];
  const paths = [...folders.map((folder) => `${folder}/x.ts`), "ghost/deep/y.ts"];
  const set = folders.map((_, file): [number, number, number[]] => [file, 1024, []]);
  const scan: Scan = { name: "partial", commits: 1, paths, steps: [{ hash: "", date: "", subject: "", nth: 1, set, gone: [], touched: [4] }] };
  expect(plan(scan).machines.filter((machine) => folders.includes(machine.name)).length).toBe(4);
});
