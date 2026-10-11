// Decides where everything stands: which folders become machines, the cell each takes,
// the route of every belt, and what each machine and belt holds at every step.
import type { Scan } from "./scan";

// World units. A hatch is half a unit.
export const CELL = 6; // between machine centres. The widest roof is 4.1 (ROOF plus two rims), leaving a 1.9 gutter for two belt lanes.
export const SLOT = 0.5; // the lattice everything on a belt snaps to: a box takes one slot. Machine centres, lanes and corners all fall on it.
export const HATCH = 0.5; // roof taken by one file
export const ROOF = 3.5; // the widest a hatch grid gets. Past 49 files the hatches shrink instead of the roof growing.
export const RIM = 0.3; // roof outside the hatches
export const BELT = 0.5; // belt width: one slot, so a box has a little belt either side of it
export const LANE = 0.5; // a belt keeps this far right of the gutter's centre, so opposite traffic has its own track. One slot, to stay on the lattice.
const KB_TO_HEIGHT = 0.2; // height is this times sqrt(kB), so 250 kB stands about 3 high. Any taller and machines hide the belts behind them.
const LOWEST = 0.5; // room for a door
const TALLEST = 9; // ponytail: a folder past 2 MB stops growing taller. Switch to a log scale if repos with huge folders need telling apart.
const MAX_MACHINES = 36; // a 6 by 6 lot still reads at a glance. Smaller folders merge into their parents past this.
const MIN_FOLDERS = 4; // fewer folders than this and a small repo is drawn file by file
const MIN_ROWS = 3;

export type Size = { files: number; bytes: number; across: number; deep: number; pitch: number; a: number; b: number; h: number };
export type Machine = { id: number; name: string; col: number; row: number; x: number; y: number; /** Folders folded into this one. */ merged: string[] };
export type Belt = { from: number; to: number; points: [number, number][]; length: number };
export type Frame = {
  sizes: Size[];
  /** Imports riding each belt, by belt index. Belts not listed are not there yet. */
  belts: Map<number, number>;
  /** Files each machine had changed in this step. */
  touched: Map<number, number>;
};
export type Plan = { machines: Machine[]; belts: Belt[]; frames: Frame[]; /** The machine each file belongs to. */ home: number[] };
export type FileState = Map<number, { bytes: number; imports: number[] }>;

const NOTHING: Size = { files: 0, bytes: 0, across: 1, deep: 1, pitch: HATCH, a: 0, b: 0, h: 0 };

