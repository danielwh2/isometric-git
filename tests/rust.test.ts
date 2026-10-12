import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanFiles, scanGit, wanted, type Scan } from "../src/lib/scan";
import { disk } from "./disk";

const text = new TextEncoder();
const scan = (given: Record<string, string>) => scanFiles("rust", Object.entries(given).map(([path, body]) => ({ path, read: async () => text.encode(body) })));
const importsOf = (scan: Scan, path: string) => scan.steps[0]!.set.find(([file]) => scan.paths[file] === path)![2].map((id) => scan.paths[id]!).sort();
const cargo = (name: string) => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n`;

test("Rust module files and grouped imports resolve in their declaring scope", async () => {
  const found = await scan({
    "Cargo.toml": cargo("factory"),
    "src/lib.rs": `pub mod model; mod engine; mod old;`,
    "src/model.rs": `pub struct Data; pub enum Kind { A }`,
    "src/engine.rs": `mod worker; use crate::model::{self, Data as Payload, Kind::*};`,
    "src/engine/worker.rs": `use super::super::{model::{Data, Kind}, old::{self, clock::now}}; use self::super::super::model::Data; use self::helpers::*; mod helpers;`,
    "src/engine/worker/helpers.rs": `pub fn help() {}`,
    "src/old/mod.rs": `pub mod clock;`,
    "src/old/clock.rs": `pub fn now() {}`,
  });
  expect(wanted("crates/shared/Cargo.toml")).toBe(true);
  expect(found.paths).not.toContain("Cargo.toml");
  expect(importsOf(found, "src/lib.rs")).toEqual(["src/engine.rs", "src/model.rs", "src/old/mod.rs"]);
  expect(importsOf(found, "src/engine.rs")).toEqual(["src/engine/worker.rs", "src/model.rs"]);
  expect(importsOf(found, "src/engine/worker.rs")).toEqual(["src/engine/worker/helpers.rs", "src/model.rs", "src/old/clock.rs", "src/old/mod.rs"]);
  expect(importsOf(found, "src/old/mod.rs")).toEqual(["src/old/clock.rs"]);
});

test("inline modules and path attributes keep logical names separate from filenames", async () => {
  const found = await scan({
    "src/lib.rs": `
      #[path = "platform/linux.rs"] pub mod platform;
      mod inline { #[path = r#"tools.rs"#] mod tools; use self::tools::Tool; }
      #[path = "extra"] mod alternate { mod item; }
      mod engine;
      use crate::{platform::Platform, inline::tools::Tool, alternate::item::Item};`,
    "src/platform/linux.rs": `pub struct Platform; #[path = "clock.rs"] pub mod time;`,
    "src/platform/clock.rs": `pub fn now() {}`,
    "src/inline/tools.rs": `pub struct Tool; use super::super::platform::Platform;`,
    "src/extra/item.rs": `pub struct Item;`,
    "src/engine.rs": `mod inside { #[path = "task.rs"] mod task; use crate::platform::time::now; }`,
    "src/engine/inside/task.rs": `use super::super::super::inline::tools::Tool;`,
  });
  expect(importsOf(found, "src/lib.rs")).toEqual(["src/engine.rs", "src/extra/item.rs", "src/inline/tools.rs", "src/platform/linux.rs"]);
  expect(importsOf(found, "src/platform/linux.rs")).toEqual(["src/platform/clock.rs"]);
  expect(importsOf(found, "src/inline/tools.rs")).toEqual(["src/platform/linux.rs"]);
  expect(importsOf(found, "src/engine.rs")).toEqual(["src/engine/inside/task.rs", "src/platform/clock.rs"]);
  expect(importsOf(found, "src/engine/inside/task.rs")).toEqual(["src/inline/tools.rs"]);
});

test("plain modules inside a #[path] file resolve beside it, like mod.rs", async () => {
  const found = await scan({
    "src/lib.rs": `#[path = "platform/linux.rs"] mod platform;`,
    "src/platform/linux.rs": `mod time; mod net;`,
    "src/platform/time.rs": `pub fn now() {}`,
    "src/platform/net/mod.rs": `pub struct Socket;`,
    "src/platform/linux/time.rs": `pub fn decoy() {}`,
  });
  expect(importsOf(found, "src/platform/linux.rs")).toEqual(["src/platform/net/mod.rs", "src/platform/time.rs"]);
});

