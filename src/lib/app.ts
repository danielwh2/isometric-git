// The page: takes a dropped folder, scans it, and runs the factory with a camera, a transport and an inspector.
// The factory sits in the page until it is expanded, and only then takes the wheel.
import { advance, aim, build, fit, hatchAt, light, machineAt, paint, settleTime, spring, tagPoint, type Scene, type Spring, type View } from "./factory";
import sample from "../data/sample.json";
import type { Folder } from "./git";
import { palette, reduced } from "./ink";
import { filesAt, mergeWords, plan as makePlan, plural, rosterOf, tally, type FileState, type Plan } from "./plan";
import { IGNORED, scanFiles, scanGit, wanted, type Progress, type Scan } from "./scan";

const STEP = 700; // ms a step holds at 1x, on top of what its construction needs
const MAX_FRAME = 64; // ms. A longer gap is a tab coming back, not a frame.
const PAD = { left: 28, right: 28, top: 56, bottom: 48 }; // px kept clear around the factory: tags above, the zoom buttons below
const TAG_LIFT = 5; // px between a chimney and its tag
const CLOSEST = 48; // px per unit at 100%. The camera never frames closer than this by itself.
const ZOOM_MIN = CLOSEST * 0.1; // zoom runs 10% to 400%, as in Figma
const ZOOM_MAX = CLOSEST * 4;
const WHEEL_CAP = 48; // deltaY past this is a flick; capping it makes a flick step, not jump
const ZOOM_RATE = Math.log(1.6) / WHEEL_CAP; // one capped tick zooms 1.6x
const BUTTON_ZOOM = 1.4;
const CAMERA_STIFF = 6; // settles in about a second: slower than construction, so the frame trails the build
const DRAG_SLOP = 4; // px a press may wander and still be a click
const TAG_GAP = 3; // px kept clear between two tags
const TAG_DOT = 8; // px a tag grows by when it carries the dot for a changed folder
const FILE_ROWS = 300; // ponytail: the inspector lists this many files and counts the rest. Virtualise if anyone needs to scroll 2,000.
const PACES = [[40, 1], [90, 2]] as const; // [steps a replay may have, the speed it starts at]
const FASTEST = 4;
const AT_ONCE = 1e6; // ms: a step long enough to land any spring where it is going
const FOLDED_NAMES = 12; // folded-in folders named before the rest are counted
const SPLIT_AT_ONCE = 8; // folders one press of Split out stands up, largest first. All of them at once could be hundreds of machines.
const SHEET_SHARE = 0.6; // an inspector wider than this share of the stage is a bottom sheet, not a side panel

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tool = $("tool");
const stage = $("stage");
const canvas = $<HTMLCanvasElement>("factory");
const ctx = canvas.getContext("2d")!;
const range = $<HTMLInputElement>("commit");
const play = $("play");
const pace = $<HTMLSelectElement>("pace");
const inspector = $("inspector");
const notice = $("notice");
const tip = $("tip");
const picker = $<HTMLInputElement>("picker");

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024).toLocaleString("en")} kB`);
const leaf = (path: string) => (path === "." ? "./" : path.split("/").at(-1)!);
const still = (at = 0): Spring => ({ at, speed: 0 });
const row = (...cells: string[]) => {
  const item = document.createElement("li");
  item.append(...cells.map((text) => Object.assign(document.createElement("span"), { textContent: text })));
  return item;
};

let scan: Scan;
let plan: Plan;
let scene: Scene;
let split = new Set<string>(); // folders the user asked to stand as their own machines
let sampled = true; // the factory on screen is the built-in sample, not the visitor's repo
let at = 0;
let hovered: number | undefined;
let opened: number | undefined; // the machine in the inspector
let state: { at: number; files: FileState; rosters: Map<number, number[]> } | undefined; // files alive at the step shown, read on demand
let tags: HTMLButtonElement[] = [];
let tagSizes: { wide: number; tall: number }[] = []; // measured once, so placing tags never reads layout in a frame
let subjects: HTMLElement[] = [];

const camera = { k: still(1), ox: still(), oy: still() };
let framing: View = { k: 1, ox: 0, oy: 0 };
let follow = true; // the camera frames the factory until the user moves it
let width = 0;
let height = 0;
let playing = false;
let held = 0; // ms of replay time the step shown has had
let holdFor = STEP;
let looping = false;
let pending = 0; // the queued frame, so the loop can never run twice
let then = 0;

/** What is on screen, for the stamp. "factory:drawn" fires on the document each time a repo is loaded. */
export const shown = () => ({ scan, plan, sampled });

const view = (): View => ({ k: camera.k.at, ox: camera.ox.at, oy: camera.oy.at });
const last = () => plan.frames.length - 1;
const speed = () => Number(pace.value);

// ---- the step shown ----

function alive(): NonNullable<typeof state> {
  if (state?.at !== at) state = { at, files: filesAt(scan, at), rosters: new Map() };
  return state;
}

/** A machine's files in the order of its roof hatches. */
function roster(machine: number): number[] {
  const { files, rosters } = alive();
  let found = rosters.get(machine);
  if (!found) {
    found = rosterOf(scan, files, plan.home, machine);
    rosters.set(machine, found);
  }
  return found;
}

function relight() {
  const lit = hovered ?? opened;
  light(scene, lit);
  tags.forEach((tag, id) => {
    tag.toggleAttribute("data-lit", lit !== undefined && scene.machines[id]!.inkGoal === 1);
    tag.toggleAttribute("data-dim", scene.machines[id]!.inkGoal !== 1);
  });
}

function show(index: number, jump: boolean) {
  at = index;
  const frame = plan.frames[at]!;
  const step = scan.steps[at]!;
  aim(scene, frame, jump);
  if (opened !== undefined && !scene.machines[opened]!.exists) opened = undefined;
  if (hovered !== undefined && !scene.machines[hovered]!.exists) hovered = undefined;
  relight();
  inspect(); // before the camera is aimed: a machine that is gone takes its inspector, and the room it took, with it
  reframe(jump);

  range.value = String(at);
  range.setAttribute("aria-valuetext", `Step ${at + 1} of ${plan.frames.length}: ${step.subject}${step.merge === undefined ? "" : `, ${mergeWords(step.merge)}`}`);
  $("at").textContent = `${at + 1} / ${plan.frames.length}`;
  $("hash").textContent = step.hash;
  $("date").textContent = step.date;
  subjects.forEach((line, nth) => line.toggleAttribute("data-on", nth === at));
  tags.forEach((tag, id) => {
    tag.hidden = !scene.machines[id]!.exists;
    tag.toggleAttribute("data-touched", frame.touched.has(id));
  });

  $("repo").textContent = sampled ? `${scan.name}, a sample` : scan.name;
  $("counts").textContent = tally(frame);
  $("commits").textContent = scan.commits > plan.frames.length ? `commit ${step.nth.toLocaleString("en")} of ${scan.commits.toLocaleString("en")}` : "";
}

/** Starts a scan on screen. `replay` builds it up from the first step instead of showing it finished. */
function load(next: Scan, replay: boolean) {
  scan = next;
  split = new Set();
  opened = hovered = state = undefined;
  subjects = scan.steps.map((step) => {
    const line = Object.assign(document.createElement("p"), { textContent: step.subject });
    if (step.merge !== undefined) line.append(Object.assign(document.createElement("span"), { className: "merge", textContent: mergeWords(step.merge) }));
    return line;
  });
  // Every subject shares one grid cell, so the tallest sets the height and scrubbing moves nothing.
  $("subjects").replaceChildren(...subjects);
  replan();
  range.max = String(last());
  // A long history starts faster, so a replay stays under a minute or so.
  pace.value = String(PACES.find(([steps]) => plan.frames.length <= steps)?.[1] ?? FASTEST);
  follow = true;
  if (replay && !reduced) {
    show(0, false);
    reframe(true);
    start();
  } else show(last(), true);
  document.dispatchEvent(new Event("factory:drawn"));
}

/** Lays the factory out again, after a new scan or a split. */
function replan() {
  const keep = opened === undefined ? undefined : plan.machines[opened]!.name;
  plan = makePlan(scan, split);
  scene = build(plan);
  state = undefined;
  tags = plan.machines.map((machine) => {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "tag";
    tag.textContent = leaf(machine.name);
    tag.setAttribute("aria-label", `Open ${machine.name}`);
    tag.addEventListener("click", () => open(machine.id));
    tag.addEventListener("focus", () => hover(machine.id));
    tag.addEventListener("blur", () => hover(undefined));
    tag.addEventListener("pointerenter", () => hover(machine.id));
    tag.addEventListener("pointerleave", () => hover(document.activeElement === tag ? machine.id : undefined));
    return tag;
  });
  $("tags").replaceChildren(...tags);
  measureTags();
  opened = plan.machines.find((machine) => machine.name === keep)?.id;
}

function measureTags() {
  tagSizes = tags.map((tag) => ({ wide: tag.offsetWidth + TAG_DOT, tall: tag.offsetHeight }));
}
void document.fonts?.ready.then(measureTags); // the webfont changes every tag's width when it lands

// ---- hover, tip and inspector ----

function hover(machine: number | undefined, hatch?: number, px = 0, py = 0) {
  scene.hot = machine !== undefined && hatch !== undefined ? { machine, hatch } : undefined;
  if (machine !== hovered) {
    hovered = machine;
    relight();
    canvas.style.cursor = machine === undefined ? "" : "pointer";
  }
  tip.hidden = machine === undefined || !px;
  if (tip.hidden) return;
  const file = hatch === undefined ? undefined : roster(machine!)[hatch];
  const size = plan.frames[at]!.sizes[machine!]!;
  const settled = file !== undefined && scan.steps[at]!.contested?.includes(file) ? "  both branches changed it" : "";
  tip.textContent = file === undefined ? `${plan.machines[machine!]!.name}  ${plural(size.files, "file")}` : `${leaf(scan.paths[file]!)}  ${kb(alive().files.get(file)!.bytes)}${settled}`;
  tip.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
}

function open(machine: number | undefined) {
  // Focus follows only when it was on a tag or in the inspector: a click on the canvas leaves it alone.
  const focused = document.activeElement;
  const keyed = tags.includes(focused as HTMLButtonElement) || inspector.contains(focused);
  const was = opened;
  opened = machine;
  relight();
  inspect();
  reframe(false);
  if (!keyed) return;
  if (machine !== undefined) $("i-close").focus();
  else if (was !== undefined) tags[was]!.focus();
}

function inspect() {
  inspector.hidden = opened === undefined;
  if (opened === undefined) return;
  const machine = plan.machines[opened]!;
  const { files } = alive();
  const mine = roster(opened);
  const frame = plan.frames[at]!;
  $("i-name").textContent = machine.name;
  $("i-size").textContent = `${plural(mine.length, "file")}, ${kb(mine.reduce((sum, file) => sum + files.get(file)!.bytes, 0))}`;

  const neighbours = (side: "from" | "to") => {
    const other = side === "from" ? "to" : "from";
    const rows = [...frame.belts].flatMap(([index, count]) => (plan.belts[index]![other] === opened ? [[plan.belts[index]![side], count] as const] : [])).sort((p, q) => q[1] - p[1]);
    if (!rows.length) return [row("nothing")];
    return rows.map(([id, count]) => {
      const item = document.createElement("li");
      const jump = Object.assign(document.createElement("button"), { type: "button", textContent: plan.machines[id]!.name });
      jump.addEventListener("click", () => open(id));
      item.append(jump, Object.assign(document.createElement("span"), { textContent: plural(count, "import") }));
      return item;
    });
  };
  $("i-takes").replaceChildren(...neighbours("from"));
  $("i-feeds").replaceChildren(...neighbours("to"));

  const importers = new Map<number, number>();
  for (const { imports } of files.values()) for (const target of imports) importers.set(target, (importers.get(target) ?? 0) + 1);
  const prefix = machine.name === "." ? "" : `${machine.name}/`;
  const rows = mine.slice(0, FILE_ROWS).map((file, hatch) => {
    const path = scan.paths[file]!;
    // In a repo drawn a machine per file, the machine is named for the file itself.
    const item = row(path === machine.name ? leaf(path) : path.slice(prefix.length), kb(files.get(file)!.bytes), `takes ${files.get(file)!.imports.length}, feeds ${importers.get(file) ?? 0}`);
    item.addEventListener("pointerenter", () => (scene.hot = { machine: machine.id, hatch }));
    item.addEventListener("pointerleave", () => (scene.hot = undefined));
    return item;
  });
  if (mine.length > FILE_ROWS) rows.push(row(`and ${plural(mine.length - FILE_ROWS, "more file")}`));
  $("i-files").replaceChildren(...rows);

  $("i-merged-wrap").hidden = !machine.merged.length;
  const folded = machine.merged.map((folder) => folder.slice(prefix.length));
  $("i-merged").textContent = folded.length > FOLDED_NAMES ? `${folded.slice(0, FOLDED_NAMES).join(", ")} and ${folded.length - FOLDED_NAMES} more` : folded.join(", ");
}

// ---- camera ----

function reframe(jump: boolean) {
  if (!width) return;
  const pad = { ...PAD };
  if (!inspector.hidden) {
    if (inspector.offsetWidth > width * SHEET_SHARE) pad.bottom += inspector.offsetHeight;
    else pad.right += inspector.offsetWidth;
  }
  framing = fit(scene, width, height, pad, CLOSEST) ?? framing;
  if (jump && follow) for (const axis of ["k", "ox", "oy"] as const) camera[axis] = still(framing[axis]); // a camera the user has taken stays where they put it
}

/** The user took the camera: it stops following until Fit. */
function steer(move: () => void) {
  follow = false;
  for (const axis of ["k", "ox", "oy"] as const) camera[axis].speed = 0;
  move();
}

function zoomAt(px: number, py: number, factor: number) {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.k.at * factor));
  // Keep the world point under the cursor where it is.
  camera.ox.at = px - ((px - camera.ox.at) * k) / camera.k.at;
  camera.oy.at = py - ((py - camera.oy.at) * k) / camera.k.at;
  camera.k.at = k;
}

// ---- the loop ----

function start() {
  playing = true;
  held = 0;
  holdFor = STEP + settleTime(scene);
  play.textContent = "Pause";
}

function stop() {
  playing = false;
  play.textContent = at === last() ? "Replay" : "Play";
}

function frame(now: number) {
  const dt = Math.min(now - then, MAX_FRAME);
  then = now;
  if (playing && (held += dt * speed()) >= holdFor) {
    if (at < last()) {
      show(at + 1, reduced);
      start();
    } else stop();
  }
  advance(scene, dt, speed(), !reduced);
  if (follow) for (const axis of ["k", "ox", "oy"] as const) spring(camera[axis], framing[axis], reduced ? AT_ONCE : dt, CAMERA_STIFF);
  draw();
  pending = looping ? requestAnimationFrame(frame) : 0;
}

function draw() {
  if (!width) return;
  const dpr = window.devicePixelRatio || 1;
  // Checked every frame, not only on resize: the ratio changes when the window moves to another screen or the page is zoomed.
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const seen = view();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  paint(ctx, scene, seen, palette);
  // Tags go down most important first: those in use, then the biggest machines.
  // One that would cover a tag already down stays hidden, so no two ever overlap.
  const down: [left: number, top: number, right: number, bottom: number][] = [];
  const order = scene.machines.filter((machine) => !tags[machine.id]!.hidden).sort((p, q) => Number(tags[q.id]!.hasAttribute("data-lit")) - Number(tags[p.id]!.hasAttribute("data-lit")) || q.size.files - p.size.files);
  for (const machine of order) {
    const tag = tags[machine.id]!;
    const [px, py] = tagPoint(seen, machine);
    const { wide, tall } = tagSizes[machine.id]!;
    const box: (typeof down)[number] = [px - wide / 2 - TAG_GAP, py - TAG_LIFT - tall - TAG_GAP, px + wide / 2 + TAG_GAP, py - TAG_LIFT + TAG_GAP];
    const building = machine.rise < 1;
    const crowded = !building && down.some(([left, top, right, bottom]) => box[0] < right && box[2] > left && box[1] < bottom && box[3] > top);
    if (!building && !crowded) down.push(box);
    const transform = `translate(${Math.round(px)}px, ${Math.round(py - TAG_LIFT)}px) translate(-50%, -100%)`;
    if (tag.style.transform !== transform) tag.style.transform = transform;
    tag.toggleAttribute("data-building", building);
    tag.toggleAttribute("data-crowded", crowded);
  }
}

// The sample is on screen before anything is measured or drawn.
load(sample as unknown as Scan, false);

new ResizeObserver(() => {
  width = stage.clientWidth;
  height = stage.clientHeight;
  reframe(follow);
  draw(); // sizing a canvas clears it, and tags must be placed before the first paint
}).observe(stage);

// The loop runs only while the factory is on screen.
new IntersectionObserver(([entry]) => {
  if (entry!.isIntersecting === looping) return;
  looping = entry!.isIntersecting;
  if (!looping) return;
  then = performance.now();
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(frame);
}).observe(stage);

// ---- pointer: hover, click to open, drag to pan, pinch to zoom ----

const fingers = new Map<number, { x: number; y: number }>();
let press: { x: number; y: number; dragged: boolean } | undefined;
const local = (event: PointerEvent | WheelEvent) => {
  const box = canvas.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
};
const spread = () => {
  const [p, q] = [...fingers.values()];
  return { x: (p!.x + q!.x) / 2, y: (p!.y + q!.y) / 2, apart: Math.hypot(p!.x - q!.x, p!.y - q!.y) };
};

canvas.addEventListener("pointerdown", (event) => {
  if (event.button) return; // only the main button pans and opens
  canvas.setPointerCapture(event.pointerId);
  fingers.set(event.pointerId, local(event));
  press = { ...local(event), dragged: fingers.size > 1 };
});
canvas.addEventListener("pointermove", (event) => {
  const point = local(event);
  if (!fingers.has(event.pointerId)) {
    const machine = machineAt(scene, view(), point.x, point.y);
    return hover(machine, machine === undefined ? undefined : hatchAt(scene.machines[machine]!, view(), point.x, point.y), point.x, point.y);
  }
  const grip = () => (fingers.size === 2 ? spread() : { ...fingers.get(event.pointerId)!, apart: 0 });
  const before = grip();
  fingers.set(event.pointerId, point);
  const after = grip();
  if (press && !press.dragged && Math.hypot(point.x - press.x, point.y - press.y) < DRAG_SLOP) return;
  if (press) press.dragged = true;
  hover(undefined);
  steer(() => {
    camera.ox.at += after.x - before.x;
    camera.oy.at += after.y - before.y;
    if (before.apart) zoomAt(after.x, after.y, after.apart / before.apart);
  });
});
const release = (event: PointerEvent) => {
  fingers.delete(event.pointerId);
  if (fingers.size) return;
  if (press && !press.dragged && event.type === "pointerup") open(machineAt(scene, view(), press.x, press.y));
  press = undefined;
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);
canvas.addEventListener("pointerleave", () => hover(undefined));

const expanded = () => tool.hasAttribute("data-expanded");
stage.addEventListener(
  "wheel",
  (event) => {
    if (inspector.contains(event.target as Node)) return; // the inspector scrolls itself
    const zooming = event.ctrlKey || event.metaKey; // a pinch arrives as a ctrl wheel
    if (!expanded() && !zooming) return; // in the page, the wheel scrolls the page
    event.preventDefault();
    const point = local(event);
    steer(() => {
      if (zooming) zoomAt(point.x, point.y, Math.exp(-Math.max(-WHEEL_CAP, Math.min(WHEEL_CAP, event.deltaY)) * ZOOM_RATE));
      else {
        camera.ox.at -= event.deltaX;
        camera.oy.at -= event.deltaY;
      }
    });
  },
  { passive: false },
);

$("fit").addEventListener("click", (event) => {
  follow = true;
  reframe(event.detail === 0 || reduced); // from the keyboard it lands at once
});
$("zoom-in").addEventListener("click", () => steer(() => zoomAt(width / 2, height / 2, BUTTON_ZOOM)));
$("zoom-out").addEventListener("click", () => steer(() => zoomAt(width / 2, height / 2, 1 / BUTTON_ZOOM)));
$("i-close").addEventListener("click", () => open(undefined));
$("i-split").addEventListener("click", () => {
  const paths = [...alive().files.keys()].map((file) => scan.paths[file]!);
  const weight = (folder: string) => paths.filter((path) => path.startsWith(`${folder}/`)).length;
  const largest = plan.machines[opened!]!.merged.map((folder) => [folder, weight(folder)] as const).sort((p, q) => q[1] - p[1]);
  for (const [folder] of largest.slice(0, SPLIT_AT_ONCE)) split.add(folder);
  replan();
  show(at, true);
  $("i-close").focus(); // the button just pressed is gone
});
function expand(on: boolean) {
  tool.toggleAttribute("data-expanded", on);
  for (const sibling of tool.parentElement!.children) if (sibling !== tool) sibling.toggleAttribute("inert", on); // the page behind is out of reach, for the keyboard too
  document.documentElement.toggleAttribute("data-locked", on); // the page behind stops scrolling
  $("expand").textContent = on ? "Collapse" : "Expand";
}
$("expand").addEventListener("click", () => expand(!expanded()));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return; // a dialog takes its own Escape
  if (opened !== undefined) open(undefined);
  else if (expanded()) expand(false);
});

// ---- transport ----

let keyed = false; // the scrubber was last moved from the keyboard, which never animates
range.addEventListener("keydown", () => (keyed = true));
range.addEventListener("pointerdown", () => (keyed = false));
range.addEventListener("input", () => {
  show(Number(range.value), keyed || reduced);
  stop();
});
play.addEventListener("click", () => {
  if (playing) return stop();
  if (at === last()) {
    scene = build(plan); // bare ground, so the first step is built rather than shown
    show(0, reduced);
    follow = true;
    reframe(true);
  }
  start();
});

// ---- getting a folder in ----

type Dropped = { name: string; file(path: string): Promise<File | undefined>; list(path: string): Promise<{ name: string; folder: boolean }[]> };

/** A folder dragged onto the page. Nothing is read until it is asked for. */
function fromEntry(root: FileSystemDirectoryEntry): Dropped {
  const find = (path: string, folder: boolean) =>
    new Promise<FileSystemEntry | undefined>((done) => {
      if (!path) done(root);
      else if (folder) root.getDirectory(path, {}, done, () => done(undefined));
      else root.getFile(path, {}, done, () => done(undefined));
    });
  return {
    name: root.name,
    async file(path) {
      const entry = (await find(path, false)) as FileSystemFileEntry | undefined;
      return entry && new Promise<File | undefined>((done) => entry.file(done, () => done(undefined)));
    },
    async list(path) {
      const entry = (await find(path, true)) as FileSystemDirectoryEntry | undefined;
      if (!entry) return [];
      const reader = entry.createReader();
      const found: { name: string; folder: boolean }[] = [];
      for (;;) {
        // readEntries hands a folder over in batches and an empty batch ends it.
        const batch = await new Promise<FileSystemEntry[]>((done) => reader.readEntries(done, () => done([])));
        if (!batch.length) return found;
        found.push(...batch.map((child) => ({ name: child.name, folder: child.isDirectory })));
      }
    },
  };
}

/** A folder chosen with the browser's own folder picker, where it has one. Nothing is read until it is asked for. */
function fromHandle(root: FileSystemDirectoryHandle): Dropped {
  const folders = new Map<string, Promise<FileSystemDirectoryHandle>>(); // .git/objects is asked for thousands of times
  const folder = (path: string): Promise<FileSystemDirectoryHandle> => {
    if (!path) return Promise.resolve(root);
    if (!folders.has(path)) {
      const cut = path.lastIndexOf("/");
      folders.set(path, folder(path.slice(0, Math.max(0, cut))).then((parent) => parent.getDirectoryHandle(path.slice(cut + 1))));
    }
    return folders.get(path)!;
  };
  return {
    name: root.name,
    async file(path) {
      const cut = path.lastIndexOf("/");
      try {
        return await (await (await folder(path.slice(0, Math.max(0, cut)))).getFileHandle(path.slice(cut + 1))).getFile();
      } catch {
        return undefined; // not there
      }
    },
    async list(path) {
      const found: { name: string; folder: boolean }[] = [];
      try {
        for await (const [name, handle] of (await folder(path)) as unknown as AsyncIterable<[string, FileSystemHandle]>) found.push({ name, folder: handle.kind === "directory" });
      } catch {
        return []; // not there
      }
      return found;
    },
  };
}

/** A folder chosen with the file input, which hands over every file in it at once. */
function fromPicker(files: FileList): Dropped {
  const byPath = new Map<string, File>();
  const folders = new Map<string, Map<string, boolean>>();
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/").slice(1);
    byPath.set(parts.join("/"), file);
    parts.forEach((part, depth) => {
      const parent = parts.slice(0, depth).join("/");
      if (!folders.has(parent)) folders.set(parent, new Map());
      folders.get(parent)!.set(part, depth < parts.length - 1);
    });
  }
  return {
    name: files[0]?.webkitRelativePath.split("/")[0] ?? "folder",
    file: async (path) => byPath.get(path),
    list: async (path) => [...(folders.get(path) ?? [])].map(([name, folder]) => ({ name, folder })),
  };
}

function gitFolder(dropped: Dropped): Folder {
  const packs = new Map<string, Promise<File | undefined>>(); // packfiles are sliced thousands of times; look each up once
  const file = (path: string) => {
    if (!path.startsWith("objects/pack/")) return dropped.file(`.git/${path}`);
    if (!packs.has(path)) packs.set(path, dropped.file(`.git/${path}`));
    return packs.get(path)!;
  };
  return {
    async read(path, start, end) {
      const found = await file(path);
      return found && new Uint8Array(await (start === undefined ? found : found.slice(start, end)).arrayBuffer());
    },
    size: async (path) => (await file(path))?.size,
    list: async (path) => (await dropped.list(`.git/${path}`)).map((entry) => entry.name),
  };
}

async function sourceFiles(dropped: Dropped, folder = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await dropped.list(folder)) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (!entry.folder) {
      if (wanted(path)) found.push(path);
    } else if (!IGNORED.has(entry.name) && !entry.name.startsWith(".")) found.push(...(await sourceFiles(dropped, path)));
  }
  return found;
}

/** `count` is the part that changes many times a second. It is shown but not read out, so a screen reader hears each phase once. */
function say(text: string, progress?: number, count = "") {
  notice.hidden = false;
  if ($("notice-text").textContent !== text) $("notice-text").textContent = text;
  $("notice-count").textContent = count;
  const bar = $<HTMLProgressElement>("notice-bar");
  bar.hidden = progress === undefined;
  if (progress !== undefined) bar.value = progress;
  $("notice-close").hidden = reading; // a result can be dismissed, progress cannot
}
$("notice-close").addEventListener("click", () => (notice.hidden = true));

let reading = false;
async function take(dropped: Dropped) {
  if (reading) return;
  reading = true;
  for (const button of openers) button.disabled = true;
  say(`Reading ${dropped.name}`);
  tool.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" }); // the button may be a screen away from the progress
  const progress: Progress = (phase, done, total) => {
    if (phase === "history") say(`Walking back through ${dropped.name}:`, undefined, `${done.toLocaleString("en")} commits`);
    else say(`Reading ${dropped.name}:`, done / total, `${done} of ${total}`);
  };
  try {
    let next: Scan | undefined;
    if (await dropped.file(".git/HEAD")) next = await scanGit(gitFolder(dropped), dropped.name, progress);
    else if (await dropped.file(".git")) return say(`${dropped.name} is a git worktree or submodule, so its history lives in another folder. Drop the main checkout.`);
    if (!next) {
      const paths = await sourceFiles(dropped);
      next = await scanFiles(dropped.name, paths.map((path) => ({ path, read: async () => new Uint8Array(await (await dropped.file(path))!.arrayBuffer()) })), progress);
    }
    if (!next.steps.length || !next.paths.length) return say(`No source files found in ${dropped.name}.`);
    sampled = false;
    notice.hidden = true;
    load(next, true);
    if (next.midway) say(`${dropped.name} is halfway through a ${next.midway}. This is its last commit: the changes still to be committed are not drawn.`);
  } catch (error) {
    say(`Could not read ${dropped.name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    reading = false;
    for (const button of openers) button.disabled = false;
    $("notice-close").hidden = false;
  }
}

