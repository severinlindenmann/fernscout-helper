#!/usr/bin/env node
// Write the agreed costs into the journal: a `costs:` block on each day, and
// the trip's exchange rate in trip.md.
//
//   node apply.mjs --trip algarve-2026 --user severin [--dry-run]
//
// Re-running replaces the costs it wrote before, so correcting a category in
// costs.json and running again is the way to fix one.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die } from "../icloud-export/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const user = arg("user") ?? die("--user <name> is required.");
const dry = has("dry-run");

const CATEGORIES = ["preparation", "flights", "accommodation", "food", "transport", "activities", "other"];
const costsFile = join(ROOT, "export", trip, "costs.json");
if (!existsSync(costsFile)) die(`No ${costsFile}. Run parse.mjs --trip ${trip} … first.`);
const { transactions, rates } = JSON.parse(readFileSync(costsFile, "utf8"));

const TRIP = join(ROOT, "content", user, "trips", trip);
if (!existsSync(TRIP)) die(`No trip folder at ${TRIP}.`);

const bad = transactions.filter((t) => t.keep && t.category && !CATEGORIES.includes(t.category));
if (bad.length) die(`Unknown category on ${bad.length} row(s): ${[...new Set(bad.map((t) => t.category))].join(", ")}\n` +
  `Fernscout knows: ${CATEGORIES.join(", ")}`);

const keep = transactions.filter((t) => t.keep);
const uncategorised = keep.filter((t) => !t.category).length;

const byDay = {};
for (const t of keep) (byDay[t.date] ??= []).push(t);

const entries = readdirSync(join(TRIP, "entries")).filter((f) => f.endsWith(".md")).sort();
const MARK = "# from the bank statement";
let touched = 0, orphaned = [];

for (const [day, list] of Object.entries(byDay).sort()) {
  // A day can have several entries. The costs belong to the first one, and
  // "first" is the earliest `time:`, not the first filename alphabetically.
  const file = entries.filter((f) => f.startsWith(day)).sort((a, b) => {
    const t = (f) => readFileSync(join(TRIP, "entries", f), "utf8").match(/^time: "(.*)"/m)?.[1] ?? "";
    return t(a).localeCompare(t(b));
  })[0];
  if (!file) { orphaned.push([day, list]); continue; }
  const path = join(TRIP, "entries", file);
  const text = readFileSync(path, "utf8");

  const block = ["costs:  " + MARK,
    ...list.map((t) => `  - { label: ${JSON.stringify(t.label)}, amount: ${Math.abs(t.amount)}, ` +
      `category: "${t.category ?? "other"}", currency: "${t.currency}" }`)].join("\n");

  // replace the block we wrote last time, or insert one above `status:`
  const existing = new RegExp(`^costs:  ${MARK}\\n(?:  - .*\\n)*`, "m");
  const next = existing.test(text)
    ? text.replace(existing, block + "\n")
    : text.replace(/^status:/m, block + "\nstatus:");
  if (next !== text) { if (!dry) writeFileSync(path, next); touched++; }
  console.log(`${dry ? "would write" : "wrote"}  ${file}  ${list.length} cost(s)`);
}

// trip.md's rates: what one unit of the foreign currency actually cost, taken
// from the amounts the bank moved rather than from a rate table.
const tripFile = join(TRIP, "trip.md");
if (existsSync(tripFile) && rates && Object.keys(rates).length) {
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const lines = Object.entries(rates).map(([cur, list]) => `  ${cur}: ${median(list).toFixed(4)}`);
  const text = readFileSync(tripFile, "utf8");
  const block = `rates:  ${MARK}\n${lines.join("\n")}`;
  const existing = /^rates:.*\n(?:  \w{3}: .*\n)*/m;
  const next = existing.test(text) ? text.replace(existing, block + "\n")
                                   : text.replace(/^---\n/m, "---\n").replace(/\n---\n/, `\n${block}\n---\n`);
  if (!dry) writeFileSync(tripFile, next);
  console.log(`${dry ? "would write" : "wrote"}  trip.md  ${lines.join(", ").trim()}`);
}

console.log(`\n${touched} entr${touched === 1 ? "y" : "ies"} updated.`);
if (uncategorised) console.log(`${uncategorised} payment(s) had no category and were written as "other".`);
for (const [day, list] of orphaned)
  console.log(`No entry for ${day} — ${list.length} payment(s) not written. Add a day, or drop them in costs.json.`);
