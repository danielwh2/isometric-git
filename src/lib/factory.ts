// The factory itself: what every machine, belt and box is doing right now, and one frame of it on a canvas.
// Nothing here touches the DOM, so tests and still renders can run it.
import { BELT_SPEED, clear, conveyor, run, setRates, warm, whereIs, type Box, type Conveyor } from "./conveyor";
import { BELT, CELL, RIM, SLOT, runLength, type Frame, type Plan, type Size } from "./plan";

// World units.
const PAD = 0.18; // foundation showing around a machine. The widest machine plus this stops just short of the nearest belt.
const DOOR = 0.7; // height of the door belts leave by
const DOOR_JAMB = 0.1; // door wider than the belt by this each side
const AWNING = 0.2; // how far the canopy over a door stands out
const AWNING_DROP = 0.07;
const SHUTTER_REST = 0.12; // share of the doorway a shut shutter leaves open: a slit over the belt
const SHUTTER_RIB = 0.1; // between the ribs of a roller shutter
const DOOR_LEAD = 0.85; // a box this far inside calls its door up: what it covers while the door rises, and a little over
const STOREY = 0.8; // height of one floor, near enough: floors divide the wall evenly
const STACK = 0.6; // chimney above the roof
const STACK_WIDE = 0.2;
const STACK_IN = 0.05; // chimney's distance from the roof's back corner; it stands on the rim, clear of the hatches
const MAST = 0.9;
const PENNANT = 0.34;
const HATCH_GAP = 0.24; // share of a hatch's pitch left between hatches
const SLAT_GAP = 0.25; // two slats to a slot
const SLAT_REACH = 0.8; // share of the belt's width a slat spans
const PLATE = 0.13; // half the inner square of a transfer plate
// Boxes. Half a side and a height each; none is wider than 0.4, so a box in every slot still leaves a gap.
const SHAPES = [{ half: 0.19, tall: 0.34 }, { half: 0.2, tall: 0.22 }, { half: 0.16, tall: 0.4 }, { half: 0.18, tall: 0.28 }];
const CARDS = 3; // kinds of cardboard in the palette
const TAPE = 0.3; // half the tape's width, as a share of half the box
const TAPE_DROP = 0.45; // share of a wall the tape runs down
const LABEL_WIDE = 0.5; // half the label's width, as a share of half the box
const LABEL_LOW = 0.22; // the label's bottom and top, as shares of the box's height
const LABEL_HIGH = 0.6;
// A merge's delivery: crates of one size, so they stack, set down in front of the wall that faces the aisle.
const CRATE = { half: 0.19, tall: 0.3 };
const CRATE_STEP = 0.46; // between one stack and the next along the wall
const CRATE_HIGH = 2; // crates to a stack
const PALLET = 0.06; // a stack's pallet shows this far round it, which tells a delivery from a box that fell off a belt
const CRATES_MOST = 6; // beside one machine. A branch that changed more files there still sends six.
const CRATE_DROP = 0.5; // a crate comes down through this much as it is set down
const CRATE_CLEAR = 2.2; // a stack's far edge stays this close to the machine's centre: the aisle's belt starts at 2.25
const HAZARD = [[0.2, 0.6], [1, 1.4], [1.8, 2]] as const; // the stripes on a contested hatch, as bands of u + v across it
const PUFF_RISE = 1.3;
const PUFF_GROW = 0.22;
const PUFF_START = 0.07;

// Ink strengths, as steps of Anneal's ramp.
const DIM = 0.3; // what is not in use, and ground marks
const SIDE = 0.06; // walls and belt beds, a shade off the ground
const DOORWAY = 0.16;
const FAINT = 0.4; // struts and slats, under the lines that carry meaning

// Construction, in ms at 1x. A machine goes up as pad, frame, walls, then roof and fittings.
const RISE = 1100; // rare enough to watch: a folder appears a handful of times in a replay
const FALL = RISE / 1.25; // leaves the way it came, a fifth faster
const PAD_DONE = 0.15; // shares of RISE at which each stage ends
const FRAME_DONE = 0.4;
const WALLS_DONE = 0.8;
const STAGGER = 110; // ms between machines that arrive in one step
const STAGGER_ALL = 1400; // the whole wave takes no longer than this
const LAY = 0.03; // units of belt laid per ms, so a 20 unit belt takes about 0.7s
const HATCH_PACE = 0.03; // hatches fitted per ms at the least
const HATCH_SETTLE = 250; // ms: a big batch fits faster so no roof takes much longer than this
const MAX_PUFFS = 3;
const PUFF_EVERY = 240; // ms between puffs
const PUFF_LIFE = 1100;
const CRATE_EVERY = 110; // ms between one crate set down and the next

const SIZE_STIFF = 14; // spring rate for a machine changing size: settles in about 0.4s, no overshoot
// A roller shutter runs at a steady rate, eased at each end of its travel, and comes down slower than it goes up.
const DOOR_UP = 420; // ms
const DOOR_DOWN = 640;
const DOOR_HOLD = 1200; // ms a door stays up after its last box, so a busy door stays open instead of flapping
const HOVER = 40; // ms time constant for ink. Hover is seen constantly, so it is over in about 120ms.

