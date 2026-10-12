// A stamp: one repo's factory as a card to post, a score that says how big it is, and a link that
// carries both to someone else's browser. A link is written by whoever sends it, so unpack() trusts
// nothing in it.
import { aim, build, fit, paint, type Palette, type Scene, type Shade } from "./factory";
import { CELL, route, runLength, size, type Belt, type Machine, type Plan } from "./plan";

/** A factory, down to what a stamp needs to draw and score it. No folder or file name is in it. */
export type Blueprint = {
  commits: number;
  /** Each machine standing: its cell on the lot, its files and its source in kB. */
  machines: [col: number, row: number, files: number, kB: number][];
  /** Each belt: the machine it leaves, the one it enters, and the imports riding it. */
  belts: [from: number, to: number, imports: number][];
};
export type Style = "classic" | "poster" | "panel" | "frame";
export const STYLES: Style[] = ["classic", "poster", "panel", "frame"];
/** A look with no style is the classic one, as on a link made before there were others. */
export type Look = { title: string; paper: string; ink: string; accent: string; style?: Style };
export type Stat = "machines" | "files" | "belts" | "commits";
export const STATS: Stat[] = ["machines", "files", "belts", "commits"];

const VERSION = 2; // of the link's layout: 2 added the style. A link in a layout this page never wrote is turned away, not guessed at.
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