let over = 0; // dragenter and dragleave fire per element, so count them
addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return; // dragged text is not a folder
  event.preventDefault();
  over += 1;
  $("dropzone").hidden = false;
});
addEventListener("dragleave", () => {
  over = Math.max(0, over - 1);
  $("dropzone").hidden = !over;
});
addEventListener("dragover", (event) => event.preventDefault());
addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return; // dragged text is not a folder
  event.preventDefault();
  over = 0;
  $("dropzone").hidden = true;
  const entry = [...(event.dataTransfer?.items ?? [])].map((item) => item.webkitGetAsEntry()).find((found) => found?.isDirectory);
  if (entry) void take(fromEntry(entry as FileSystemDirectoryEntry));
  else say("Drop a folder, the one that holds .git.");
});
const openers = [...document.querySelectorAll<HTMLButtonElement>("[data-open]")];
// The browser's folder picker reads nothing until asked. The file input is the fallback: it lists the
// whole folder first, and Chrome words its prompt as an upload although nothing leaves the machine.
const pickFolder = (window as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker?.bind(window);
for (const button of openers) {
  button.addEventListener("click", async () => {
    if (!pickFolder) return picker.click();
    try {
      void take(fromHandle(await pickFolder()));
    } catch (error) {
      if ((error as Error).name !== "AbortError") picker.click(); // refused, as inside a frame. Closing the picker is an AbortError and needs nothing.
    }
  });
}
picker.addEventListener("change", () => {
  const first = picker.files?.[0];
  // A browser without folder picking hands over one loose file with no path.
  if (first && !first.webkitRelativePath) say("This browser cannot open a folder. Try a desktop browser.");
  else if (first) void take(fromPicker(picker.files!));
  picker.value = "";
});
