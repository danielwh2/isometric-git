// A stamp: one repo's factory as a card to post, a score that says how big it is, and a link that
// carries both to someone else's browser. A link is written by whoever sends it, so unpack() trusts
// nothing in it.
import { aim, build, fit, paint, type Palette, type Scene } from "./factory";
import { CELL, route, runLength, size, type Belt, type Machine, type Plan } from "./plan";

/** A factory, down to what a stamp needs to draw and score it. No folder or file name is in it. */
export type Blueprint = {
  commits: number;
  /** Each machine standing: its cell on the lot, its files and its source in kB. */
  machines: [col: number, row: number, files: number, kB: number][];
  /** Each belt: the machine it leaves, the one it enters, and the imports riding it. */
  belts: [from: number, to: number, imports: number][];
};
export type Look = { title: string; paper: string; ink: string; accent: string };
export type Stat = "machines" | "files" | "belts" | "commits";
export const STATS: Stat[] = ["machines", "files", "belts", "commits"];

const VERSION = 1; // of the link's layout. A link in another layout is turned away, not guessed at.
export const TITLE_MOST = 40; // characters: what fits across a stamp before it is cut short
// The most a link may claim. Past these it is not a factory this page could have made.
const MOST_MACHINES = 100; // the lot holds 36 until folders are split out by hand
const MOST_CELL = 64; // a lot is never this wide or deep
const MOST_COUNT = 100_000_000; // files, kB, imports or commits
const COLOUR = /^#[0-9a-f]{6}$/i;
const KB = 1024;

// The score: a point a file, a point a kB of source, and a few for every belt, because a belt is two
// folders that depend on each other and that is worth more than one more file.
const BELT_POINTS = 5;
// ponytail: tuned by guess against a handful of repos (a 60 file app is a Workshop, a 1,200 file one a Works).
// Move the steps once real stamps show where people land.
const RANKS: [from: number, name: string][] = [[25_000, "Megafactory"], [5_000, "Works"], [1_000, "Plant"], [250, "Workshop"], [0, "Shed"]];

export function blueprintOf(plan: Plan, commits: number): Blueprint {
  const frame = plan.frames.at(-1)!;
  const standing = plan.machines.filter((machine) => frame.sizes[machine.id]!.files);
  const nth = new Map(standing.map((machine, index) => [machine.id, index]));
  return {
    commits,
    machines: standing.map(({ id, col, row }) => [col, row, frame.sizes[id]!.files, Math.round(frame.sizes[id]!.bytes / KB)]),
    belts: [...frame.belts].map(([index, imports]) => [nth.get(plan.belts[index]!.from)!, nth.get(plan.belts[index]!.to)!, imports]),
  };
}

export const tallyOf = ({ commits, machines, belts }: Blueprint): Record<Stat, number> => ({
  machines: machines.length,
  files: machines.reduce((sum, [, , files]) => sum + files, 0),
  belts: belts.length,
  commits,
});
export const scoreOf = (blueprint: Blueprint) => tallyOf(blueprint).files + blueprint.machines.reduce((sum, [, , , kB]) => sum + kB, 0) + blueprint.belts.length * BELT_POINTS;
export const rankOf = (score: number) => RANKS.find(([from]) => score >= from)![1];

/** The factory a blueprint describes, finished and already carrying boxes. */
export function sceneOf({ machines, belts }: Blueprint): Scene {
  const placed: Machine[] = machines.map(([col, row], id) => ({ id, name: "", col, row, x: col * CELL, y: row * CELL, merged: [] }));
  const routed: Belt[] = belts.map(([from, to]) => {
    const points = route(placed[from]!, placed[to]!);
    return { from, to, points, length: points.reduce((sum, point, at) => sum + (at ? runLength(points[at - 1]!, point) : 0), 0) };
  });
  const frame = { sizes: machines.map(([, , files, kB]) => size(files, kB * KB)), belts: new Map(belts.map(([, , imports], index) => [index, imports])), touched: new Map<number, number>() };
  const scene = build({ machines: placed, belts: routed, frames: [frame], home: [] });
  aim(scene, frame, true);
  return scene;
}