// Level of detail, in px. Below these a detail is noise, so it is left out.
const HATCH_MIN = 3;
const HAZARD_MIN = 6; // across a hatch before its stripes are drawn. Below it the hatch is the one flat colour.
const SLAT_MIN = 3; // between slats, and across a transfer plate's inner square
const BOX_DETAIL_MIN = 7; // across a box before its tape and label are drawn
const STRUT_MIN = 9; // between wall struts
const DOT = 1.5;

const GONE = 0.001;
const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
const GROUND_WIDTH = Math.sin(Math.PI / 3); // a strip on the ground keeps this much of its width on screen

export type View = { k: number; ox: number; oy: number };
export type Shade = (strength: number) => string;
export type Palette = {
  /** The ground mixed `strength` of the way to ink. */
  shade: Shade;
  /** Each kind of cardboard as four flat tones: top, left wall, right wall, edge. */
  kraft: [top: string, left: string, right: string, edge: string][];
  tape: string;
  /** One colour to a machine, on its awning and on the label of every box it sends. */
  labels: string[];
  /** The tape on a hatch whose file both branches changed. */
  hazard: string;
};
export type Spring = { at: number; speed: number };
type Point = [x: number, y: number, z?: number];

export type MachineState = {
  id: number;
  name: string;
  x: number;
  y: number;
  /** What it is built to. A machine being taken down keeps the size it had. */
  size: Size;
  exists: boolean;
  feeds: boolean;
  /** Takes imports and feeds nothing: the end of a line. */
  ships: boolean;
  a: Spring;
  b: Spring;
  h: Spring;
  /** 0 is bare ground, 1 is finished. */
  rise: number;
  /** ms of construction time before this one starts, so a wave of arrivals goes up in turn. */
  wait: number;
  hatches: number;
  ink: number;
  inkGoal: number;
  /** How far up its door's shutter has run: 0 is shut, 1 is right up. */
  door: number;
  /** ms the door stays up for yet. */
  doorHeld: number;
  /** Ages of the puffs in the air, in ms. */
  puffs: number[];
  owed: number;
  sincePuff: number;
  /** Crates a merge sets down beside it at this step. */
  crates: number;
  /** How many are standing now: the last one counts in part while it comes down. */
  stock: number;
  /** Roof hatches whose files both branches of this step's merge had changed. */
  contested: number[];
};
export type BeltState = {
  from: number;
  to: number;
  points: [number, number][];
  length: number;
  /** Slots from the sending machine's centre to the first turn: a box that was this early a tick ago may still be inside. */
  stub: number;
  /** Where the belt turns, and how far along it each turn is. */
  corners: [x: number, y: number, distance: number][];
  wanted: boolean;
  count: number;
  laid: number;
  ink: number;
  inkGoal: number;
};
export type Scene = { machines: MachineState[]; belts: BeltState[]; conveyor: Conveyor; order: MachineState[]; dots: [number, number][]; /** Seconds the belts have run. */ flow: number; /** The hatch under the pointer. */ hot?: { machine: number; hatch: number } };

export const screen = (view: View, x: number, y: number, z = 0): [number, number] => [view.ox + view.k * (x - y) * COS, view.oy + view.k * ((x + y) * SIN - z)];
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const stage = (rise: number, from: number, to: number) => 1 - (1 - clamp((rise - from) / (to - from))) ** 3; // ease out within a stage
const toward = (now: number, goal: number, dt: number, tau: number) => goal + (now - goal) * Math.exp(-dt / tau);

// A critically damped spring, stepped exactly: no overshoot, and it picks up from whatever speed it has.
export function spring(state: Spring, goal: number, dt: number, stiff: number) {
  const seconds = dt / 1000;
  const decay = Math.exp(-stiff * seconds);
  const offset = state.at - goal;
  const pull = (state.speed + stiff * offset) * seconds;
  state.at = goal + (offset + pull) * decay;
  state.speed = (state.speed - stiff * pull) * decay;
}