const tallyOf = ({ commits, machines, belts }: Blueprint): Record<Stat, number> => ({
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
  const frame = { sizes: machines.map(([, , files, kB]) => size(files, kB * KB)), belts: new Map(belts.map(([, , imports], index) => [index, imports])), touched: new Map<number, number>(), delivered: new Map<number, number>(), contested: new Map<number, number[]>() };
  const scene = build({ machines: placed, belts: routed, frames: [frame], home: [] });
  aim(scene, frame, true);
  return scene;
}

// ---- the link ----

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A factory and its look as letters, digits, "-" and "_": what survives a URL's fragment on any host. */
export function pack(blueprint: Blueprint, { title, paper, ink, accent, style = "classic" }: Look): string {
  const payload = [VERSION, [...title].slice(0, TITLE_MOST).join(""), paper, ink, accent, blueprint.commits, blueprint.machines.flat(), blueprint.belts.flat(), style];
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
  if (!Array.isArray(payload)) return undefined;
  const [version, title, paper, ink, accent, commits, flatMachines, flatBelts, style] = payload as unknown[];
  // The first layout had eight parts and no style. Links in it are out there, so they still open.
  if (version === 1 ? payload.length !== 8 : payload.length !== 9 || !STYLES.includes(style as Style)) return undefined;
  const count = (value: unknown, most = MOST_COUNT): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= most;
  const colour = (value: unknown): value is string => typeof value === "string" && COLOUR.test(value);
  if ((version !== 1 && version !== VERSION) || typeof title !== "string" || [...title].length > TITLE_MOST) return undefined;
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
  return { blueprint: { commits, machines, belts }, look: { title, paper, ink, accent, style: (style as Style | undefined) ?? "classic" } };
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
const BAND = 0.2; // poster and frame: the paper under the block of colour, for the name
const DEEP = 0.25; // panel: a deeper band, for a name set very large
const POSTER = 0.1; // the poster's name and score
const HUGE = 0.13; // the panel's name
const LINE = 0.03; // the three lines beside it
const LEADING = 1.3;
const LET_OUT = 0.07; // the frame's name
const WIDELY = "0.14em"; // and how far it is let out
const CAP = 0.7; // a capital's height in Paper Mono, as a share of its size: what centres a line on its capitals
const CORNER = 0.03; // the panel's rounding
const STAR = 0.035; // how far a star on the frame reaches
const STAR_WAIST = 0.22; // and how narrow it is between its points, as a share of that
const CLOSEST = 0.09; // px per world unit a small factory is drawn at, as a share of the side: a two machine repo should not fill the stamp with one wall

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** Draws the whole stamp. `base` gives the cardboard colours; the look gives the rest. */
export function paintStamp(ctx: CanvasRenderingContext2D, scene: Scene, blueprint: Blueprint, look: Look, shows: Stat[], width: number, height: number, base: Palette) {
  const side = Math.min(width, height);
  const [paper, ink, accent] = [channels(look.paper), channels(look.ink), channels(look.accent)];
  /** A ramp from a ground to the colour drawn on it, as the factory's painter wants one. */
  const ramp = (ground: number[], line: number[]): Shade => (strength) => `rgb(${ground.map((channel, index) => Math.round(channel + (line[index]! - channel) * strength)).join()})`;
  const shade = ramp(paper, ink);
  const type = (size: number, weight = 400, tracking = "0em") => {
    const px = Math.round(size * side);
    ctx.font = `${weight} ${px}px ${FACE}`;
    ctx.letterSpacing = `${parseFloat(tracking) * px}px`; // in px, because not every canvas takes an em here as the font's own
  };
  /** Draws text no wider than `room`: a long one is cut short with an ellipsis. */
  const write = (text: string, x: number, y: number, room: number) => {
    let shown = text;
    while (shown.length > 1 && ctx.measureText(shown).width > room) shown = `${[...shown].slice(0, -2).join("")}…`;
    ctx.fillText(shown, x, y);
  };
  /** The size, at or under `size`, at which these texts and the gaps between them fit across `room`. */
  const fitted = (texts: string[], size: number, weight: number, tracking: string, room: number, between: number) => {
    type(size, weight, tracking);
    const wanted = texts.reduce((sum, text) => sum + ctx.measureText(text).width, 0) + between * (texts.length - 1);
    return wanted > room ? (size * room) / wanted : size;
  };
  /** The factory, fitted into a box and drawn in a ramp of its own. */
  const picture = (x: number, y: number, wide: number, tall: number, shades: Shade, label: string) => {
    const view = fit(scene, wide, tall, { left: 0, right: 0, top: 0, bottom: 0 }, CLOSEST * side);
    if (!view) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, wide, tall);
    ctx.clip();
    ctx.translate(x, y);
    ctx.lineWidth = 1;
    paint(ctx, scene, view, { ...base, shade: shades, labels: [label] });
    ctx.restore();
  };
  /** A box with rounded corners, or a square one in a browser from before canvases could round them. */
  const rounded = (x: number, y: number, wide: number, tall: number, radius: number) => (ctx.roundRect ? ctx.roundRect(x, y, wide, tall, radius) : ctx.rect(x, y, wide, tall));
  const style = look.style ?? "classic";

  // The mat, then the paper. Every style but the frame has a row of holes punched along each edge.
  ctx.fillStyle = look.ink;
  ctx.fillRect(0, 0, width, height);
  const mat = MAT * side;
  ctx.fillStyle = look.paper;
  ctx.fillRect(mat, mat, width - 2 * mat, height - 2 * mat);
  if (style !== "frame") {
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
  }

  const frame = mat + FRAME * side;
  const inset = INSET * side;
  const gap = GAP * side;
  const hair = Math.max(1, side / 540);
  const counts = tallyOf(blueprint);
  const score = scoreOf(blueprint);
  const [rank, points] = [rankOf(score), score.toLocaleString("en")];
  const maker = "ISOMETRIC GIT";
  const label = (stat: Stat) => (counts[stat] === 1 ? stat.slice(0, -1) : stat).toUpperCase();

  // ---- classic: a ruled frame, the name over the factory, the rank and score under it, the numbers in a row ----
  const classic = () => {
    ctx.strokeStyle = shade(FAINT);
    ctx.lineWidth = hair;
    ctx.strokeRect(frame, frame, width - 2 * frame, height - 2 * frame);
    const left = frame + inset;
    const right = width - left;
    const top = frame + inset;
    const bottom = height - top;
    const room = right - left;

    // Top row: whose factory, and what drew it.
    ctx.textBaseline = "top";
    ctx.fillStyle = shade(SOFT);
    ctx.textAlign = "right";
    type(SMALL, 400, TRACKED);
    ctx.fillText(maker, right, top + (TITLE - SMALL) * side);
    const titleRoom = room - ctx.measureText(maker).width - gap;
    ctx.textAlign = "left";
    ctx.fillStyle = look.ink;
    type(TITLE, 700, "-0.02em");
    write(look.title, left, top, titleRoom);

    // Bottom rows, from the bottom up: the numbers, a rule, then the rank and the score.
    let floor = bottom;
    if (shows.length) {
      const column = room / shows.length;
      ctx.textBaseline = "alphabetic";
      shows.forEach((stat, nth) => {
        const x = left + column * nth;
        ctx.fillStyle = shade(SOFT);
        type(SMALL, 400, TRACKED);
        write(label(stat), x, floor, column - gap);
        ctx.fillStyle = look.ink;
        type(NUMBER, 700);
        write(counts[stat].toLocaleString("en"), x, floor - SMALL * side * 1.5, column - gap);
      });
      floor -= (SMALL * 1.5 + NUMBER) * side + gap * 0.6;
      ctx.fillStyle = shade(FAINT);
      ctx.fillRect(left, floor, room, ctx.lineWidth);
      floor -= gap * 0.8;
    }
    // The rank and the score share a row. Both shrink together when a long rank meets a long score.
    ctx.textBaseline = "alphabetic";
    const big = fitted([rank, points], BIG, 700, "-0.04em", room, gap);
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
    picture(left, roof, room, floor - roof, shade, look.accent);
  };

  // The three styles below share a shape: the factory on a block of the accent, and a band of paper under it for the name.
  const wide = width - 2 * frame;
  /** The numbers in one row of small capitals with their feet on `y`: the first at the left of `room`, the last at its right, the same space between each. */
  const row = (x: number, y: number, room: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    type(SMALL, 700, TRACKED);
    const texts = shows.map((stat) => `${counts[stat].toLocaleString("en")} ${label(stat)}`);
    const widths = texts.map((text) => ctx.measureText(text).width);
    const between = (room - widths.reduce((sum, each) => sum + each, 0)) / Math.max(1, texts.length - 1);
    let at = x;
    texts.forEach((text, nth) => {
      write(text, at, y, room / texts.length);
      at += widths[nth]! + between;
    });
  };
  const rowTall = shows.length ? SMALL * side + gap : 0; // what the row takes from the block

  // ---- poster: the factory cut from paper on the colour, the name large under it, the score beside the name ----
  const poster = () => {
    const tall = height - 2 * frame - BAND * side;
    ctx.fillStyle = look.accent;
    ctx.fillRect(frame, frame, wide, tall);
    ctx.fillStyle = look.paper;
    ctx.textBaseline = "top";
    type(SMALL, 700, TRACKED);
    ctx.textAlign = "left";
    ctx.fillText(maker, frame + inset, frame + inset);
    ctx.textAlign = "right";
    ctx.fillText(rank.toUpperCase(), frame + wide - inset, frame + inset);
    row(frame + inset, frame + tall - inset, wide - 2 * inset, look.paper);
    const roof = frame + inset + SMALL * side + gap;
    picture(frame + inset, roof, wide - 2 * inset, frame + tall - inset - rowTall - roof, shade, look.accent);

    const size = fitted([look.title, points], POSTER, 700, "-0.04em", wide, gap * 2);
    const foot = height - frame - (BAND * side - size * side * CAP) / 2; // the capitals sit in the middle of the band
    type(size, 700, "-0.04em");
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = look.ink;
    ctx.fillText(look.title, frame, foot);
    ctx.textAlign = "right";
    ctx.fillStyle = look.accent;
    ctx.fillText(points, frame + wide, foot);
    ctx.textAlign = "left";
  };

  // ---- panel: the factory in ink on a rounded panel of the colour, the name very large, three lines beside it ----
  const panel = () => {
    const tall = height - 2 * frame - DEEP * side;
    ctx.fillStyle = look.accent;
    ctx.beginPath();
    rounded(frame, frame, wide, tall, CORNER * side);
    ctx.fill();
    row(frame + inset, frame + tall - inset, wide - 2 * inset, look.ink);
    picture(frame + inset, frame + inset, wide - 2 * inset, tall - 2 * inset - rowTall, ramp(accent, ink), look.paper);

    const lines = [rank.toUpperCase(), `${points} ${score === 1 ? "POINT" : "POINTS"}`, maker];
    type(LINE, 700, "0.02em");
    const block = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const size = fitted([look.title], HUGE, 700, "-0.05em", wide - block - gap, 0);
    const foot = height - frame - (DEEP * side - HUGE * side * CAP) / 2; // set by the largest the name gets, so the lines beside it never move
    ctx.fillStyle = look.ink;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    type(size, 700, "-0.05em");
    ctx.fillText(look.title, frame, foot);
    type(LINE, 700, "0.02em");
    lines.forEach((line, nth) => ctx.fillText(line, frame + wide - block, foot - (lines.length - 1 - nth) * LINE * LEADING * side));
  };

  // ---- frame: no holes, the factory as paper lines on the colour, a star in two corners, the name let out wide ----
  const framed = () => {
    const tall = height - 2 * frame - BAND * side;
    ctx.fillStyle = look.accent;
    ctx.fillRect(frame, frame, wide, tall);
    row(frame + inset, frame + tall - inset, wide - 2 * inset, look.paper);
    picture(frame + inset, frame + inset, wide - 2 * inset, tall - 2 * inset - rowTall, ramp(accent, paper), look.paper);
    ctx.fillStyle = look.paper;
    const reach = STAR * side;
    for (const [x, y] of [[frame + wide - inset - reach, frame + inset + reach], [frame + inset + reach, frame + tall - inset - rowTall - reach]] as const) {
      ctx.beginPath();
      for (let point = 0; point < 8; point++) {
        const out = point % 2 ? reach * STAR_WAIST : reach;
        ctx.lineTo(x + out * Math.sin((point * Math.PI) / 4), y - out * Math.cos((point * Math.PI) / 4));
      }
      ctx.fill();
    }

    // A badge for the rank and the score, and the name in what is left.
    const badge = `${rank.toUpperCase()}  ${points}`;
    type(SMALL, 700, TRACKED);
    const boxWide = ctx.measureText(badge).width + inset;
    const boxTall = SMALL * side + inset * 0.7;
    const middle = height - frame - (BAND * side) / 2;
    ctx.strokeStyle = ctx.fillStyle = look.accent;
    ctx.lineWidth = hair;
    ctx.beginPath();
    rounded(frame + wide - boxWide, middle - boxTall / 2, boxWide, boxTall, boxTall / 2);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(badge, frame + wide - boxWide / 2, middle);
    const name = look.title.toUpperCase();
    type(fitted([name], LET_OUT, 800, WIDELY, wide - boxWide - gap, 0), 800, WIDELY);
    ctx.textAlign = "left";
    ctx.fillText(name, frame, middle);
    ctx.textBaseline = "alphabetic";
  };

  ({ classic, poster, panel, frame: framed })[style]();
}
