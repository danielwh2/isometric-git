// Path arithmetic inside a dropped repo: "/" separated, relative to its root, never leaving it.
export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Undefined when the path climbs out of the repo. */
export function join(base: string, relative: string): string | undefined {
  const parts = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** join for paths a manifest wrote: an absolute one ("/x", "C:") is refused and "\" reads as "/". */
export const joinStrict = (base: string, relative: string) => (relative.startsWith("/") || /^[A-Za-z]:/.test(relative) ? undefined : join(base, relative.replaceAll("\\", "/")));
