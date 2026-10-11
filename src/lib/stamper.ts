// The stamp dialog: draws the stamp of whatever the factory shows, lets its look be changed, saves it
// as an image and copies a link that carries it. A page opened from such a link shows both stamps.
import { shown } from "./app";
import { palette } from "./ink";
import { blueprintOf, pack, paintStamp, rankOf, sceneOf, scoreOf, STATS, unpack, type Blueprint, type Look, type Stat } from "./stamp";
import type { Scene } from "./factory";

const SQUARE = [1080, 1080] as const; // px the image is saved at: what a post shows without cropping
const WIDE = [1600, 900] as const; // 16:9, for a link card or a header
const LINK = "#vs-"; // what a challenge link's fragment starts with
const COPIED = 1600; // ms the button says so

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("stamp");
const form = $<HTMLFormElement>("stamp-look");
const title = $<HTMLInputElement>("stamp-title");
const verdict = $("stamp-verdict");
const answer = $("stamp-answer");
const copy = $("stamp-link");
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

type Sheet = { canvas: HTMLCanvasElement; blueprint: Blueprint; scene: Scene };
const sheet = (id: string, blueprint: Blueprint): Sheet => ({ canvas: $<HTMLCanvasElement>(id), blueprint, scene: sceneOf(blueprint) });

/** The stamp a challenge link carries, if the page was opened from one. */
const rival = location.hash.startsWith(LINK) ? unpack(location.hash.slice(LINK.length)) : undefined;
const theirs = rival && sheet("stamp-theirs", rival.blueprint);
$("stamp-rival").hidden = !theirs;
let mine: Sheet | undefined;
let of: unknown; // the scan `mine` was made from

const look = (): Look => ({ title: title.value.trim(), paper: field("paper").value, ink: field("ink").value, accent: field("accent").value });
const describe = (name: string, blueprint: Blueprint) => `${name}: ${rankOf(scoreOf(blueprint))}, ${scoreOf(blueprint).toLocaleString("en")} points`;

function render() {
  if (!mine) return;
  const [width, height] = field("shape").checked ? WIDE : SQUARE;
  const shows = STATS.filter((stat) => field(stat).checked) as Stat[];
  for (const [each, its] of [[mine, look()], [theirs, rival?.look]] as const) {
    if (!each || !its) continue;
    each.canvas.width = width;
    each.canvas.height = height;
    paintStamp(each.canvas.getContext("2d")!, each.scene, each.blueprint, its, shows, width, height, palette);
    each.canvas.setAttribute("aria-label", describe(its.title || "A factory", each.blueprint));
  }
  if (!theirs) return;
  // Against the sample there is nothing to settle yet.
  const sampled = shown().sampled;
  answer.hidden = !sampled;
  const lead = scoreOf(mine.blueprint) - scoreOf(theirs.blueprint);
  const points = `${Math.abs(lead).toLocaleString("en")} ${Math.abs(lead) === 1 ? "point" : "points"}`;
  verdict.textContent = sampled ? "This is a sample. Open your own repo to answer." : lead > 0 ? `Yours is bigger by ${points}.` : lead < 0 ? `Theirs is bigger by ${points}.` : "Dead level.";
}

/** `keyed` opens it without motion: nothing started from the keyboard animates. */
function open(keyed: boolean) {
  const { scan, plan } = shown();
  if (of !== scan) {
    // A new repo: its own factory and its own name. Colours and choices carry over.
    mine = sheet("stamp-mine", blueprintOf(plan, scan.commits));
    title.value = scan.name;
    of = scan;
  }
  dialog.toggleAttribute("data-keyed", keyed);
  if (!dialog.open) dialog.showModal();
  render();
}

form.addEventListener("input", render);
form.addEventListener("submit", (event) => event.preventDefault());
void document.fonts?.ready.then(render); // text drawn before the webfont lands is in the fallback face
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-stamp]")) button.addEventListener("click", (event) => open(event.detail === 0));
$("stamp-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close(); // the backdrop is the dialog's own box outside its content
});
answer.addEventListener("click", () => dialog.close()); // the folder is read in the tool behind

$("stamp-save").addEventListener("click", () => {
  mine?.canvas.toBlob((blob) => {
    if (!blob) return;
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${look().title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "factory"}-stamp.png` });
    link.click();
    URL.revokeObjectURL(link.href);
  });
});

let reverting = 0;
copy.addEventListener("click", async () => {
  if (!mine) return;
  const url = `${location.origin}${location.pathname}${LINK}${pack(mine.blueprint, look())}`;
  const shownLink = $<HTMLInputElement>("stamp-url");
  try {
    await navigator.clipboard.writeText(url);
    copy.toggleAttribute("data-done", true);
    clearTimeout(reverting);
    reverting = window.setTimeout(() => copy.toggleAttribute("data-done", false), COPIED);
  } catch {
    // No clipboard here, as inside some frames: show the link, selected, to be copied by hand.
    shownLink.hidden = false;
    shownLink.value = url;
    shownLink.select();
  }
});

// A page opened from a link shows the challenge at once, and again when the visitor's own repo is drawn.
if (theirs) open(true);
document.addEventListener("factory:drawn", () => {
  if (theirs && !shown().sampled) open(true);
});