export function build(plan: Plan): Scene {
  const still = (): Spring => ({ at: 0, speed: 0 });
  const machines: MachineState[] = plan.machines.map(({ id, name, x, y }) => ({
    id, name, x, y,
    size: plan.frames[0]!.sizes[id]!,
    exists: false, feeds: false, ships: false,
    a: still(), b: still(), h: still(), door: 0, doorHeld: 0,
    rise: 0, wait: 0, hatches: 0, ink: 1, inkGoal: 1, puffs: [], owed: 0, sincePuff: 0, crates: 0, stock: 0, contested: [],
  }));
  const belts: BeltState[] = plan.belts.map((belt) => {
    let distance = 0;
    const corners = belt.points.slice(1, -1).map(([x, y], index): [number, number, number] => [x, y, (distance += runLength(belt.points[index]!, [x, y]))]);
    return { ...belt, stub: runLength(belt.points[0]!, belt.points[1]!) / SLOT, corners, wanted: false, count: 0, laid: 0, ink: 1, inkGoal: 1 };
  });
  const cols = plan.machines.map((machine) => machine.x);
  const rows = plan.machines.map((machine) => machine.y);
  const dots: [number, number][] = [];
  for (let x = Math.min(...cols) - CELL / 2; x <= Math.max(...cols) + CELL / 2; x += CELL) {
    for (let y = Math.min(...rows) - CELL / 2; y <= Math.max(...rows) + CELL / 2; y += CELL) dots.push([x, y]);
  }
  return { machines, belts, conveyor: conveyor(plan.belts), order: [...machines].sort((p, q) => p.x + p.y - q.x - q.y), dots, flow: 0 };
}

/** Points the scene at one step. advance() then builds its way there, or `jump` lands it at once. */
export function aim(scene: Scene, frame: Frame, jump: boolean) {
  const arriving: MachineState[] = [];
  for (const machine of scene.machines) {
    const size = frame.sizes[machine.id]!;
    const existed = machine.exists;
    machine.exists = size.files > 0;
    machine.feeds = false;
    machine.ships = false;
    machine.crates = machine.exists ? Math.min(CRATES_MOST, frame.delivered.get(machine.id) ?? 0) : 0;
    machine.contested = frame.contested.get(machine.id) ?? [];
    if (!machine.exists) continue;
    machine.size = size;
    if (existed || machine.rise > 0) continue; // already standing, or caught mid-fall: it carries on from where it is
    for (const side of ["a", "b", "h"] as const) machine[side] = { at: size[side], speed: 0 };
    arriving.push(machine);
  }
  for (const belt of scene.belts) belt.wanted = false;
  for (const [index, count] of frame.belts) {
    const belt = scene.belts[index]!;
    Object.assign(belt, { wanted: true, count });
    scene.machines[belt.from]!.feeds = true;
    scene.machines[belt.to]!.ships = true;
  }
  for (const machine of scene.machines) machine.ships &&= !machine.feeds;
  setRates(scene.conveyor, scene.belts);

  if (jump) return land(scene);
  // A wave of new machines goes up back to front, a beat apart.
  const beat = Math.min(STAGGER, STAGGER_ALL / arriving.length);
  arriving.sort((p, q) => p.x + p.y - q.x - q.y).forEach((machine, index) => (machine.wait = index * beat));
  for (const [id, files] of frame.touched) scene.machines[id]!.owed = Math.min(MAX_PUFFS, files);
}

function land(scene: Scene) {
  for (const machine of scene.machines) {
    Object.assign(machine, { rise: machine.exists ? 1 : 0, wait: 0, hatches: machine.exists ? machine.size.files : 0, ink: machine.inkGoal, puffs: [], owed: 0, stock: machine.crates });
    for (const side of ["a", "b", "h"] as const) machine[side] = { at: machine.size[side], speed: 0 };
  }
  scene.belts.forEach((belt, index) => {
    Object.assign(belt, { laid: belt.wanted ? belt.length : 0, ink: belt.inkGoal });
    scene.conveyor.lines[index]!.open = belt.wanted;
  });
  warm(scene.conveyor);
  // A scene that lands with a box in a doorway lands with that door up.
  for (const machine of scene.machines) Object.assign(machine, { door: 0, doorHeld: 0 });
  doors(scene, DOOR_UP);
}

/** ms of construction a step needs before the next one should start. */
export function settleTime(scene: Scene): number {
  const waits = scene.machines.filter((machine) => machine.exists).map((machine) => (machine.rise < 1 ? machine.wait + RISE * (1 - machine.rise) : 0) + Math.max(0, machine.crates - machine.stock) * CRATE_EVERY);
  return Math.max(0, ...waits);
}

/** The picked machine, what it takes from and what it feeds keep full ink. The rest dims. */
export function light(scene: Scene, picked: number | undefined) {
  const near = new Set([picked]);
  for (const belt of scene.belts) {
    const serves = belt.wanted && (belt.from === picked || belt.to === picked);
    belt.inkGoal = picked === undefined || serves ? 1 : DIM;
    if (serves) near.add(belt.from).add(belt.to);
  }
  for (const machine of scene.machines) machine.inkGoal = picked === undefined || near.has(machine.id) ? 1 : DIM;
}