test("Cargo workspaces resolve inherited, renamed and target-specific path dependencies", async () => {
  const found = await scan({
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nshared = { path = "crates/shared" }\n`,
    "crates/shared/Cargo.toml": cargo("shared-code") + `[lib]\nname = "shared"\npath = "code/root.rs"\n`,
    "crates/shared/code/root.rs": `pub mod model; pub struct Root;`,
    "crates/shared/code/model.rs": `pub struct Data;`,
    "crates/app/Cargo.toml": cargo("app") + `
      [dependencies]
      shared.workspace = true
      renamed = { package = "shared-code", path = "../shared" }
      serde = "1"
      outside = { path = "../../../../outside" }
      [target.'cfg(unix)'.dependencies.shared_table]
      package = "shared-code"
      path = "../shared"
      [[bin]]
      name = "custom"
      path = "cmd/start.rs"
    `,
    "crates/app/src/main.rs": `use shared::{Root, model::{self, Data}}; use renamed::model::Data as Other; use shared_table::Root; use serde::Serialize; use outside::Data;`,
    "crates/app/cmd/start.rs": `use renamed::model::*;`,
    "crates/unrelated/Cargo.toml": cargo("serde"),
    "crates/unrelated/src/lib.rs": `pub struct Serialize;`,
  });
  expect(importsOf(found, "crates/app/src/main.rs")).toEqual(["crates/shared/code/model.rs", "crates/shared/code/root.rs"]);
  expect(importsOf(found, "crates/app/cmd/start.rs")).toEqual(["crates/shared/code/model.rs"]);
});

test("a package library, binaries, integration tests and examples have separate crate roots", async () => {
  const found = await scan({
    "Cargo.toml": cargo("my-library"),
    "src/lib.rs": `pub mod model;`,
    "src/model.rs": `pub struct Data;`,
    "src/main.rs": `mod cli; use my_library::model::Data;`,
    "src/cli.rs": `pub struct Cli;`,
    "src/bin/tool.rs": `mod helper; use crate::helper::Help; use my_library::model::Data;`,
    "src/bin/helper.rs": `pub struct Help;`,
    "src/bin/nested/main.rs": `mod helper;`,
    "src/bin/nested/helper.rs": `pub struct Help;`,
    "tests/integration.rs": `mod common; use my_library::model::Data;`,
    "tests/common/mod.rs": `use my_library::model::Data;`,
    "examples/show.rs": `use my_library::model::Data;`,
  });
  expect(importsOf(found, "src/main.rs")).toEqual(["src/cli.rs", "src/model.rs"]);
  expect(importsOf(found, "src/bin/tool.rs")).toEqual(["src/bin/helper.rs", "src/model.rs"]);
  expect(importsOf(found, "src/bin/nested/main.rs")).toEqual(["src/bin/nested/helper.rs"]);
  expect(importsOf(found, "tests/integration.rs")).toEqual(["src/model.rs", "tests/common/mod.rs"]);
  expect(importsOf(found, "tests/common/mod.rs")).toEqual(["src/model.rs"]);
  expect(importsOf(found, "examples/show.rs")).toEqual(["src/model.rs"]);
});

test("absolute crate imports bypass local modules and build scripts use build dependencies", async () => {
  const found = await scan({
    "Cargo.toml": cargo("app") + `
      [dependencies]
      shared = { path = "shared" }
      [build-dependencies]
      generator = { path = "generator" }
    `,
    "src/lib.rs": `mod shared; mod caller;`,
    "src/shared.rs": `pub struct Data;`,
    "src/caller.rs": `mod shared; use ::shared::Data;`,
    "src/caller/shared.rs": `pub struct Data;`,
    "build.rs": `use generator::Generate; use shared::Data;`,
    "shared/Cargo.toml": cargo("shared"),
    "shared/src/lib.rs": `pub struct Data;`,
    "generator/Cargo.toml": cargo("generator"),
    "generator/src/lib.rs": `pub struct Generate;`,
  });
  expect(importsOf(found, "src/caller.rs")).toEqual(["shared/src/lib.rs", "src/caller/shared.rs"]);
  expect(importsOf(found, "build.rs")).toEqual(["generator/src/lib.rs"]);
});

test("Rust comments, literals, macro bodies and missing modules do not create belts", async () => {
  const found = await scan({
    "src/lib.rs": `pub mod real; pub mod caller;`,
    "src/real.rs": `pub struct Item;`,
    "src/caller.rs": `
      // use crate::fake::Item; mod fake;
      /* outer /* use crate::fake::Item; */ mod fake; */
      const TEXT: &str = "use crate::fake::Item; mod fake;";
      const RAW: &str = br###"use crate::fake::Item; mod fake;"###;
      const CHAR: char = '{';
      macro_rules! make { () => { use crate::fake::Item; mod fake; }; }
      make!(use crate::fake::Item; mod fake;);
      use std::collections::HashMap;
      use crate::missing::Item;
      use super::super::fake::Item;
      use crate::real::Item;
      fn borrow<'a>(value: &'a str) { use crate::real::Item as Alias; }
    `,
    "src/fake.rs": `pub struct Item;`,
  });
  expect(importsOf(found, "src/caller.rs")).toEqual(["src/real.rs"]);
});

test("the never type and negated conditions are not macro bangs", async () => {
  const found = await scan({
    "src/lib.rs": `#![allow(unused)] pub mod error; pub mod check; pub mod caller;`,
    "src/error.rs": `pub struct Fatal;`,
    "src/check.rs": `pub fn ok() {} pub struct Done;`,
    "src/caller.rs": `
      fn fail() -> ! { use crate::error::Fatal; loop {} }
      fn run(x: bool) { if !(x) { use crate::check::ok; } let y = !{ use crate::check::Done; x }; }
    `,
  });
  expect(importsOf(found, "src/caller.rs")).toEqual(["src/check.rs", "src/error.rs"]);
});

