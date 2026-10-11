// The boxes on the belts, simulated so that no two ever touch.
//
// Every belt's route is cut into slots half a unit long, all on one lattice, so two belts that share
// a lane share its slots and two that cross share the slot where they cross. A slot holds one box.
// Once a tick, every box that can moves one slot, and three rules keep them apart:
//   1. A box moves only into a slot that was empty when the tick began, so nothing tailgates.
//   2. A box enters a slot where lanes cross or merge only if the slot after it is free too, and it
//      reserves that slot. Nothing ever stops on a crossing, so two lanes can never lock each other.
//   3. Among boxes after the same slot, the one that has waited longest goes first.
// The rules move a box a slot at a time, all at once. What is drawn rides a curve through those moves
// instead, so a box picks up speed, slows to a stop and rounds a turn over a whole tick: see whereIs().
import { SLOT, type Belt } from "./plan";

export const BELT_SPEED = 1.6; // units a second, tuned by eye. The slats under the boxes run at the same speed.
export const TICK = (SLOT / BELT_SPEED) * 1000; // ms for a box to cross one slot

// Boxes a second.
const LANE_FLOW = 1; // through the busiest slot in the factory. A lane can carry 1.6. Measured on real repos, this leaves about one box in fifteen waiting, none for much over two seconds.
const BELT_MOST = 0.7; // out of one door onto one belt
const BELT_LEAST = 0.09; // a belt with a single import still sends a box every 11 seconds or so
const WARM_TICKS = 220; // run before the first frame of a landed scene, so belts are already carrying
// ponytail: where most folders import most others, boxes can fill a ring of lanes round one gutter, each waiting on the
// next, and the rules alone never free it. A box held this long is lifted off, which breaks the ring. On real repos the
// longest wait measured is 7 ticks, so none is lifted. On random factories where every folder imports most others it
// takes 1% of boxes at 110 belts, about 4% at 330 to 550 and 13% at 1,000. Route belts so no ring can form if that shows.
const JAMMED = 40; // ticks
const SPREAD = 0.618; // the golden ratio's fraction: stepping by it spreads belts' first boxes evenly, so doors do not all fire on one tick

// A lattice point as one number.
const REACH = 1 << 14; // lattice points either side of the origin a factory may span
const keyOf = (x: number, y: number) => (Math.round(x / SLOT) + REACH) * (REACH * 2) + Math.round(y / SLOT) + REACH;

export type Box = {
  id: number;
  belt: number;
  /** Slot it is in, or moving into. */
  at: number;
  /** Slot it was in when the tick began. */
  was: number;
  /** Slot it was in a tick before that. */
  before: number;
  /** Ticks it has stood still. */
  waited: number;
  /** A slot past a crossing, reserved so this box is sure to clear the crossing next tick. */
  holds?: number;
};
type Line = {
  /** The centre of each slot, from the machine a box leaves to the one it enters. */
  slots: [number, number][];
  keys: number[];
  /** Slots where another lane crosses or merges, or where this one turns. */
  clash: boolean[];
  /** Whether the belt is laid end to end and boxes may set off. */
  open: boolean;
  /** ms between boxes, and ms until the next one. */
  every: number;
  due: number;
};
export type Conveyor = { lines: Line[]; boxes: Box[]; taken: Map<number, Box>; clock: number; made: number };

export function conveyor(belts: Belt[]): Conveyor {
  const lines: Line[] = belts.map(({ points }) => {
    const slots: [number, number][] = [points[0]!];
    for (let index = 1; index < points.length; index++) {
      const [x0, y0] = points[index - 1]!;
      const [x1, y1] = points[index]!;
      const steps = Math.round((Math.abs(x1 - x0) + Math.abs(y1 - y0)) / SLOT);
      for (let step = 1; step <= steps; step++) slots.push([x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps]);
    }
    return { slots, keys: slots.map(([x, y]) => keyOf(x, y)), clash: [], open: false, every: Infinity, due: 0 };
  });

  // A slot clashes when belts pass through it along both axes: a crossing, a merge or a corner.
  const X = 1;
  const Y = 2;
  const axes = new Map<number, number>();
  for (const { slots, keys } of lines) {
    for (let index = 1; index < slots.length; index++) {
      const axis = slots[index]![1] === slots[index - 1]![1] ? X : Y;
      for (const key of [keys[index - 1]!, keys[index]!]) axes.set(key, (axes.get(key) ?? 0) | axis);
    }
  }
  for (const line of lines) line.clash = line.keys.map((key) => axes.get(key) === (X | Y));
  return { lines, boxes: [], taken: new Map(), clock: 0, made: 0 };
}