/** Moves everything by dt ms. `pace` speeds construction up or down; belts always run at one speed, and stand still unless `flowing`. */
export function advance(scene: Scene, dt: number, pace: number, flowing: boolean) {
  const built = dt * pace;
  if (flowing) scene.flow += dt / 1000;
  for (const machine of scene.machines) {
    if (!machine.exists) machine.rise = Math.max(0, machine.rise - built / FALL);
    else if (machine.wait > 0) machine.wait -= built;
    else machine.rise = Math.min(1, machine.rise + built / RISE);

    for (const side of ["a", "b", "h"] as const) spring(machine[side], machine.size[side], dt, SIZE_STIFF);
    const fitted = machine.exists && machine.rise >= WALLS_DONE ? machine.size.files : 0;
    const gap = fitted - machine.hatches;
    const step = Math.max(HATCH_PACE, Math.abs(gap) / HATCH_SETTLE) * built;
    machine.hatches = Math.abs(gap) <= step ? fitted : machine.hatches + Math.sign(gap) * step;
    machine.ink = toward(machine.ink, machine.inkGoal, dt, HOVER);

    // A delivery waits for the machine to be finished, and is taken in at the pace it was set down.
    const due = machine.rise === 1 ? machine.crates : 0;
    const carried = built / CRATE_EVERY;
    machine.stock = Math.abs(due - machine.stock) <= carried ? due : machine.stock + Math.sign(due - machine.stock) * carried;

    machine.puffs = machine.puffs.map((age) => age + dt).filter((age) => age < PUFF_LIFE);
    machine.sincePuff += dt;
    if (machine.owed && machine.rise === 1 && machine.sincePuff >= PUFF_EVERY) {
      machine.puffs.push(0);
      machine.owed -= 1;
      machine.sincePuff = 0;
    }
  }

  scene.belts.forEach((belt, index) => {
    const from = scene.machines[belt.from]!;
    const to = scene.machines[belt.to]!;
    // A belt is laid once its source has a door and its target has walls to run under.
    const ready = from.rise >= WALLS_DONE && to.rise >= FRAME_DONE;
    if (!belt.wanted) belt.laid = Math.max(0, belt.laid - LAY * 1.25 * built);
    else if (ready) belt.laid = Math.min(belt.length, belt.laid + LAY * built);
    belt.ink = toward(belt.ink, belt.inkGoal, dt, HOVER);
    // Boxes set off only on a belt that reaches all the way.
    scene.conveyor.lines[index]!.open = belt.wanted && belt.laid >= belt.length;
  });
  // A belt being pulled up loses the boxes past where it now ends.
  clear(scene.conveyor, (box) => !scene.belts[box.belt]!.wanted && box.at * SLOT > scene.belts[box.belt]!.laid);
  if (flowing) run(scene.conveyor, dt);

  doors(scene, dt);
}

// A door is called up by a box on its way out, from DOOR_LEAD inside until its tail is through.
function doors(scene: Scene, dt: number) {
  const called = new Set<number>();
  for (const box of scene.conveyor.boxes) {
    const belt = scene.belts[box.belt]!;
    if (box.before > belt.stub) continue;
    const sender = scene.machines[belt.from]!;
    const past = whereIs(scene.conveyor, box)[0] - sender.x - sender.a.at;
    const { half } = lookOf(box.id);
    if (past + half > -DOOR_LEAD && past - half < 0) called.add(belt.from);
  }
  for (const machine of scene.machines) {
    machine.doorHeld = called.has(machine.id) ? DOOR_HOLD : Math.max(0, machine.doorHeld - dt);
    machine.door = machine.doorHeld ? Math.min(1, machine.door + dt / DOOR_UP) : Math.max(0, machine.door - dt / DOOR_DOWN);
  }
}

/** Scale and offset that frame what the scene is aimed at: its machines and the belts between them. */
export function fit(scene: Scene, width: number, height: number, pad: { left: number; right: number; top: number; bottom: number }, closest: number): View | undefined {
  const xs: number[] = [];
  const ys: number[] = [];
  const reach = (x: number, y: number, z = 0) => {
    xs.push((x - y) * COS);
    ys.push((x + y) * SIN - z);
  };
  for (const { x, y, exists, size: { a, b, h } } of scene.machines) {
    if (!exists) continue;
    for (const [dx, dy] of [[-a, -b], [a, -b], [a, b], [-a, b]] as const) reach(x + dx, y + dy, dx + dy < 0 ? h + STACK : 0);
  }
  for (const belt of scene.belts) if (belt.wanted) for (const [x, y] of belt.points) reach(x, y);
  if (!xs.length) return undefined;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const wide = Math.max(...xs) - left;
  const tall = Math.max(...ys) - top;
  const room = { wide: width - pad.left - pad.right, tall: height - pad.top - pad.bottom };
  const k = Math.min(room.wide / wide, room.tall / tall, closest);
  return { k, ox: pad.left + (room.wide - k * wide) / 2 - k * left, oy: pad.top + (room.tall - k * tall) / 2 - k * top };
}

/** Where a machine's tag hangs: over the top of its chimney. */
export const tagPoint = (view: View, machine: MachineState) => screen(view, machine.x - machine.a.at, machine.y - machine.b.at, machine.h.at + STACK);

function inside(polygon: [number, number][], px: number, py: number): boolean {
  let hit = false;
  polygon.forEach(([x0, y0], index) => {
    const [x1, y1] = polygon.at(index - 1)!;
    if (y0 > py !== y1 > py && px < x0 + ((py - y0) * (x1 - x0)) / (y1 - y0)) hit = !hit;
  });
  return hit;
}

