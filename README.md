# Isometric Git

See your repo built as a factory.

![A repo drawn as an isometric factory: machines joined by conveyor belts carrying cardboard boxes](docs/factory.svg)

Drop a repo folder on the page and it is drawn commit by commit. It runs in your browser and uploads nothing.

## How to read it

- **Machine:** a folder. More code makes it taller.
- **Hatch:** a file, on the machine's roof.
- **Belt:** what one folder imports from another. More imports, more boxes.
- **Smoke:** a commit changed files there.
- **Pennant:** nothing imports this folder.

## Stamps

"Make a stamp" turns the factory into a card to post: its picture, a score and a rank from Shed to Megafactory. The score is a point a file, a point a kB of source and five a belt. Change the title, colours, numbers and shape, save it as an image, or copy a challenge link. Whoever opens the link sees your stamp beside theirs. The link holds numbers and the title, never a file or folder name.

## Run it

```sh
bun install
bun run dev
```

`bun run build` writes a static site to `dist/`, which any static host serves. `bun test` and `bun run check` run the tests and the typecheck.

## Limits

- Belts follow JavaScript and TypeScript imports only. Other languages get machines with no belts.
- A history longer than 150 commits is sampled down to 150 steps.
- SHA-1 repos only.

## Where things are

- `src/lib` is the engine: `git.ts` reads `.git`, `scan.ts` turns history into steps, `plan.ts` places machines and routes belts, `conveyor.ts` moves the boxes, `factory.ts` animates and paints, `stamp.ts` scores a factory and draws its stamp.
- `src/pages` and `src/components` are the page, built with [Astro](https://astro.build).
- `scripts/sample.ts` writes the made-up repo the page opens on.

Set in [Paper Mono](https://paper.design/mono), under the SIL Open Font License. Code under the [MIT licence](LICENSE).

By [Daniel](https://github.com/danielwh2).
