// A static Rust module graph. Cargo manifests locate crates; source files supply
// module declarations and use trees. Nothing is compiled or fetched.
import { parse } from "smol-toml";
import { dirname, joinStrict } from "./path";

type Table = Record<string, unknown>;
type Module = { scope: string[]; name: string; inline: boolean; path?: string };
type Use = { scope: string[]; path: string[] };
export type RustSource = { modules: Module[]; uses: Use[]; items: { scope: string[]; name: string }[] };
export type Cargo = Table;
const table = (value: unknown): Table => value && typeof value === "object" && !Array.isArray(value) ? value as Table : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const under = (path: string, home: string) => !home || path.startsWith(`${home}/`);
const nameOf = (name: string) => name.replaceAll("-", "_");
const MAX_DEPTH = 128; // also bounds damaged use trees and cyclic #[path] declarations

export function parseCargo(text: string): Cargo | undefined {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

type Token = { word: string; literal?: string };
const identifier = /^[\p{L}_][\p{L}\p{N}_]*$/u;
// `!` names a macro only after its name; `-> !` and `if !(x)` are not invocations.
const notMacros = new Set(["return", "in", "if", "while", "match", "else", "break", "let", "mut", "yield"]);
const macroBang = (before: string) => before === "#" || identifier.test(before) && !notMacros.has(before);

// Linear tokenization: nested comments, raw strings and character literals must
// not turn examples or documentation into imports. Lifetimes remain identifiers.
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (/\s/.test(char)) { at++; continue; }
    if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at + 2);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", at)) {
      at += 2;
      let depth = 1;
      while (at < text.length && depth) {
        if (text.startsWith("/*", at)) { depth++; at += 2; }
        else if (text.startsWith("*/", at)) { depth--; at += 2; }
        else at++;
      }
      continue;
    }
    const rawStart = char === "r" ? at : (char === "b" || char === "c") && text[at + 1] === "r" ? at + 1 : -1;
    if (rawStart >= 0) {
      let quote = rawStart + 1;
      while (text[quote] === "#") quote++;
      if (text[quote] === '"') {
        const endMark = '"' + "#".repeat(quote - rawStart - 1);
        const end = text.indexOf(endMark, quote + 1);
        out.push({ word: "string", literal: end < 0 ? undefined : text.slice(quote + 1, end) });
        at = end < 0 ? text.length : end + endMark.length;
        continue;
      }
    }
    if (char === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === "\\") at++;
        at++;
      }
      if (at < text.length) at++;
      let literal: string | undefined;
      try { literal = JSON.parse(text.slice(start, at)); } catch { /* an unsupported Rust escape */ }
      out.push({ word: "string", literal });
      continue;
    }
    if (char === "'") {
      // A char is one code point or escape followed by a quote; 'a is a lifetime.
      const match = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\])'/u.exec(text.slice(at, at + 32));
      if (match) { at += match[0].length; out.push({ word: "char" }); continue; }
    }
    const match = /^(?:r#)?[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(at));
    if (match) {
      out.push({ word: match[0].replace(/^r#/, "") });
      at += match[0].length;
    } else if (text.startsWith("::", at)) { out.push({ word: "::" }); at += 2; }
    else { out.push({ word: char }); at++; }
  }
  return out;
}

export function parseRust(text: string): RustSource {
  const source: RustSource = { modules: [], uses: [], items: [] };
  const input = tokens(text);
  let at = 0;
  const word = () => input[at]?.word;
  const skipGroup = () => {
    const close = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
    const stack = [close.get(word()!)];
    at++;
    while (at < input.length && stack.length) {
      const next = word()!;
      if (close.has(next)) stack.push(close.get(next));
      else if (next === stack[stack.length - 1]) stack.pop();
      at++;
    }
  };
  const useTree = (scope: string[], prefix: string[], depth: number) => {
    if (depth > MAX_DEPTH) { if (word() === "{") skipGroup(); return; }
    const path = [...prefix];
    if (word() === "::") { path.push(""); at++; }
    while (identifier.test(word() ?? "") || word() === "*") {
      path.push(word()!);
      at++;
      if (word() !== "::") break;
      at++;
    }
    if (word() === "{") {
      at++;
      while (at < input.length && word() !== "}") {
        const before = at;
        useTree(scope, path, depth + 1);
        if (word() === ",") at++;
        if (at === before) at++; // malformed input still makes progress
      }
      if (word() === "}") at++;
    } else if (path.length) {
      source.uses.push({ scope, path });
      let name = path[path.length - 1]!;
      if (name === "self") name = path[path.length - 2] ?? "self";
      if (word() === "as") { at++; name = word() ?? name; at++; }
      if (identifier.test(name) && name !== "_") source.items.push({ scope, name });
    }
  };
  // Braces belonging to functions and other items keep the surrounding module.
  const scopes: string[][] = [[]];
  let path: string | undefined;
  while (at < input.length) {
    const scope = scopes[scopes.length - 1]!;
    const next = word()!;
    if (next === "#" && input[at + 1]?.word === "[") {
      at++;
      if (input[at + 1]?.word === "path" && input[at + 2]?.word === "=") path = input[at + 3]?.literal;
      skipGroup();
    } else if (next === "mod" && identifier.test(input[at + 1]?.word ?? "") && [";", "{"].includes(input[at + 2]?.word ?? "")) {
      const name = input[at + 1]!.word;
      const inline = input[at + 2]!.word === "{";
      if (scope.length >= MAX_DEPTH) {
        at += 2;
        if (inline) skipGroup();
        else at++;
        path = undefined;
        continue;
      }
      source.modules.push({ scope, name, inline, path });
      path = undefined;
      at += 3;
      if (inline) scopes.push([...scope, name]);
    } else if (next === "use") {
      at++;
      useTree(scope, [], 0);
      path = undefined;
    } else if (next === "extern" && input[at + 1]?.word === "crate") {
      at += 2;
      useTree(scope, [], 0);
    } else if (next === "macro_rules" && input[at + 1]?.word === "!" && ["(", "[", "{"].includes(input[at + 3]?.word ?? "")) {
      if (identifier.test(input[at + 2]!.word)) source.items.push({ scope, name: input[at + 2]!.word });
      at += 3;
      skipGroup();
      path = undefined;
    } else if (next === "!" && ["(", "[", "{"].includes(input[at + 1]?.word ?? "") && macroBang(input[at - 1]?.word ?? "")) {
      // Macro bodies are token trees, not module declarations until expanded; #![...] is skipped alike.
      at++;
      skipGroup();
      path = undefined;
    } else {
      if (["fn", "struct", "enum", "trait", "type", "const", "static", "union"].includes(next) && identifier.test(input[at + 1]?.word ?? "")) source.items.push({ scope, name: input[at + 1]!.word });
      if (next === "{") scopes.push(scope);
      else if (next === "}" && scopes.length > 1) scopes.pop();
      if (!["pub", "(", ")", "crate", "super", "self", "in", "::"].includes(next) && !identifier.test(next)) path = undefined;
      at++;
    }
  }
  return source;
}

type Node = { file: string; dir: string; items: Set<string> };
type Crate = { root: string; home: string; build: boolean; modules: Map<string, Node>; uses: { file: string; scope: string[]; path: string[] }[] };

/** File-to-file edges, rebuilt for each step so manifest changes also reroute belts. */
export function rustImports(files: Map<string, RustSource | undefined>, manifests: Map<string, Cargo>): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const link = (from: string, to: string | undefined) => {
    if (!to || from === to || !files.has(to)) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  const configs = new Map([...manifests].map(([path, cargo]) => [dirname(path), cargo]));
  const homes = [...configs.keys()].sort((a, b) => b.length - a.length);
  const homeOf = new Map<string, string | undefined>(); // nearest manifest dir, undefined when none
  const owned = new Map<string, string[]>();
  for (const file of files.keys()) {
    const found = homes.find((home) => under(file, home));
    homeOf.set(file, found);
    const home = found ?? "";
    if (!owned.has(home)) owned.set(home, []);
    owned.get(home)!.push(file);
  }
  const libraries = new Map<string, { root: string; name: string }>();
  const crates: Crate[] = [];
  const roots = new Set<string>();
  const add = (home: string, relative: string, build = false) => {
    const root = joinStrict(home, relative);
    if (root === undefined || !files.has(root) || roots.has(root)) return;
    roots.add(root);
    crates.push({ root, home, build, modules: new Map(), uses: [] });
  };
  for (const [home, cargo] of configs) {
    const pkg = table(cargo.package);
    const name = string(pkg.name);
    if (!name) continue; // a virtual workspace has no crate of its own
    const lib = table(cargo.lib);
    const root = joinStrict(home, string(lib.path) ?? "src/lib.rs");
    if (root !== undefined && files.has(root) && (cargo.lib !== undefined || pkg.autolib !== false)) {
      libraries.set(home, { root, name: nameOf(string(lib.name) ?? name) });
      add(home, string(lib.path) ?? "src/lib.rs");
    }
    if (pkg.autobins !== false) add(home, "src/main.rs");
    for (const [kind, dir, auto] of [["bin", "src/bin", "autobins"], ["example", "examples", "autoexamples"], ["test", "tests", "autotests"], ["bench", "benches", "autobenches"]] as const) {
      if (pkg[auto] !== false) for (const file of owned.get(home) ?? []) {
        const prefix = home ? `${home}/${dir}/` : `${dir}/`;
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (/^[^/]+\.rs$/.test(rest) || /^[^/]+\/main\.rs$/.test(rest)) add(home, file.slice(home ? home.length + 1 : 0));
      }
      if (Array.isArray(cargo[kind])) for (const value of cargo[kind] as unknown[]) {
        const target = table(value);
        const path = string(target.path);
        const targetName = string(target.name);
        if (path) add(home, path);
        else if (targetName) {
          if (kind === "bin" && targetName === name) add(home, "src/main.rs");
          add(home, `${dir}/${targetName}.rs`);
          add(home, `${dir}/${targetName}/main.rs`);
        }
      }
    }
    if (pkg.build !== false) add(home, string(pkg.build) ?? "build.rs", true);
  }
  // A dropped source folder or standalone .rs file need not have Cargo.toml.
  for (const file of files.keys()) {
    const home = homeOf.get(file);
    if (home !== undefined && string(table(configs.get(home)?.package).name)) continue;
    if (/(^|\/)(lib|main)\.rs$/.test(file)) add(home ?? "", file.slice(home ? home.length + 1 : 0));
  }

  const visited = new Set<string>();
  const buildGraph = (crate: Crate, owned = true) => {
    // `owned` marks files whose child modules live beside them: the root, mod.rs and #[path] files.
    const pending = [{ file: crate.root, scope: [] as string[], parents: [] as string[], owned }];
    while (pending.length) {
      const { file, scope, parents, owned } = pending.pop()!;
      if (parents.includes(file) || scope.length > MAX_DEPTH || crate.modules.size >= 50_000) continue;
      visited.add(file);
      const source = files.get(file);
      const dir = owned || file.endsWith("/mod.rs") || file === "mod.rs" ? dirname(file) : file.slice(0, -3);
      crate.modules.set(scope.join("::"), { file, dir, items: new Set() });
      if (!source) continue;
      for (const module of source.modules) {
        const local = [...scope, ...module.scope];
        const parent = crate.modules.get(local.join("::"));
        if (!parent) continue;
        const child = [...local, module.name];
        if (module.inline) {
          const at = joinStrict(parent.dir, module.path ?? module.name);
          if (at !== undefined) crate.modules.set(child.join("::"), { file, dir: at, items: new Set() });
        } else {
          const base = module.path !== undefined && !module.scope.length ? dirname(file) : parent.dir;
          const path = joinStrict(base, module.path ?? module.name);
          const target = path === undefined ? undefined : module.path !== undefined ? (files.has(path) ? path : undefined) : [`${path}.rs`, `${path}/mod.rs`].find((path) => files.has(path));
          link(file, target);
          if (target) pending.push({ file: target, scope: child, parents: [...parents, file], owned: module.path !== undefined });
        }
      }
      for (const item of source.items) crate.modules.get([...scope, ...item.scope].join("::"))?.items.add(item.name);
      for (const use of source.uses) crate.uses.push({ file, scope: [...scope, ...use.scope], path: use.path });
    }
  };
  for (const crate of crates) buildGraph(crate);
  // Unreachable files (e.g. declared inside cfg_if!) become crates, parents first so their
  // children join them. A non-mod-rs orphan owns the folder named after it, as in rustc.
  const depth = (file: string) => file.split("/").length - (/(^|\/)mod\.rs$/.test(file) ? 1 : 0);
  for (const file of [...files.keys()].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))) if (!visited.has(file)) {
    const home = homeOf.get(file) ?? "";
    const count = crates.length;
    add(home, file.slice(home ? home.length + 1 : 0));
    if (crates.length > count) buildGraph(crates[count]!, /(^|\/)(lib|main)\.rs$/.test(file));
  }
  const byRoot = new Map(crates.map((crate) => [crate.root, crate]));

  const resolve = (crate: Crate, scope: string[], parts: string[]): string | undefined => {
    let node = crate.modules.get(scope.join("::"));
    for (const part of parts) {
      if (part === "self" || part === "*") continue;
      const next = [...scope, part];
      const child = crate.modules.get(next.join("::"));
      if (!child) return node?.items.has(part) ? node.file : undefined;
      scope = next;
      node = child;
    }
    return node?.file;
  };
  for (const crate of crates) {
    const cargo = configs.get(crate.home) ?? {};
    const pkg = table(cargo.package);
    const workspaceAt = string(pkg.workspace);
    const workspaceHome = workspaceAt !== undefined ? joinStrict(crate.home, workspaceAt) : homes.find((home) => under(`${crate.home}/Cargo.toml`, home) && configs.get(home)?.workspace !== undefined);
    const workspace = table(configs.get(workspaceHome ?? "")?.workspace);
    // Cargo defaults to 2015; manifest-less trees keep the fallback since their edition is unknown.
    const edition = table(pkg.edition).workspace === true ? table(workspace.package).edition : pkg.edition;
    const legacy = !string(pkg.name) || (string(edition) ?? "2015") === "2015";
    const deps = new Map<string, Crate>();
    const own = libraries.get(crate.home);
    if (own && !crate.build) {
      const target = byRoot.get(own.root);
      if (target) deps.set(own.name, target);
    }
    const kinds = crate.build ? ["build-dependencies"] : ["dependencies", "dev-dependencies"];
    const sections = [cargo, ...Object.values(table(cargo.target)).map(table)];
    for (const section of sections) for (const kind of kinds) for (const [name, value] of Object.entries(table(section[kind]))) {
      let dependency = table(value);
      let base = crate.home;
      if (dependency.workspace === true) {
        dependency = table(table(workspace.dependencies)[name]);
        base = workspaceHome ?? "";
      }
      const path = string(dependency.path);
      const home = path === undefined ? undefined : joinStrict(base, path);
      const library = home === undefined ? undefined : libraries.get(home);
      const target = library && byRoot.get(library.root);
      if (target) deps.set(nameOf(string(dependency.package) ? name : library!.name), target);
    }
    for (const use of crate.uses) {
      const parts = [...use.path];
      let scope = [...use.scope];
      let target = crate;
      const absolute = parts[0] === "";
      if (absolute) { parts.shift(); scope = []; }
      if (parts[0] === "crate") { parts.shift(); scope = []; }
      else if (parts[0] === "self" || parts[0] === "super") {
        if (parts[0] === "self") parts.shift();
        while (parts[0] === "super" && scope.length) { parts.shift(); scope.pop(); }
        if (parts[0] === "super") continue;
      } else if ((absolute || !crate.modules.has([...scope, parts[0]].join("::"))) && deps.has(parts[0]!)) {
        target = deps.get(parts.shift()!)!;
        scope = [];
      } else if (legacy && !crate.modules.has([...scope, parts[0]].join("::"))) scope = []; // Rust 2015 crate-relative imports
      link(use.file, resolve(target, scope, parts));
    }
  }
  return edges;
}
