// Writes the factory the page opens on: a made-up shop, told commit by commit. No real repo is read.
//   bun scripts/sample.ts > src/data/sample.json
import type { Scan, Step } from "../src/lib/scan";

const NAME = "corner-shop";
const FIRST_DAY = Date.UTC(2026, 2, 2);
const DAYS_APART = 3; // between one commit and the next
const DAY = 24 * 60 * 60 * 1000;
const KB = 1024;

const TOKENS = "packages/tokens/";
const UI = "packages/ui/";
const SHARED = "packages/shared/";
const DB = "packages/db/";
const AUTH = "packages/auth/";
const PAY = "packages/payments/";
const MAIL = "packages/email/";
const API = "apps/api/src/";
const ROUTES = "apps/api/src/routes/";
const LIB = "apps/web/src/lib/";
const HOOKS = "apps/web/src/hooks/";
const PARTS = "apps/web/src/components/";
const PAGES = "apps/web/src/pages/";
const ADMIN = "apps/admin/src/";

type Change = { path: string; kB?: number; imports?: string[]; extra?: string[]; gone?: true };
/** A new file, or one rewritten: these imports replace what it had. */
const write = (path: string, kB: number, ...imports: string[]): Change => ({ path, kB, imports });
/** A file that changed size, and may import more than it did. */
const grow = (path: string, kB: number, ...extra: string[]): Change => ({ path, kB, extra });
const drop = (path: string): Change => ({ path, gone: true });

type Chapter = [subject: string, ...changes: Change[]];
const merges = new Map<string, { commits: number; contested: string[] }>(); // each merge's subject, the commits its branch held and the files main had changed under it
/** A branch joined to main, under the subject git gives it: everything its commits changed lands as one step. */
const merge = (branch: string, commits: number, contested: string[], ...changes: Change[]): Chapter => {
  const subject = `Merge branch '${branch}'`;
  merges.set(subject, { commits, contested });
  return [subject, ...changes];
};