// ---- the link ----

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A factory and its look as letters, digits, "-" and "_": what survives a URL's fragment on any host. */
export function pack(blueprint: Blueprint, { title, paper, ink, accent }: Look): string {
  const payload = [VERSION, title, paper, ink, accent, blueprint.commits, blueprint.machines.flat(), blueprint.belts.flat()];
  return base64url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Undefined unless the text is a link this page could have written. */
export function unpack(packed: string): { blueprint: Blueprint; look: Look } | undefined {
  let payload: unknown;
  try {
    const binary = atob(packed.replaceAll("-", "+").replaceAll("_", "/"));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch {
    return undefined;
  }
  if (!Array.isArray(payload) || payload.length !== 8) return undefined;
  const [version, title, paper, ink, accent, commits, flatMachines, flatBelts] = payload as unknown[];
  const count = (value: unknown, most = MOST_COUNT): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= most;
  const colour = (value: unknown): value is string => typeof value === "string" && COLOUR.test(value);
  if (version !== VERSION || typeof title !== "string" || [...title].length > TITLE_MOST) return undefined;
  if (!colour(paper) || !colour(ink) || !colour(accent) || !count(commits)) return undefined;
  if (!Array.isArray(flatMachines) || !Array.isArray(flatBelts) || flatMachines.length % 4 || flatBelts.length % 3) return undefined;
  if (!flatMachines.length || flatMachines.length / 4 > MOST_MACHINES || flatBelts.length / 3 > MOST_MACHINES * MOST_MACHINES) return undefined;

  const machines: Blueprint["machines"] = [];
  const cells = new Set<string>();
  for (let at = 0; at < flatMachines.length; at += 4) {
    const [col, row, files, kB] = flatMachines.slice(at, at + 4);
    if (!count(col, MOST_CELL) || !count(row, MOST_CELL) || !count(files) || !files || !count(kB)) return undefined;
    if (cells.has(`${col},${row}`)) return undefined; // two machines cannot share a cell
    cells.add(`${col},${row}`);
    machines.push([col, row, files, kB]);
  }
  const belts: Blueprint["belts"] = [];
  for (let at = 0; at < flatBelts.length; at += 3) {
    const [from, to, imports] = flatBelts.slice(at, at + 3);
    if (!count(from, machines.length - 1) || !count(to, machines.length - 1) || from === to || !count(imports) || !imports) return undefined;
    belts.push([from, to, imports]);
  }
  return { blueprint: { commits, machines, belts }, look: { title, paper, ink, accent } };
}

// ---- the picture ----

// Shares of the stamp's shorter side, so a square and a wide stamp are the same drawing at two shapes. Tuned by eye.
const MAT = 0.045; // the dark ground the stamp lies on
const HOLE = 0.011; // radius of a perforation
const HOLE_PITCH = 3.1; // perforations sit this many radii apart, near enough: they are spaced to end on the corners
const FRAME = 0.035; // paper between the perforated edge and the ruled frame
const INSET = 0.04; // the frame's padding
const SMALL = 0.021; // text sizes
const TITLE = 0.034;
const BIG = 0.078;
const NUMBER = 0.036;
const GAP = 0.03; // between the stamp's rows
const TRACKED = "0.08em"; // small capitals are let out a little
const FAINT = 0.3; // ink strength of the ruled frame and the rule over the numbers
const SOFT = 0.8; // and of the small labels, as on the page
const FACE = '"Paper Mono", ui-monospace, monospace';
const CLOSEST = 0.09; // px per world unit a small factory is drawn at, as a share of the side: a two machine repo should not fill the stamp with one wall

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** Draws the whole stamp. `base` gives the cardboard colours; the look gives the rest. */
export function paintStamp(ctx: CanvasRenderingContext2D, scene: Scene, blueprint: Blueprint, look: Look, shows: Stat[], width: number, height: number, base: Palette) {
  const side = Math.min(width, height);
  const [paper, ink] = [channels(look.paper), channels(look.ink)];
  const shade = (strength: number) => `rgb(${paper.map((channel, index) => Math.round(channel + (ink[index]! - channel) * strength)).join()})`;
  const type = (size: number, weight = 400, tracking = "0em") => {
    ctx.font = `${weight} ${Math.round(size * side)}px ${FACE}`;
    ctx.letterSpacing = tracking;
  };
  /** Draws text no wider than `room`: a long one is cut short with an ellipsis. */
  const write = (text: string, x: number, y: number, room: number) => {
    let shown = text;
    while (shown.length > 1 && ctx.measureText(shown).width > room) shown = `${[...shown].slice(0, -2).join("")}…`;
    ctx.fillText(shown, x, y);
  };

  // The mat, then the paper with a row of holes punched along each edge.
  ctx.fillStyle = look.ink;
  ctx.fillRect(0, 0, width, height);
  const mat = MAT * side;
  ctx.fillStyle = look.paper;
  ctx.fillRect(mat, mat, width - 2 * mat, height - 2 * mat);
  ctx.fillStyle = look.ink;
  ctx.beginPath();
  for (const [length, across] of [[width - 2 * mat, true], [height - 2 * mat, false]] as const) {
    const holes = Math.round(length / (HOLE * side * HOLE_PITCH));
    for (let nth = 0; nth <= holes; nth++) {
      const along = mat + (length * nth) / holes;
      for (const edge of [mat, (across ? height : width) - mat]) {
        const [x, y] = across ? [along, edge] : [edge, along];
        ctx.moveTo(x + HOLE * side, y);
        ctx.arc(x, y, HOLE * side, 0, Math.PI * 2);
      }
    }
  }
  ctx.fill();

  const frame = mat + FRAME * side;
  ctx.strokeStyle = shade(FAINT);
  ctx.lineWidth = Math.max(1, side / 540);
  ctx.strokeRect(frame, frame, width - 2 * frame, height - 2 * frame);
  const left = frame + INSET * side;
  const right = width - left;
  const top = frame + INSET * side;
  const bottom = height - top;
  const room = right - left;
  const gap = GAP * side;

  // Top row: whose factory, and what drew it.
  ctx.textBaseline = "top";
  ctx.fillStyle = shade(SOFT);
  ctx.textAlign = "right";
  type(SMALL, 400, TRACKED);
  const maker = "ISOMETRIC GIT";
  ctx.fillText(maker, right, top + (TITLE - SMALL) * side);
  const titleRoom = room - ctx.measureText(maker).width - gap;
  ctx.textAlign = "left";
  ctx.fillStyle = look.ink;
  type(TITLE, 700, "-0.02em");
  write(look.title, left, top, titleRoom);

  // Bottom rows, from the bottom up: the numbers, a rule, then the rank and the score.
  let floor = bottom;
  if (shows.length) {
    const counts = tallyOf(blueprint);
    const column = room / shows.length;
    ctx.textBaseline = "alphabetic";
    shows.forEach((stat, nth) => {
      const x = left + column * nth;
      ctx.fillStyle = shade(SOFT);
      type(SMALL, 400, TRACKED);
      write((counts[stat] === 1 ? stat.slice(0, -1) : stat).toUpperCase(), x, floor, column - gap);
      ctx.fillStyle = look.ink;
      type(NUMBER, 700);
      write(counts[stat].toLocaleString("en"), x, floor - SMALL * side * 1.5, column - gap);
    });
    floor -= (SMALL * 1.5 + NUMBER) * side + gap * 0.6;
    ctx.fillStyle = shade(FAINT);
    ctx.fillRect(left, floor, room, ctx.lineWidth);
    floor -= gap * 0.8;
  }
  const score = scoreOf(blueprint);
  const [rank, points] = [rankOf(score), score.toLocaleString("en")];
  // The rank and the score share a row. Both shrink together when a long rank meets a long score.
  ctx.textBaseline = "alphabetic";
  let big = BIG;
  type(big, 700, "-0.04em");
  const wanted = ctx.measureText(rank).width + ctx.measureText(points).width + gap;
  if (wanted > room) big *= room / wanted;
  type(big, 700, "-0.04em");
  ctx.fillStyle = look.ink;
  ctx.textAlign = "left";
  ctx.fillText(rank, left, floor);
  ctx.fillStyle = look.accent;
  ctx.textAlign = "right";
  ctx.fillText(points, right, floor);
  ctx.textAlign = "left";
  floor -= big * side + gap * 0.5;

  // What is left between the title and the rank is the factory's.
  const roof = top + TITLE * side + gap;
  const view = fit(scene, room, floor - roof, { left: 0, right: 0, top: 0, bottom: 0 }, CLOSEST * side);
  if (!view) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, roof, room, floor - roof);
  ctx.clip();
  ctx.translate(left, roof);
  ctx.lineWidth = 1;
  paint(ctx, scene, view, { ...base, shade, labels: [look.accent] });
  ctx.restore();
}