test("only Rust 2015 crates resolve bare use paths from the crate root", async () => {
  const layout = (manifest: string) => scan({
    "Cargo.toml": manifest,
    "src/lib.rs": `mod log; mod net;`,
    "src/log.rs": `pub fn info() {}`,
    "src/net/mod.rs": `mod conn;`,
    "src/net/conn.rs": `use log::info;`,
  });
  const header = `[package]\nname = "app"\nversion = "0.1.0"\n`;
  for (const [manifest, imports] of [
    [header + `edition = "2021"\n`, []],
    [`[workspace]\n[workspace.package]\nedition = "2021"\n` + header + `edition.workspace = true\n`, []],
    [header + `edition = "2015"\n`, ["src/log.rs"]],
    [header, ["src/log.rs"]],
  ] as const) expect(importsOf(await layout(manifest), "src/net/conn.rs")).toEqual([...imports]);
});

test("orphan modules become crates that keep their own children and super imports", async () => {
  const found = await scan({
    "Cargo.toml": cargo("factory"),
    "src/lib.rs": `cfg_if::cfg_if! { if #[cfg(unix)] { mod unix; } }`,
    "src/unix/sys.rs": `use super::Fd;`,
    "src/unix.rs": `mod sys; pub struct Fd;`,
    "src/sys.rs": `pub fn decoy() {}`,
  });
  expect(importsOf(found, "src/lib.rs")).toEqual([]);
  expect(importsOf(found, "src/unix.rs")).toEqual(["src/unix/sys.rs"]);
  expect(importsOf(found, "src/unix/sys.rs")).toEqual(["src/unix.rs"]);
});

test("standalone Rust trees work alongside existing JavaScript imports", async () => {
  const found = await scan({
    "lib.rs": `mod r#type; use self::r#type::Item;`,
    "type.rs": `pub struct Item;`,
    "web/app.ts": `import "../shared/data";`,
    "shared/data.ts": `export const data = 1;`,
  });
  expect(importsOf(found, "lib.rs")).toEqual(["type.rs"]);
  expect(importsOf(found, "web/app.ts")).toEqual(["shared/data.ts"]);
});