const story: Chapter[] = [
  ["Start with tokens and a button",
    write(TOKENS + "colors.ts", 6), write(TOKENS + "space.ts", 3), write(TOKENS + "type.ts", 4),
    write(UI + "button.tsx", 8, TOKENS + "colors.ts", TOKENS + "space.ts"),
    write(UI + "text.tsx", 5, TOKENS + "type.ts", TOKENS + "colors.ts")],
  ["Shop front: a home page and a product card",
    write(PARTS + "header.tsx", 9, UI + "text.tsx"),
    write(PARTS + "product-card.tsx", 11, UI + "button.tsx", UI + "text.tsx"),
    write(PAGES + "index.tsx", 16, PARTS + "header.tsx", PARTS + "product-card.tsx")],
  ["Money and product types, shared by everything",
    write(SHARED + "money.ts", 7), write(SHARED + "types.ts", 11),
    write(PARTS + "price.tsx", 5, SHARED + "money.ts", UI + "text.tsx"),
    grow(PARTS + "product-card.tsx", 13, PARTS + "price.tsx", SHARED + "types.ts")],
  ["Database: schema, client and seed data",
    write(DB + "schema.ts", 24, SHARED + "types.ts"),
    write(DB + "client.ts", 9, DB + "schema.ts"),
    write(DB + "seed.ts", 15, DB + "client.ts", DB + "schema.ts")],
  ["API server with product routes",
    write(ROUTES + "products.ts", 14, DB + "client.ts", SHARED + "types.ts"),
    write(API + "router.ts", 7, ROUTES + "products.ts"),
    write(API + "server.ts", 10, API + "router.ts")],
  ["The shop reads products from the API",
    write(LIB + "api.ts", 12, SHARED + "types.ts"),
    write(LIB + "format.ts", 5, SHARED + "money.ts"),
    grow(PAGES + "index.tsx", 19, LIB + "api.ts"),
    write(PAGES + "product.tsx", 21, LIB + "api.ts", LIB + "format.ts", PARTS + "header.tsx", PARTS + "price.tsx", UI + "button.tsx")],
  ["Inputs, cards and a dialog for the kit",
    write(UI + "input.tsx", 10, TOKENS + "colors.ts", TOKENS + "space.ts", TOKENS + "type.ts"),
    write(UI + "card.tsx", 7, TOKENS + "colors.ts", TOKENS + "space.ts"),
    write(UI + "dialog.tsx", 15, TOKENS + "colors.ts", TOKENS + "space.ts", UI + "button.tsx")],
  ["Cart: a hook, a drawer and a route",
    write(HOOKS + "use-cart.ts", 10, LIB + "api.ts", SHARED + "types.ts"),
    write(PARTS + "cart-drawer.tsx", 18, HOOKS + "use-cart.ts", PARTS + "price.tsx", UI + "dialog.tsx", UI + "button.tsx"),
    grow(PARTS + "header.tsx", 12, PARTS + "cart-drawer.tsx"),
    write(ROUTES + "cart.ts", 15, DB + "client.ts", SHARED + "types.ts", SHARED + "money.ts"),
    grow(API + "router.ts", 9, ROUTES + "cart.ts")],
  ["Sign in with sessions",
    write(AUTH + "password.ts", 6),
    write(AUTH + "session.ts", 13, DB + "client.ts", SHARED + "types.ts"),
    write(AUTH + "guard.ts", 8, AUTH + "session.ts"),
    grow(DB + "schema.ts", 31),
    write(ROUTES + "users.ts", 17, AUTH + "session.ts", AUTH + "password.ts", DB + "client.ts"),
    grow(API + "router.ts", 11, ROUTES + "users.ts")],
  ["Account page and a sign-in form",
    write(HOOKS + "use-session.ts", 7, LIB + "api.ts"),
    write(PARTS + "sign-in-form.tsx", 14, HOOKS + "use-session.ts", UI + "input.tsx", UI + "button.tsx"),
    write(PAGES + "account.tsx", 17, PARTS + "sign-in-form.tsx", PARTS + "header.tsx", HOOKS + "use-session.ts", UI + "card.tsx")],
  ["Checkout with card payments",
    write(PAY + "stripe.ts", 20, SHARED + "money.ts", SHARED + "types.ts"),
    write(PAY + "prices.ts", 8, SHARED + "money.ts", DB + "client.ts"),
    write(ROUTES + "checkout.ts", 22, PAY + "stripe.ts", PAY + "prices.ts", AUTH + "guard.ts", DB + "client.ts"),
    grow(API + "router.ts", 13, ROUTES + "checkout.ts"),
    write(PAGES + "cart.tsx", 15, HOOKS + "use-cart.ts", PARTS + "header.tsx", PARTS + "price.tsx", UI + "button.tsx"),
    write(PAGES + "checkout.tsx", 26, HOOKS + "use-cart.ts", LIB + "api.ts", PARTS + "header.tsx", PARTS + "price.tsx", UI + "input.tsx", UI + "button.tsx")],
  ["Orders, and the webhook that confirms them",
    write(PAY + "webhook.ts", 13, PAY + "stripe.ts", DB + "client.ts"),
    write(ROUTES + "orders.ts", 18, DB + "client.ts", AUTH + "guard.ts", SHARED + "types.ts"),
    grow(API + "router.ts", 15, ROUTES + "orders.ts"),
    grow(API + "server.ts", 13, PAY + "webhook.ts"),
    grow(DB + "schema.ts", 43)],
  ["Receipts and a welcome by email",
    write(MAIL + "send.ts", 8),
    write(MAIL + "receipt.tsx", 15, TOKENS + "colors.ts", TOKENS + "type.ts", SHARED + "money.ts", SHARED + "types.ts"),
    write(MAIL + "welcome.tsx", 10, TOKENS + "colors.ts", TOKENS + "type.ts"),
    grow(PAY + "webhook.ts", 16, MAIL + "send.ts", MAIL + "receipt.tsx"),
    grow(ROUTES + "users.ts", 20, MAIL + "send.ts", MAIL + "welcome.tsx")],
  ["Fold the hooks into lib",
    write(LIB + "cart.ts", 13, LIB + "api.ts", SHARED + "types.ts"),
    write(LIB + "session.ts", 8, LIB + "api.ts"),
    write(PARTS + "cart-drawer.tsx", 18, LIB + "cart.ts", PARTS + "price.tsx", UI + "dialog.tsx", UI + "button.tsx"),
    write(PARTS + "sign-in-form.tsx", 14, LIB + "session.ts", UI + "input.tsx", UI + "button.tsx"),
    write(PAGES + "account.tsx", 17, PARTS + "sign-in-form.tsx", PARTS + "header.tsx", LIB + "session.ts", UI + "card.tsx"),
    write(PAGES + "cart.tsx", 15, LIB + "cart.ts", PARTS + "header.tsx", PARTS + "price.tsx", UI + "button.tsx"),
    write(PAGES + "checkout.tsx", 26, LIB + "cart.ts", LIB + "api.ts", PARTS + "header.tsx", PARTS + "price.tsx", UI + "input.tsx", UI + "button.tsx"),
    drop(HOOKS + "use-cart.ts"), drop(HOOKS + "use-session.ts")],
  ["Admin: orders and stock",
    write(ADMIN + "api.ts", 9, SHARED + "types.ts"),
    write(ADMIN + "orders.tsx", 23, ADMIN + "api.ts", SHARED + "money.ts", UI + "card.tsx", UI + "button.tsx"),
    write(ADMIN + "stock.tsx", 19, ADMIN + "api.ts", UI + "input.tsx", UI + "button.tsx"),
    write(ADMIN + "app.tsx", 11, ADMIN + "orders.tsx", ADMIN + "stock.tsx", UI + "text.tsx")],
  ["A table, badges and a toast for the kit",
    write(UI + "badge.tsx", 5, TOKENS + "colors.ts", TOKENS + "type.ts"),
    write(UI + "table.tsx", 17, TOKENS + "colors.ts", TOKENS + "space.ts", UI + "text.tsx"),
    write(UI + "toast.tsx", 12, TOKENS + "colors.ts", TOKENS + "space.ts"),
    grow(ADMIN + "orders.tsx", 29, UI + "table.tsx", UI + "badge.tsx"),
    grow(PARTS + "product-card.tsx", 15, UI + "badge.tsx"),
    grow(PAGES + "checkout.tsx", 28, UI + "toast.tsx")],
  ["Search the shelves",
    write(ROUTES + "search.ts", 12, DB + "client.ts", SHARED + "types.ts"),
    grow(API + "router.ts", 17, ROUTES + "search.ts"),
    grow(DB + "schema.ts", 48),
    write(PARTS + "search-box.tsx", 12, LIB + "api.ts", UI + "input.tsx"),
    grow(PARTS + "header.tsx", 14, PARTS + "search-box.tsx")],
  // Built on a branch while main moved on. Both sides had changed the checkout route and the schema, and the merge settled them.
  merge("gift-cards", 4, [ROUTES + "checkout.ts", DB + "schema.ts"],
    write(PAY + "gift-card.ts", 9, SHARED + "money.ts", DB + "client.ts"),
    write(ROUTES + "gift-cards.ts", 12, PAY + "gift-card.ts", AUTH + "guard.ts", SHARED + "types.ts"),
    grow(API + "router.ts", 19, ROUTES + "gift-cards.ts"),
    grow(DB + "schema.ts", 52),
    grow(ROUTES + "checkout.ts", 25, PAY + "gift-card.ts"),
    write(PARTS + "gift-card-field.tsx", 8, LIB + "api.ts", UI + "input.tsx", UI + "button.tsx"),
    grow(PAGES + "checkout.tsx", 30, PARTS + "gift-card-field.tsx")),
  ["A footer, empty shelves and a page for wrong turns",
    write(PARTS + "footer.tsx", 7, UI + "text.tsx"),
    write(PARTS + "empty.tsx", 6, UI + "text.tsx", UI + "button.tsx"),
    write(PAGES + "not-found.tsx", 7, PARTS + "header.tsx", PARTS + "footer.tsx", PARTS + "empty.tsx"),
    grow(PAGES + "index.tsx", 22, PARTS + "footer.tsx", PARTS + "empty.tsx")],
  ["Dark mode, from the tokens up",
    write(TOKENS + "theme.ts", 8, TOKENS + "colors.ts"),
    grow(TOKENS + "colors.ts", 11),
    grow(UI + "button.tsx", 10, TOKENS + "theme.ts"),
    grow(UI + "card.tsx", 9, TOKENS + "theme.ts"),
    grow(UI + "input.tsx", 12, TOKENS + "theme.ts"),
    grow(UI + "dialog.tsx", 17, TOKENS + "theme.ts")],
  ["Rate limits on the API",
    write(API + "limit.ts", 9, AUTH + "session.ts", SHARED + "types.ts"),
    grow(API + "server.ts", 15, API + "limit.ts"),
    grow(ROUTES + "checkout.ts", 27),
    grow(ROUTES + "cart.ts", 17)],
];