export function size(files: number, bytes: number): Size {
  if (!files) return NOTHING;
  const across = Math.ceil(Math.sqrt(files));
  const deep = Math.ceil(files / across);
  const pitch = Math.min(HATCH, ROOF / across);
  return {
    files,
    bytes,
    across,
    deep,
    pitch,
    a: (across * pitch) / 2 + RIM,
    b: (deep * pitch) / 2 + RIM,
    h: Math.min(TALLEST, Math.max(LOWEST, KB_TO_HEIGHT * Math.sqrt(bytes / 1024))),
  };
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const depthOf = (folder: string) => (folder === "." ? 0 : folder.split("/").length);

/** Calls `visit` with every file alive after each step in turn. */
function replay(scan: Scan, visit: (files: FileState, step: number) => void) {
  const files: FileState = new Map();
  scan.steps.forEach((step, index) => {
    for (const [file, bytes, imports] of step.set) files.set(file, { bytes, imports });
    for (const file of step.gone) files.delete(file);
    visit(files, index);
  });
}

export function filesAt(scan: Scan, at: number): FileState {
  let found: FileState = new Map();
  replay(scan, (files, step) => {
    if (step === at) found = new Map(files);
  });
  return found;
}

// Every folder that ever held a source file is a machine, until there are too many.
// Then the smallest folders fold into their parents, so the machines left are where the code is.
// `split` names folders that must stand alone.
function chooseMachines(scan: Scan, split: ReadonlySet<string>, flatByFile: boolean) {
  // A folder's weight is the most files it held at once, so one that came and went still counts.
  const held = new Map<string, number>();
  replay(scan, (files) => {
    const now = new Map<string, number>();
    for (const file of files.keys()) now.set(folderOf(scan.paths[file]!), (now.get(folderOf(scan.paths[file]!)) ?? 0) + 1);
    for (const [folder, count] of now) held.set(folder, Math.max(held.get(folder) ?? 0, count));
  });
  // A partial clone names files whose contents it does not hold, so a path can be touched without ever being a file.
  // Its folder still has to lead somewhere, or looking up its machine below would never end.
  for (const path of scan.paths) if (!held.has(folderOf(path))) held.set(folderOf(path), 0);
  const merged = new Map<string, string[]>();
  const limit = MAX_MACHINES + split.size;
  // ponytail: each pass looks at every folder left, so 5,000 folders take over a second. Keep them in a heap if repos that wide matter.
  while (held.size > limit) {
    const foldable = [...held.keys()].filter((folder) => folder !== "." && !split.has(folder));
    if (!foldable.length) break;
    const folder = foldable.reduce((pick, other) => {
      const smaller = held.get(pick)! - held.get(other)! || depthOf(other) - depthOf(pick);
      return smaller > 0 || (!smaller && other < pick) ? other : pick;
    });
    const parent = folderOf(folder);
    held.set(parent, (held.get(parent) ?? 0) + held.get(folder)!);
    held.delete(folder);
    merged.set(parent, [...new Set([...(merged.get(parent) ?? []), folder])]); // a folder can fold in twice, once for itself and once for what folded into it later
  }
  // ponytail: a repo too flat to make a factory gets a machine per file instead, so its imports still lay belts.
  if (flatByFile && held.size < MIN_FOLDERS && scan.paths.length <= MAX_MACHINES) return { names: scan.paths, merged, home: scan.paths.map((_, id) => id) };
  const names = [...held.keys()].sort();
  const ids = new Map(names.map((name, id) => [name, id]));
  const home = scan.paths.map((path) => {
    let folder = folderOf(path);
    while (!ids.has(folder)) folder = folderOf(folder);
    return ids.get(folder)!;
  });
  return { names, merged, home };
}

function layout(names: string[], merged: Map<string, string[]>, takes: Set<number>[]): Machine[] {
  // A folder sits one layer past the deepest thing it imports, so parts flow one way.
  // ponytail: a cycle is cut where the walk first meets it, leaving one belt running back. Cut the lightest edge instead if repos tangle badly.
  const depth: (number | undefined)[] = names.map(() => undefined);
  const walking = new Set<number>();
  const layerOf = (id: number): number => {
    if (depth[id] !== undefined) return depth[id]!;
    if (walking.has(id)) return -1;
    walking.add(id);
    let deepest = -1;
    for (const from of takes[id]!) deepest = Math.max(deepest, layerOf(from));
    walking.delete(id);
    return (depth[id] = deepest + 1);
  };

  const fed = new Set(takes.flatMap((from) => [...from]));
  const linked = names.map((_, id) => takes[id]!.size > 0 || fed.has(id));
  // A long import chain would stretch the lot into a strip, so neighbouring layers share a column
  // until the lot is about as wide as it is deep. Belts inside a shared column loop round by the aisle.
  const deepest = Math.max(0, ...names.map((_, id) => (linked[id] ? layerOf(id) : 0))) + 1;
  const wide = Math.max(MIN_ROWS, Math.ceil(Math.sqrt(linked.filter(Boolean).length)));
  const layers = new Map<number, number[]>();
  names.forEach((_, id) => {
    const layer = linked[id] ? Math.floor((layerOf(id) * Math.min(wide, deepest)) / deepest) : -1; // folders that never import stand apart, before the line
    layers.set(layer, [...(layers.get(layer) ?? []), id]);
  });

  // A long layer wraps into several columns so the lot stays near square.
  const rows = Math.max(MIN_ROWS, Math.ceil(Math.sqrt(names.length)) + 1);
  const tallest = Math.min(rows, Math.max(...[...layers.values()].map((members) => members.length)));
  const machines: Machine[] = [];
  let col = 0;
  for (const layer of [...layers.keys()].sort((p, q) => p - q)) {
    const members = layers.get(layer)!;
    // Order a layer by where its imports already sit, so belts cross less.
    const pull = (id: number) => {
      const placed = [...takes[id]!].flatMap((from) => (machines[from] ? [machines[from].row] : []));
      return placed.length ? placed.reduce((sum, row) => sum + row, 0) / placed.length : tallest / 2;
    };
    members.sort((p, q) => pull(p) - pull(q) || p - q);
    for (let start = 0; start < members.length; start += rows, col++) {
      const column = members.slice(start, start + rows);
      const first = Math.floor((tallest - column.length) / 2);
      column.forEach((id, index) => {
        const row = first + index;
        machines[id] = { id, name: names[id]!, col, row, x: col * CELL, y: row * CELL, merged: merged.get(names[id]!) ?? [] };
      });
    }
  }
  return machines;
}

// Out by the door into the gutter after `from`, along an aisle unless `to` is the very next column,
// in from the gutter before `to`. Gutters and aisles run between cells, so no belt crosses a floor.
export function route(from: Machine, to: Machine): [number, number][] {
  const out = from.x + CELL / 2;
  const into = to.x - CELL / 2;
  const keepRight = (start: number, end: number) => Math.sign(end - start) * LANE;
  if (out === into) {
    const gutter = out + keepRight(from.y, to.y);
    return [[from.x, from.y], [gutter, from.y], [gutter, to.y], [to.x, to.y]];
  }
  const centre = to.y + (from.y >= to.y ? CELL / 2 : -CELL / 2);
  const aisle = centre - keepRight(out, into);
  const leave = out + keepRight(from.y, centre);
  const arrive = into + keepRight(centre, to.y);
  return [[from.x, from.y], [leave, from.y], [leave, aisle], [arrive, aisle], [arrive, to.y], [to.x, to.y]];
}

export const runLength = ([x0, y0]: [number, number], [x1, y1]: [number, number]) => Math.abs(x1 - x0) + Math.abs(y1 - y0); // runs are axis aligned

/** `flatByFile` lets a repo with too few folders be drawn a machine per file. The legend's two-folder figures turn it off. */
export function plan(scan: Scan, split: ReadonlySet<string> = new Set(), flatByFile = true): Plan {
  const { names, merged, home } = chooseMachines(scan, split, flatByFile);

  // First pass: what every step holds, with belts still named by their two machines.
  const key = (from: number, to: number) => from * names.length + to;
  const takes = names.map(() => new Set<number>());
  const loads: Map<number, number>[] = [];
  const frames: Frame[] = [];
  replay(scan, (files, index) => {
    const held = names.map(() => ({ files: 0, bytes: 0 }));
    const load = new Map<number, number>();
    for (const [file, { bytes, imports }] of files) {
      const to = home[file]!;
      held[to]!.files += 1;
      held[to]!.bytes += bytes;
      for (const target of imports) {
        const from = home[target]!;
        if (from === to || !files.has(target)) continue;
        load.set(key(from, to), (load.get(key(from, to)) ?? 0) + 1);
        takes[to]!.add(from);
      }
    }
    const touched = new Map<number, number>();
    for (const file of scan.steps[index]!.touched) touched.set(home[file]!, (touched.get(home[file]!) ?? 0) + 1);
    loads.push(load);
    frames.push({ sizes: held.map(({ files: count, bytes }) => size(count, bytes)), belts: new Map(), touched });
  });

  const machines = layout(names, merged, takes);
  const belts: Belt[] = [];
  const beltOf = new Map<number, number>();
  loads.forEach((load, index) => {
    for (const [pair, count] of load) {
      if (!beltOf.has(pair)) {
        const from = Math.floor(pair / names.length);
        const to = pair % names.length;
        const points = route(machines[from]!, machines[to]!);
        const length = points.reduce((sum, point, nth) => sum + (nth ? runLength(points[nth - 1]!, point) : 0), 0);
        beltOf.set(pair, belts.push({ from, to, points, length }) - 1);
      }
      frames[index]!.belts.set(beltOf.get(pair)!, count);
    }
  });
  return { machines, belts, frames, home };
}

export const plural = (count: number, word: string) => `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;

/** What a step holds, in words. The page prints it at build time and the tool keeps it up to date. */
export function tally(frame: Frame): string {
  const standing = frame.sizes.filter((size) => size.files);
  const files = standing.reduce((sum, size) => sum + size.files, 0);
  const imports = [...frame.belts.values()].reduce((sum, count) => sum + count, 0);
  return `${plural(standing.length, "machine")}, ${plural(files, "file")}, ${plural(frame.belts.size, "belt")}, ${plural(imports, "import")}`;
}
