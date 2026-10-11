// The page's colours, read once from its tokens, and the visitor's motion preference.
import type { Palette } from "./factory";

const tokens = getComputedStyle(document.documentElement);
// The build may shorten #aabbcc to #abc, so both spellings are read and the short one is widened.
const hexes = (token: string) => (tokens.getPropertyValue(token).match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? []).map((hex) => (hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}` : hex));
const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const paper = channels(hexes("--bg")[0]!);
const ink = channels(hexes("--ink")[0]!);

/** Everything the factory paints with. The canvas cannot read CSS, so the tokens are handed to it here. */
export const palette: Palette = {
  shade: (strength) => `rgb(${paper.map((channel, index) => Math.round(channel + (ink[index]! - channel) * strength)).join()})`,
  kraft: ["--kraft-1", "--kraft-2", "--kraft-3"].map((token) => hexes(token) as Palette["kraft"][number]),
  tape: hexes("--tape")[0]!,
  labels: hexes("--labels"),
};
export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