test("malformed and oversized Cargo files are skipped without becoming source files", async () => {
  const found = await scan({
    "Cargo.toml": `[package]\nname = [ broken`,
    "nested/Cargo.toml": "#".repeat((64 << 10) + 1),
    "src/lib.rs": `mod model;`,
    "src/model.rs": `pub struct Data;`,
    "nested/src/lib.rs": `mod model;`,
    "nested/src/model.rs": `pub struct Data;`,
  });
  expect(found.paths.every((path) => path.endsWith(".rs"))).toBe(true);
  expect(importsOf(found, "src/lib.rs")).toEqual(["src/model.rs"]);
  expect(importsOf(found, "nested/src/lib.rs")).toEqual(["nested/src/model.rs"]);
});

test("deep use trees, cyclic path modules and oversized Rust sources stay bounded", async () => {
  const found = await scan({
    "src/lib.rs": `#[path = "lib.rs"] mod cycle; mod model; use crate::${"{".repeat(2000)}model::Data${"}".repeat(2000)};`,
    "src/model.rs": `pub struct Data;`,
    "src/huge.rs": `use crate::model::Data;\n${" ".repeat(1 << 20)}`,
    "deep.rs": `${"mod inline {".repeat(2000)}use crate::model::Data;${"}".repeat(2000)}`,
  });
  expect(importsOf(found, "src/lib.rs")).toEqual(["src/model.rs"]);
  expect(importsOf(found, "src/huge.rs")).toEqual([]);
  expect(found.paths).toContain("deep.rs");
});

test("Rust history reroutes on Cargo-only changes and removes deleted modules, loose and packed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "isometric-rust-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const commit = (subject: string, files: Record<string, string | null>) => {
    for (const [path, body] of Object.entries(files)) {
      if (body === null) rmSync(join(repo, path));
      else {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), body);
      }
    }
    git("add", "-A");
    git("commit", "-qm", subject);
  };
  try {
    git("init", "-q");
    commit("crates", {
      "Cargo.toml": cargo("app") + `[dependencies]\nshared = { path = "one" }\n`,
      "src/main.rs": `use shared::model::Data;`,
      "one/Cargo.toml": cargo("shared"),
      "one/src/lib.rs": `pub mod model;`,
      "one/src/model.rs": `pub struct Data;`,
      "two/Cargo.toml": cargo("shared"),
      "two/src/lib.rs": `pub mod model;`,
      "two/src/model.rs": `pub struct Data;`,
    });
    commit("reroute", { "Cargo.toml": cargo("app") + `[dependencies]\nshared = { path = "two" }\n` });
    commit("web only", { "web/app.ts": `export const app = 1;` }); // the cached Rust graph must survive a commit that touches no Rust
    commit("bump version", { "Cargo.toml": cargo("app").replace("0.1.0", "0.2.0") + `[dependencies]\nshared = { path = "two" }\n` });
    commit("remove manifest", { "Cargo.toml": null });
    commit("delete module", { "two/src/model.rs": null });
    const check = async () => {
      const found = (await scanGit(disk(join(repo, ".git")), "rust"))!;
      expect(found.steps.map((step) => step.subject)).toEqual(["crates", "reroute", "web only", "remove manifest", "delete module"]); // a version bump draws nothing new
      const state = new Map<string, string[]>();
      for (const [index, step] of found.steps.entries()) {
        for (const [file, , imports] of step.set) state.set(found.paths[file]!, imports.map((id) => found.paths[id]!));
        for (const file of step.gone) state.delete(found.paths[file]!);
        expect(state.get("src/main.rs")).toEqual(index === 0 ? ["one/src/model.rs"] : index <= 2 ? ["two/src/model.rs"] : []);
        if (index === 1) expect(step.touched).toEqual([]);
        expect(state.has("two/src/model.rs")).toBe(index < 4);
      }
      expect(found.paths.filter((path) => !path.endsWith(".rs"))).toEqual(["web/app.ts"]);
    };
    await check();
    git("gc", "-q", "--aggressive", "--prune=now");
    await check();
  } finally {
    rmSync(repo, { recursive: true });
  }
});
