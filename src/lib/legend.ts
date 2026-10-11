// The five figures under "How to read it". Each is a tiny repo run through the same planner and
// painter as the factory, so a figure is the mark itself and cannot drift from it.
import { advance, aim, build, fit, paint, screen, type Palette, type Scene, type View } from "./factory";
import { plan } from "./plan";
import type { Scan } from "./scan";

const SCALE = 30; // px per unit in a figure: close enough that hatches, rollers and crates all show
const PAD = 14; // px kept clear inside a figure
const PUFF_EVERY = 2600; // ms between the smoke figure's commits
const PUFFS = 2;
const STILL_PUFFS = [150, 500, 850]; // ms old: under reduced motion nothing moves, so the smoke figure holds three puffs at these ages
const CHIMNEY_HALF = 0.3; // world units: lifts the centre so a machine and its chimney sit in the middle together
const MAX_FRAME = 64; // ms. A longer gap is a tab coming back, not a frame.

/** A made-up repo: each folder's file count and bytes, and the folder it imports from. */
function tiny(folders: Record<string, { files: number; kb: number; takes?: string }>): Scan {
  const names = Object.keys(folders);
  const paths = names.flatMap((name) => Array.from({ length: folders[name]!.files }, (_, file) => `${name}/${file}.ts`));
  const first = (name: string) => paths.indexOf(`${name}/0.ts`);
  const set = paths.map((path, id): [number, number, number[]] => {
    const { files, kb, takes } = folders[path.split("/")[0]!]!;
    return [id, (kb * 1024) / files, takes ? [first(takes)] : []];
  });
  return { name: "", commits: 1, paths, steps: [{ hash: "", date: "", subject: "", nth: 1, set, gone: [], touched: [] }] };
}

const ONE = tiny({ src: { files: 6, kb: 60 } });
const TWO = tiny({ lib: { files: 4, kb: 30 }, app: { files: 6, kb: 60, takes: "lib" } });

/** What each figure shows. `focus` centres one machine; without it the whole scene is framed. */
const FIGURES: Record<string, { scan: Scan; focus?: string; hatch?: number; smoke?: boolean }> = {
  machine: { scan: ONE, focus: "src" },
  hatch: { scan: ONE, focus: "src", hatch: 4 },
  belt: { scan: TWO },
  smoke: { scan: ONE, focus: "src", smoke: true },
  pennant: { scan: TWO, focus: "app" },
};

export function legend(palette: Palette, reduced: boolean) {
  const figures = [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-figure]")].map((canvas) => {
    const { scan, focus, hatch, smoke } = FIGURES[canvas.dataset.figure!]!;
    const layout = plan(scan, new Set(), false);
    const scene: Scene = build(layout);
    aim(scene, layout.frames[0]!, true);
    const centre = scene.machines.find((machine) => machine.name === focus);
    if (centre && hatch !== undefined) scene.hot = { machine: centre.id, hatch };
    if (centre && smoke && reduced) centre.puffs = [...STILL_PUFFS];
    return { canvas, ctx: canvas.getContext("2d")!, scene, centre, smoke, sinceCommit: PUFF_EVERY };
  });
  if (!figures.length) return;

  function draw(dt: number) {
    const dpr = window.devicePixelRatio || 1;
    for (const figure of figures) {
      const { canvas, ctx, scene, centre } = figure;
      const [width, height] = [canvas.clientWidth, canvas.clientHeight];
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      if (figure.smoke && (figure.sinceCommit += dt) >= PUFF_EVERY) {
        figure.sinceCommit = 0;
        centre!.owed = PUFFS;
      }
      advance(scene, dt, 1, !reduced);
      let view: View | undefined;
      if (centre) {
        // Put the middle of the machine, chimney included, in the middle of the figure.
        const [x, y] = screen({ k: SCALE, ox: 0, oy: 0 }, centre.x, centre.y, centre.size.h / 2 + CHIMNEY_HALF);
        view = { k: SCALE, ox: width / 2 - x, oy: height / 2 - y };
      } else view = fit(scene, width, height, { left: PAD, right: PAD, top: PAD, bottom: PAD }, SCALE);
      if (!view) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      paint(ctx, scene, view, palette);
    }
  }

  // Still under reduced motion; otherwise the figures run only while they are on screen.
  if (reduced) return new ResizeObserver(() => draw(0)).observe(figures[0]!.canvas);
  let then = 0;
  let pending = 0;
  const frame = (now: number) => {
    draw(Math.min(now - then, MAX_FRAME));
    then = now;
    pending = requestAnimationFrame(frame);
  };
  new IntersectionObserver((entries) => {
    cancelAnimationFrame(pending);
    if (!entries.some((entry) => entry.isIntersecting)) return;
    then = performance.now();
    pending = requestAnimationFrame(frame);
  }).observe(figures[0]!.canvas.closest("section") ?? figures[0]!.canvas);
}