/** Sets how often each belt sends a box: in proportion to its imports, with no slot in the factory asked to carry more than LANE_FLOW. */
export function setRates(state: Conveyor, belts: { wanted: boolean; count: number }[]) {
  const busiest = (rates: number[]) => {
    const load = new Map<number, number>();
    rates.forEach((rate, index) => {
      if (rate) for (const key of state.lines[index]!.keys) load.set(key, (load.get(key) ?? 0) + rate);
    });
    return Math.max(0, ...load.values());
  };
  // First in proportion to imports, then every belt held between its least and most,
  // then all of them eased off together if that asks too much of the busiest slot.
  const perImport = LANE_FLOW / (busiest(belts.map(({ wanted, count }) => (wanted ? count : 0))) || 1);
  const rates = belts.map(({ wanted, count }) => (wanted ? Math.min(BELT_MOST, Math.max(BELT_LEAST, count * perImport)) : 0));
  const ease = Math.min(1, LANE_FLOW / (busiest(rates) || 1));
  rates.forEach((rate, index) => {
    const line = state.lines[index]!;
    line.every = rate ? 1000 / (rate * ease) : Infinity;
    line.due = Math.min(line.due, line.every);
  });
}

function tick(state: Conveyor) {
  const { lines, taken } = state;
  clear(state, (box) => box.waited > JAMMED);
  // A box that has reached the machine it was going to is taken in. The last slot is inside that machine and holds nothing.
  state.boxes = state.boxes.filter((box) => box.at < lines[box.belt]!.keys.length - 1);
  for (const box of state.boxes) {
    box.before = box.was;
    box.was = box.at;
  }

  // Boxes on a crossing go first, into the slot they reserved. Then the longest waiting, then the furthest along.
  const order = [...state.boxes].sort((p, q) => Number(q.holds !== undefined) - Number(p.holds !== undefined) || q.waited - p.waited || q.at - p.at);
  const left: [number, Box][] = [];
  for (const box of order) {
    const { keys, clash } = lines[box.belt]!;
    const end = keys.length - 1;
    const next = box.at + 1;
    let free = box.holds !== undefined || next === end || !taken.has(keys[next]!);
    box.holds = undefined;
    if (free && clash[next] && next + 1 < end) {
      free = !taken.has(keys[next + 1]!);
      if (free) {
        box.holds = keys[next + 1]!;
        taken.set(box.holds, box);
      }
    }
    if (!free) {
      box.waited += 1;
      continue;
    }
    left.push([keys[box.at]!, box]);
    if (next < end) taken.set(keys[next]!, box);
    box.at = next;
    box.waited = 0;
  }
  // New boxes set off from inside their machine, the most overdue belt first.
  for (const line of lines) line.due -= TICK;
  for (const [index, line] of [...lines.entries()].sort((p, q) => p[1].due - q[1].due)) {
    if (!line.open || line.due > 0 || taken.has(line.keys[0]!)) continue;
    const box: Box = { id: state.made++, belt: index, at: 0, was: 0, before: 0, waited: 0 };
    state.boxes.push(box);
    taken.set(line.keys[0]!, box);
    line.due = line.every;
  }

  // Slots are given up only now, after every box has moved or set off, which is what makes rule 1 hold.
  for (const [key, box] of left) if (taken.get(key) === box) taken.delete(key);
}

/** Runs the belts for dt ms. */
export function run(state: Conveyor, dt: number) {
  state.clock += dt;
  for (; state.clock >= TICK; state.clock -= TICK) tick(state);
}

/** Empties the belts and runs them unseen, so a scene that lands finished is already carrying boxes. */
export function warm(state: Conveyor) {
  clear(state, () => true);
  state.lines.forEach((line, index) => (line.due = Number.isFinite(line.every) ? line.every * ((index * SPREAD) % 1) : 0));
  for (let ticks = 0; ticks < WARM_TICKS; ticks++) tick(state);
  state.clock = 0;
}

/** Takes away every box `gone` picks: the ones on a belt that is being pulled up, past where it now ends. */
export function clear(state: Conveyor, gone: (box: Box) => boolean) {
  const kept = state.boxes.filter((box) => !gone(box));
  if (kept.length === state.boxes.length) return;
  const stays = new Set(kept);
  for (const [key, holder] of state.taken) if (!stays.has(holder)) state.taken.delete(key);
  state.boxes = kept;
}

/**
 * Where a box is drawn right now: the average of where the rules had it over the last tick. That is a
 * curve through the middle of each move, so its speed changes over a whole tick and never at once, and
 * it cuts a turn by a sixteenth of a unit. Every box is averaged alike, so boxes on one lane keep their
 * full slot apart. Where lanes cross the least is 0.4375 between centres, still wider than any box.
 */
export function whereIs(state: Conveyor, box: Box): [number, number] {
  const { slots } = state.lines[box.belt]!;
  const share = state.clock / TICK;
  const along = (axis: 0 | 1) => {
    const [before, was, at] = [slots[box.before]![axis], slots[box.was]![axis], slots[box.at]![axis]];
    // The last (1 - share) of the move before, then the first share of this one.
    return (1 - share) * (before + ((was - before) * (1 + share)) / 2) + share * (was + ((at - was) * share) / 2);
  };
  return [along(0), along(1)];
}