const paths: string[] = [];
const idOf = (path: string) => (paths.includes(path) ? paths.indexOf(path) : paths.push(path) - 1);
const alive = new Map<string, string[]>(); // each file standing, and what it imports

const steps = story.map(([subject, ...changes], index): Step => {
  const set: Step["set"] = [];
  const gone: number[] = [];
  for (const { path, kB, imports, extra, gone: dropped } of changes) {
    if (dropped) {
      if (!alive.delete(path)) throw new Error(`"${subject}" drops ${path}, which is not there`);
      gone.push(idOf(path));
      continue;
    }
    if (extra && !alive.has(path)) throw new Error(`"${subject}" grows ${path}, which is not there`);
    alive.set(path, imports ?? [...new Set([...alive.get(path)!, ...extra!])]);
    set.push([idOf(path), kB! * KB, []]);
  }
  // Imports are filled in once the whole commit is in, so a file may import one written after it.
  for (const entry of set) entry[2] = alive.get(paths[entry[0]]!)!.map(idOf).sort((p, q) => p - q);
  for (const [path, imports] of alive) {
    const missing = imports.find((target) => !alive.has(target));
    if (missing) throw new Error(`after "${subject}", ${path} imports ${missing}, which is not there`);
  }
  return {
    hash: new Bun.CryptoHasher("sha1").update(`${index} ${subject}`).digest("hex").slice(0, 7),
    date: new Date(FIRST_DAY + index * DAYS_APART * DAY).toISOString().slice(0, 10),
    subject,
    nth: index + 1,
    set,
    gone,
    touched: set.map(([file]) => file),
    merge: merges.get(subject)?.commits,
    delivered: merges.has(subject) ? set.map(([file]) => file) : undefined,
    contested: merges.get(subject)?.contested.map(idOf),
  };
});

console.log(JSON.stringify({ name: NAME, commits: steps.length, paths, steps } satisfies Scan));