/** The machine drawn under a point, front most first. */
export function machineAt(scene: Scene, view: View, px: number, py: number): number | undefined {
  return scene.order.findLast((machine) => {
    if (!machine.exists) return false;
    const { x, y } = machine;
    const [a, b, h] = [machine.a.at, machine.b.at, machine.h.at];
    const corners: Point[] = [[x - a, y - b, h], [x + a, y - b, h], [x + a, y - b, 0], [x + a, y + b, 0], [x - a, y + b, 0], [x - a, y + b, h]];
    return inside(corners.map((corner) => screen(view, ...corner)), px, py);
  })?.id;
}

/** Which of a machine's roof hatches a point is over. */
export function hatchAt(machine: MachineState, view: View, px: number, py: number): number | undefined {
  // Undo the projection on the roof's plane.
  const across = (px - view.ox) / view.k / COS;
  const down = ((py - view.oy) / view.k + machine.h.at) / SIN;
  const { across: columns, pitch, files } = machine.size;
  const col = Math.floor(((down + across) / 2 - (machine.x - machine.a.at + RIM)) / pitch);
  const row = Math.floor(((down - across) / 2 - (machine.y - machine.b.at + RIM)) / pitch);
  const hatch = row * columns + col;
  return col >= 0 && col < columns && row >= 0 && hatch < files ? hatch : undefined;
}

/** The start of a belt's route, `distance` long. */
function laidPoints(points: [number, number][], distance: number): [number, number][] {
  const out: [number, number][] = [points[0]!];
  for (let index = 1; index < points.length && distance > 0; index++) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const run = runLength(start, end);
    const share = run ? Math.min(1, distance / run) : 1;
    out.push([start[0] + (end[0] - start[0]) * share, start[1] + (end[1] - start[1]) * share]);
    distance -= run;
  }
  return out;
}

type Pen = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "closePath" | "fill" | "stroke" | "arc" | "fillRect" | "globalAlpha" | "lineWidth" | "lineJoin" | "fillStyle" | "strokeStyle">;

/** What a box looks like, fixed by its number so it never changes on the way. */
function lookOf(id: number) {
  const seed = Math.imul(id + 1, 0x9e3779b1) >>> 0; // a cheap scramble, so neighbouring boxes differ
  return { ...SHAPES[seed % SHAPES.length]!, card: (seed >>> 8) % CARDS, tapeAlongX: ((seed >>> 16) & 1) === 0 };
}

