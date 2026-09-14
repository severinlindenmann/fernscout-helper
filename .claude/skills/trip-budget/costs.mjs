#!/usr/bin/env node
// The costs a bank statement cannot tell you: what the flights were, what the
// car cost, what was paid in cash. Three verbs.
//
//   node costs.mjs check   --trip algarve-2026 --user severin
//   node costs.mjs add     --trip … --user … --day 2026-06-22 \
//                          --label "Flüge Basel–Faro" --amount 780 --currency CHF --category flights
//   node costs.mjs add     --trip … --user … --before   (…onto the trip itself)
//   node costs.mjs budget  --trip … --user … --total 3000 --days 10 --currency CHF
//
// **`--before` means something specific now.** In v1 a trip's `costs.md` was
// the trip's whole spend and days carried their own besides, so the two could
// and did hold the same money twice — one real folder's `costs.md` was
// line-for-line what its days already said, and publishing both reported the
// trip at double. In v2 a trip's `costs.items` is **preparation only**: what
// was paid before leaving. Everything spent on the trip belongs to the day it
// was spent on. So `--before` is the flights and the deposit, and everything
// else wants a `--day`.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die, argv } from "../shared/lib.mjs";

/** The instance's own list, and the enum a cost is refused for missing. Read
 * from the contract where a run is online; this is the fallback for a run that
 * is not, and it is the one list in this file. */
const CATEGORIES = ["preparation", "flights", "accommodation", "food", "transport", "activities", "other"];

const verb = argv[0];
const trip = arg("trip") ?? die("--trip <name> is required.");
const user = arg("user") ?? die("--user <name> is required.");
const CONTENT = process.env.FERNSCOUT_CONTENT_DIR ?? join(ROOT, "content");
const TRIP = join(CONTENT, user, "trips", trip);
if (!existsSync(TRIP)) die(`No trip folder at ${TRIP}.`);

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, doc) => writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

const tripFile = join(TRIP, "trip.json");
if (!existsSync(tripFile)) {
  die(
    `No trip.json at ${TRIP}.` +
    (existsSync(join(TRIP, "trip.md"))
      ? "\nThis folder is the old Markdown shape. Convert it first:\n" +
        `  node .claude/skills/shared/convert.mjs ${user}`
      : ""),
  );
}

const entryFiles = existsSync(join(TRIP, "entries"))
  ? readdirSync(join(TRIP, "entries")).filter((f) => f.endsWith(".json")).sort()
  : [];

/** The day file for one date. More than one day can share a date — several
 * updates in one day is ordinary — so the earliest by `time` wins, and a day
 * with no time sorts first, which is where an untimed note belongs. */
const entryFor = (date) => {
  const same = entryFiles.filter((f) => f.startsWith(date));
  return same.sort((a, b) => {
    const t = (f) => read(join(TRIP, "entries", f)).time ?? "";
    return t(a).localeCompare(t(b));
  })[0];
};

if (verb === "add") {
  const label = arg("label") ?? die("--label is required.");
  const amount = Number(arg("amount"));
  if (!Number.isFinite(amount)) die("--amount must be a number.");
  const category = arg("category") ?? "other";
  if (!CATEGORIES.includes(category)) die(`--category must be one of: ${CATEGORIES.join(", ")}`);
  const currency = arg("currency");
  const cost = { label, amount, ...(currency ? { currency } : {}), category };

  if (has("before")) {
    const doc = read(tripFile);
    doc.costs = { ...(doc.costs ?? {}), items: [...(doc.costs?.items ?? []), cost] };
    // A trip that had declined costs has just answered them; leaving the
    // decline beside the answer is a document saying both at once, which the
    // instance refuses and is right to.
    if (doc.declined?.costs) delete doc.declined.costs;
    if (doc.declined && !Object.keys(doc.declined).length) delete doc.declined;
    write(tripFile, doc);
    console.log(`Added to the trip's preparation costs: ${label}, ${amount} ${currency ?? ""} (${category})`);
  } else {
    const date = arg("day") ?? die("--day YYYY-MM-DD, or --before for something paid before the trip.");
    const file = entryFor(date) ?? die(`No day for ${date}. Write the day first, or use --before.`);
    const path = join(TRIP, "entries", file);
    const doc = read(path);
    doc.costs = [...(doc.costs ?? []), cost];
    if (doc.declined?.costs) delete doc.declined.costs;
    if (doc.declined && !Object.keys(doc.declined).length) delete doc.declined;
    write(path, doc);
    console.log(`Added to ${file}: ${label}, ${amount} ${currency ?? ""} (${category})`);
  }
  process.exit(0);
}

if (verb === "budget") {
  const total = Number(arg("total"));
  const days = Number(arg("days"));
  const currency = arg("currency") ?? "CHF";
  if (!Number.isFinite(total) || !Number.isFinite(days)) die("--total and --days must be numbers.");
  const doc = read(tripFile);
  doc.costs = { ...(doc.costs ?? {}), budget: { total, days, currency } };
  if (doc.declined?.costs) delete doc.declined.costs;
  if (doc.declined && !Object.keys(doc.declined).length) delete doc.declined;
  write(tripFile, doc);
  console.log(`Budget: ${total} ${currency} over ${days} days.`);
  process.exit(0);
}

if (verb !== "check") die("Say: check, add, or budget.");

// check — what is recorded, and what is conspicuously absent. It asks the
// questions; it never answers them.
const tripDoc = read(tripFile);
const before = tripDoc.costs?.items ?? [];
const days = {};
for (const file of entryFiles) {
  const doc = read(join(TRIP, "entries", file));
  const date = doc.date ?? file.slice(0, 10);
  (days[date] ??= []).push(...(doc.costs ?? []));
}

const all = [...before, ...Object.values(days).flat()];
console.log(
  `${trip}: ${entryFiles.length} day${entryFiles.length === 1 ? "" : "s"}, ${all.length} cost${all.length === 1 ? "" : "s"} recorded ` +
  `(${before.length} before leaving, ${all.length - before.length} on the days themselves).`,
);

const budget = tripDoc.costs?.budget;
console.log(
  budget
    ? `\nBudget: ${budget.total} ${budget.currency ?? ""}${budget.days ? ` over ${budget.days} days` : ""}`
    : "\nNo budget set. Ask what the trip was meant to cost, then: costs.mjs budget …",
);

console.log("\nRecorded, by category:");
for (const c of CATEGORIES) {
  const list = all.filter((x) => (x.category ?? "other") === c);
  console.log(`  ${c.padEnd(14)} ${list.length ? `${String(list.length).padStart(3)} item(s)` : "  — nothing"}`);
}

console.log("\nDays with nothing recorded:");
const declinedDays = [];
for (const file of entryFiles) {
  const doc = read(join(TRIP, "entries", file));
  const date = doc.date ?? file.slice(0, 10);
  if (doc.declined?.costs) declinedDays.push(date);
}
const empty = Object.entries(days)
  .filter(([date, list]) => !list.length && !declinedDays.includes(date))
  .map(([date]) => date);
console.log(empty.length ? `  ${empty.join(", ")}` : "  none");
if (declinedDays.length) {
  console.log(`\n${declinedDays.length} day(s) say in the document why they have no costs — those are answered, not missing.`);
}

const seen = new Set(all.map((c) => c.category ?? "other"));
const missing = ["flights", "accommodation", "transport"].filter((c) => !seen.has(c));
if (missing.length) {
  console.log(
    `\nNothing at all under: ${missing.join(", ")}. Worth asking about — these are usually the ` +
    "biggest lines and almost never on a card statement in full.",
  );
}
