// The conveyor's promise: boxes never touch, never lurch, every belt delivers, and nothing jams.
import { expect, test } from "bun:test";
import sample from "../src/data/sample.json";
import { conveyor, run, setRates, TICK, whereIs } from "../src/lib/conveyor";
import { plan, SLOT } from "../src/lib/plan";
import type { Scan } from "../src/lib/scan";

const TICKS = 4000; // about twenty minutes of belt time
const LOOKS = 4; // times a tick the boxes are looked at
const WIDEST_BOX = 0.4; // world units: the factory draws no box wider than this
const LONGEST_WAIT = 60; // ticks: a box held longer than this is a jam, not a queue
// A box takes a whole tick to reach belt speed or lose it, so between two looks its step changes by a LOOKS-th of a full step at most.
const FULL_STEP = SLOT / LOOKS;
const GENTLEST = FULL_STEP / LOOKS;
const ROUNDING = 1e-9;

test("boxes keep apart, move without a lurch, arrive and never jam", () => {
  const { belts, frames } = plan(sample as unknown as Scan);
  const loads = frames.at(-1)!.belts;
  const state = conveyor(belts);
  setRates(state, belts.map((_, index) => ({ wanted: loads.has(index), count: loads.get(index) ?? 0 })));
  state.lines.forEach((line, index) => (line.open = loads.has(index)));

  const delivered = new Set<number>();
  let last = new Map<number, { at: [number, number]; step?: [number, number] }>();
  let most = 0;
  for (let looks = 0; looks < TICKS * LOOKS; looks++) {
    run(state, TICK / LOOKS);
    most = Math.max(most, state.boxes.length);
    const now: typeof last = new Map();
    const seen: [number, number][] = [];
    for (const box of state.boxes) {
      expect(box.waited).toBeLessThanOrEqual(LONGEST_WAIT);
      if (box.at === state.lines[box.belt]!.keys.length - 1) delivered.add(box.belt);

      const at = whereIs(state, box);
      const before = last.get(box.id);
      const step: [number, number] | undefined = before && [at[0] - before.at[0], at[1] - before.at[1]];
      if (step && before?.step) {
        const lurch = Math.max(Math.abs(step[0] - before.step[0]), Math.abs(step[1] - before.step[1]));
        if (lurch > GENTLEST + ROUNDING) throw new Error(`box ${box.id} lurched by ${lurch} at ${at} on look ${looks}`);
      }
      now.set(box.id, { at, step });
      // A box that has not set off stands at the centre of its machine, behind the walls.
      if (box.at) seen.push(at);
    }
    last = now;
    seen.forEach(([x, y], index) => {
      for (const [otherX, otherY] of seen.slice(index + 1)) {
        if (Math.max(Math.abs(x - otherX), Math.abs(y - otherY)) < WIDEST_BOX) throw new Error(`boxes overlap at ${x},${y} and ${otherX},${otherY} on look ${looks}`);
      }
    });
  }
  expect(most).toBeGreaterThan(belts.length / 2);
  expect([...delivered].sort()).toEqual([...loads.keys()].sort());
  expect(SLOT).toBeGreaterThan(WIDEST_BOX);
});

test("a factory where every folder imports most others never gridlocks", () => {
  const FOLDERS = 20;
  const LINKED = 0.87; // share of ordered folder pairs with an import between them: about 330 belts
  const MOST_BELTS = 0.95; // share of belts that must deliver. Before boxes could be lifted off, a ring of lanes filled within 100 ticks and none did.
  for (const seed of [1, 2, 3, 4]) {
    let state32 = seed;
    const random = () => (state32 = (Math.imul(state32, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const paths = Array.from({ length: FOLDERS }, (_, folder) => `f${folder}/a.ts`);
    const set = paths.map((_, file): [number, number, number[]] => [file, 1024, paths.flatMap((_, other) => (other !== file && random() < LINKED ? [other] : []))]);
    const dense: Scan = { name: "dense", commits: 1, paths, steps: [{ hash: "", date: "", subject: "", nth: 1, set, gone: [], touched: [] }] };

    const { belts, frames } = plan(dense);
    const loads = frames[0]!.belts;
    const state = conveyor(belts);
    setRates(state, belts.map((_, index) => ({ wanted: loads.has(index), count: loads.get(index) ?? 0 })));
    state.lines.forEach((line, index) => (line.open = loads.has(index)));
    const delivered = new Set<number>();
    for (let ticks = 0; ticks < TICKS; ticks++) {
      run(state, TICK);
      for (const box of state.boxes) {
        if (box.waited > LONGEST_WAIT) throw new Error(`seed ${seed}: box ${box.id} has waited ${box.waited} ticks on tick ${ticks}, with ${state.boxes.length} boxes out`);
        if (box.at === state.lines[box.belt]!.keys.length - 1) delivered.add(box.belt);
      }
    }
    // The thinnest belts here send a box every few minutes, and a few of those boxes are lifted off as jammed.
    expect(delivered.size).toBeGreaterThan(loads.size * MOST_BELTS);
  }
});