/** One frame. */
export function paint(ctx: Pen, scene: Scene, view: View, palette: Palette) {
  const { shade } = palette;
  const { k } = view;
  const trace = (points: Point[], close = false) => {
    points.forEach((point, index) => {
      const [px, py] = screen(view, ...point);
      if (index) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    if (close) ctx.closePath();
  };
  const face = (points: Point[], fill: string | undefined, line?: string) => {
    ctx.beginPath();
    trace(points, true);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (!line) return;
    ctx.strokeStyle = line;
    ctx.stroke();
  };
  const lines = (segments: Point[][], line: string) => {
    ctx.beginPath();
    for (const segment of segments) trace(segment);
    ctx.strokeStyle = line;
    ctx.stroke();
  };
  const square = (x: number, y: number, half: number, z = 0): Point[] => [[x - half, y - half, z], [x + half, y - half, z], [x + half, y + half, z], [x - half, y + half, z]];

  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";

  // Ground: a dot where gutters cross, and a foundation under each machine.
  ctx.fillStyle = shade(DIM);
  for (const [x, y] of scene.dots) {
    const [px, py] = screen(view, x, y);
    ctx.fillRect(px - DOT / 2, py - DOT / 2, DOT, DOT);
  }
  for (const machine of scene.machines) {
    const spread = stage(machine.rise, 0, PAD_DONE);
    if (spread < GONE) continue;
    const a = (machine.a.at + PAD) * spread;
    const b = (machine.b.at + PAD) * spread;
    face([[machine.x - a, machine.y - b], [machine.x + a, machine.y - b], [machine.x + a, machine.y + b], [machine.x - a, machine.y + b]], undefined, shade(machine.ink));
  }

  // Belts: every casing, then every bed, so belts sharing a lane read as one. Belts in use go over the rest.
  const laid = scene.belts.filter((belt) => belt.laid > GONE).map((belt) => ({ belt, points: laidPoints(belt.points, belt.laid) }));
  const bed = BELT * GROUND_WIDTH * k;
  for (const inUse of [false, true]) {
    const group = laid.filter(({ belt }) => (belt.inkGoal === 1) === inUse);
    ctx.lineJoin = "miter";
    for (const casing of [true, false]) {
      for (const { belt, points } of group) {
        ctx.lineWidth = casing ? bed + 2 : bed; // a hairline each side
        ctx.beginPath();
        trace(points);
        ctx.strokeStyle = shade(casing ? belt.ink : SIDE);
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";

    // Slats sit at fixed spots along each lane and travel at the boxes' speed, so a box never slides
    // on its belt and two belts sharing a lane show one set of slats.
    if (SLAT_GAP * k >= SLAT_MIN) {
      const reach = (BELT / 2) * SLAT_REACH;
      const shift = scene.flow * BELT_SPEED;
      for (const { belt, points } of group) {
        const slats: Point[][] = [];
        for (let index = 1; index < points.length; index++) {
          const [x0, y0] = points[index - 1]!;
          const [x1, y1] = points[index]!;
          const alongX = y0 === y1;
          const heading = Math.sign(alongX ? x1 - x0 : y1 - y0);
          const from = heading * (alongX ? x0 : y0);
          const to = heading * (alongX ? x1 : y1);
          for (let at = shift + Math.ceil((from - shift) / SLAT_GAP) * SLAT_GAP; at < to; at += SLAT_GAP) {
            slats.push(alongX ? [[heading * at, y0 - reach], [heading * at, y0 + reach]] : [[x0 - reach, heading * at], [x0 + reach, heading * at]]);
          }
        }
        lines(slats, shade(belt.ink * FAINT));
      }
    }

    // A plate wherever a belt turns: the box is carried across it sideways, without rotating.
    const plated = new Set<string>();
    for (const { belt } of group) {
      for (const [x, y, distance] of belt.corners) {
        if (distance > belt.laid || plated.has(`${x},${y}`)) continue;
        plated.add(`${x},${y}`);
        face(square(x, y, BELT / 2), shade(SIDE), shade(belt.ink));
        if (PLATE * k >= SLAT_MIN) face(square(x, y, PLATE), undefined, shade(belt.ink * FAINT));
      }
    }
  }

  /** A cardboard box as its three faces that show, standing on `low`. */
  const cardboard = (left: number, right: number, back: number, front: number, low: number, high: number, card: number) => {
    const [top, leftWall, rightWall, edge] = palette.kraft[card]!;
    face([[left, front, low], [right, front, low], [right, front, high], [left, front, high]], leftWall, edge);
    face([[right, back, low], [right, front, low], [right, front, high], [right, back, high]], rightWall, edge);
    face([[left, back, high], [right, back, high], [right, front, high], [left, front, high]], top, edge);
  };

  const carton = (box: Box, x: number, y: number) => {
    const belt = scene.belts[box.belt]!;
    const sender = scene.machines[belt.from]!;
    const { half, tall, card, tapeAlongX } = lookOf(box.id);
    let left = x - half;
    const right = x + half;
    const back = y - half;
    const front = y + half;
    if (box.before <= belt.stub) {
      // Still coming out of its machine: only the part past the door shows.
      const door = sender.x + sender.a.at;
      if (right <= door) return;
      left = Math.max(left, door);
    }
    ctx.globalAlpha = belt.ink;
    cardboard(left, right, back, front, 0, tall, card);
    if (2 * half * GROUND_WIDTH * k < BOX_DETAIL_MIN) return;

    // Tape runs over the top and a little way down the wall it meets. The label goes on the other wall,
    // in the sender's colour, so a box can be traced back to the door it left by.
    const band = half * TAPE;
    const label = palette.labels[belt.from % palette.labels.length]!;
    const [low, high] = [tall * LABEL_LOW, tall * LABEL_HIGH];
    if (tapeAlongX) {
      face([[left, y - band, tall], [right, y - band, tall], [right, y + band, tall], [left, y + band, tall]], palette.tape);
      face([[right, y - band, tall], [right, y + band, tall], [right, y + band, tall * (1 - TAPE_DROP)], [right, y - band, tall * (1 - TAPE_DROP)]], palette.tape);
      if (x - half * LABEL_WIDE >= left) face([[x - half * LABEL_WIDE, front, low], [x + half * LABEL_WIDE, front, low], [x + half * LABEL_WIDE, front, high], [x - half * LABEL_WIDE, front, high]], label);
    } else {
      const from = Math.max(left, x - band);
      if (x + band > from) {
        face([[from, back, tall], [x + band, back, tall], [x + band, front, tall], [from, front, tall]], palette.tape);
        face([[from, front, tall], [x + band, front, tall], [x + band, front, tall * (1 - TAPE_DROP)], [from, front, tall * (1 - TAPE_DROP)]], palette.tape);
      }
      face([[right, y - half * LABEL_WIDE, low], [right, y + half * LABEL_WIDE, low], [right, y + half * LABEL_WIDE, high], [right, y - half * LABEL_WIDE, high]], label);
    }
  };

  // What a merge brought in for a machine: stacks of crates along the wall that faces the aisle, from its left corner.
  // They carry no label, because no machine sent them.
  const delivery = (machine: MachineState) => {
    if (machine.stock < GONE) return;
    const { half, tall } = CRATE;
    const stacks = Math.max(1, Math.floor((2 * machine.a.at) / CRATE_STEP)); // a narrow machine has room for fewer
    const y = Math.min(machine.y + machine.b.at + PAD + half, machine.y + CRATE_CLEAR - half);
    for (let nth = 0; nth < Math.min(Math.ceil(machine.stock), stacks * CRATE_HIGH); nth++) {
      const down = clamp(machine.stock - nth); // 1 once it stands
      const x = machine.x - machine.a.at + half + Math.floor(nth / CRATE_HIGH) * CRATE_STEP;
      const low = (nth % CRATE_HIGH) * tall + (1 - down) ** 2 * CRATE_DROP;
      ctx.globalAlpha = machine.ink * down;
      if (nth % CRATE_HIGH === 0) face(square(x, y, half + PALLET), shade(SIDE), shade(1));
      cardboard(x - half, x + half, y - half, y + half, low, low + tall, (machine.id + nth) % CARDS);
      if (2 * half * GROUND_WIDTH * k < BOX_DETAIL_MIN) continue;
      const band = half * TAPE;
      face([[x - half, y - band, low + tall], [x + half, y - band, low + tall], [x + half, y + band, low + tall], [x - half, y + band, low + tall]], palette.tape);
      face([[x + half, y - band, low + tall], [x + half, y + band, low + tall], [x + half, y + band, low + tall * (1 - TAPE_DROP)], [x + half, y - band, low + tall * (1 - TAPE_DROP)]], palette.tape);
    }
    ctx.globalAlpha = 1;
  };

  const building = (machine: MachineState) => {
    const { rise, size } = machine;
    if (rise <= PAD_DONE) return;
    const [a, b, h] = [machine.a.at, machine.b.at, machine.h.at];
    const line = shade(machine.ink);
    const faint = shade(machine.ink * FAINT);
    const left = machine.x - a;
    const right = machine.x + a;
    const back = machine.y - b;
    const front = machine.y + b;
    const framed = h * stage(rise, PAD_DONE, FRAME_DONE);
    const walled = h * stage(rise, FRAME_DONE, WALLS_DONE);
    const fitted = stage(rise, WALLS_DONE, 1);

    // The frame goes up first and the walls climb inside it.
    if (walled < h) {
      const corners: [number, number][] = [[left, back], [right, back], [right, front], [left, front]];
      lines([...corners.map(([x, y]): Point[] => [[x, y, 0], [x, y, framed]]), [...corners, corners[0]!].map(([x, y]): Point => [x, y, framed])], line);
    }
    if (walled > 0) {
      face([[left, front, 0], [right, front, 0], [right, front, walled], [left, front, walled]], shade(SIDE), line);
      face([[right, back, 0], [right, front, 0], [right, front, walled], [right, back, walled]], shade(SIDE), line);

      if (size.pitch * k >= STRUT_MIN) {
        const struts: Point[][] = [];
        for (let bay = 1; bay < size.across; bay++) struts.push([[left + (2 * a * bay) / size.across, front, 0], [left + (2 * a * bay) / size.across, front, walled]]);
        for (let bay = 1; bay < size.deep; bay++) struts.push([[right, back + (2 * b * bay) / size.deep, 0], [right, back + (2 * b * bay) / size.deep, walled]]);
        lines(struts, faint);
      }
      const floors = Math.round(h / STOREY); // evenly spaced, so the top floor never crowds the roof line
      const storeys: Point[][] = [];
      for (let floor = 1; floor < floors; floor++) {
        const z = (h * floor) / floors;
        if (z < walled) storeys.push([[left, front, z], [right, front, z], [right, back, z]]);
      }
      lines(storeys, line);

      const lintel = Math.min(DOOR, h);
      if (machine.feeds && walled >= lintel) {
        const jamb = Math.min(BELT / 2 + DOOR_JAMB, b);
        const [near, far] = [machine.y - jamb, machine.y + jamb];
        const run = machine.door * machine.door * (3 - 2 * machine.door); // eased at each end of the shutter's travel
        const shutter = lintel * (SHUTTER_REST + (1 - SHUTTER_REST) * run);
        face([[right, near, 0], [right, far, 0], [right, far, lintel], [right, near, lintel]], shade(DOORWAY), line);
        face([[right, near, shutter], [right, far, shutter], [right, far, lintel], [right, near, lintel]], shade(SIDE), line);
        // Ribs hang from the shutter's foot, so they travel with it and roll away into the lintel.
        if (SHUTTER_RIB * k >= SLAT_MIN) {
          const ribs: Point[][] = [];
          for (let z = shutter + SHUTTER_RIB; z < lintel; z += SHUTTER_RIB) ribs.push([[right, near, z], [right, far, z]]);
          lines(ribs, faint);
        }
        // The awning wears the machine's colour, the same one on the label of every box it sends.
        ctx.globalAlpha = machine.ink;
        face([[right, near, lintel], [right, far, lintel], [right + AWNING, far, lintel - AWNING_DROP], [right + AWNING, near, lintel - AWNING_DROP]], palette.labels[machine.id % palette.labels.length], line);
        ctx.globalAlpha = 1;
      }
      face([[left, back, walled], [right, back, walled], [right, front, walled], [left, front, walled]], shade(0), line);
    }
    if (fitted <= 0) return;

    const [sx0, sy0] = [left + STACK_IN, back + STACK_IN];
    const [sx1, sy1, top] = [sx0 + STACK_WIDE, sy0 + STACK_WIDE, h + STACK * fitted];
    face([[sx0, sy1, h], [sx1, sy1, h], [sx1, sy1, top], [sx0, sy1, top]], shade(SIDE), line);
    face([[sx1, sy0, h], [sx1, sy1, h], [sx1, sy1, top], [sx1, sy0, top]], shade(SIDE), line);
    face([[sx0, sy0, top], [sx1, sy0, top], [sx1, sy1, top], [sx0, sy1, top]], shade(0), line);
    if (machine.ships) {
      // A mast and pennant mark the end of a line: nothing imports this folder.
      const [mx, my, tip] = [right - STACK_IN - STACK_WIDE / 2, back + STACK_IN + STACK_WIDE / 2, h + MAST * fitted];
      lines([[[mx, my, h], [mx, my, tip]]], line);
      face([[mx, my, tip], [mx, my + PENNANT, tip - PENNANT / 3], [mx, my, tip - (PENNANT * 2) / 3]], line, line);
    }

    const gap = size.pitch * HATCH_GAP;
    const across = size.pitch - gap;
    const hatch = (index: number): [Point, Point, Point, Point] => {
      const hx = left + RIM + (index % size.across) * size.pitch + gap / 2;
      const hy = back + RIM + Math.floor(index / size.across) * size.pitch + gap / 2;
      return [[hx, hy, h], [hx + across, hy, h], [hx + across, hy + across, h], [hx, hy + across, h]];
    };
    const detailed = across * GROUND_WIDTH * k >= HATCH_MIN;
    if (detailed) {
      ctx.beginPath();
      for (let index = 0; index < Math.floor(machine.hatches); index++) trace(hatch(index), true);
      ctx.strokeStyle = line;
      ctx.stroke();
    }
    // A hatch both branches changed wears hazard tape. Its colour shows however far out the camera is.
    for (const index of machine.contested) {
      if (index >= machine.hatches) continue;
      ctx.globalAlpha = machine.ink;
      face(hatch(index), palette.hazard, detailed ? line : undefined);
      ctx.globalAlpha = 1;
      if (across * GROUND_WIDTH * k < HAZARD_MIN) continue;
      const [[x0, y0], , [x1, y1]] = hatch(index);
      const at = (u: number, v: number): Point => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * v, h];
      // Where the line u + v = sum crosses the hatch's edge: low on it, then high.
      const cut = (sum: number): [Point, Point] => (sum <= 1 ? [at(sum, 0), at(0, sum)] : [at(1, sum - 1), at(sum - 1, 1)]);
      for (const [from, to] of HAZARD) {
        const [low0, high0] = cut(from);
        const [low1, high1] = cut(to);
        const turns = from < 1 && to > 1; // the band takes in two of the hatch's corners
        face([low0, ...(turns ? [at(1, 0)] : []), low1, high1, ...(turns ? [at(0, 1)] : []), high0], line);
      }
    }
    if (detailed && scene.hot?.machine === machine.id && scene.hot.hatch < machine.hatches) face(hatch(scene.hot.hatch), line, line);

    // A puff for each file a commit just changed here, up to three.
    const [px0, py0] = [left + STACK_IN + STACK_WIDE / 2, back + STACK_IN + STACK_WIDE / 2];
    for (const age of machine.puffs) {
      const life = age / PUFF_LIFE;
      const [px, py] = screen(view, px0, py0, h + STACK + PUFF_RISE * life);
      ctx.globalAlpha = 1 - life;
      ctx.beginPath();
      ctx.arc(px, py, (PUFF_START + PUFF_GROW * life) * k, 0, Math.PI * 2);
      ctx.fillStyle = shade(0);
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  // Machines and boxes are drawn in one pass from the back of the lot to the front, so a box in
  // front of a wall covers it and a box behind one is covered. On this grid, nearer means a larger x + y.
  type Drawn = { depth: number; draw: () => void };
  // A machine's delivery stands in front of its own wall, so it is drawn straight after it.
  const things: Drawn[] = scene.order.map((machine) => ({
    depth: machine.x + machine.y,
    draw: () => {
      building(machine);
      delivery(machine);
    },
  }));
  for (const box of scene.conveyor.boxes) {
    const [x, y] = whereIs(scene.conveyor, box);
    things.push({ depth: x + y, draw: () => carton(box, x, y) });
  }
  things.sort((p, q) => p.depth - q.depth);
  for (const thing of things) {
    thing.draw();
    ctx.globalAlpha = 1;
  }
}
