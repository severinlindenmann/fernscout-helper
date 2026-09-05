#!/usr/bin/env node
// The costs a bank statement cannot tell you: what the flights were, what the
// car cost, what was paid in cash. Three verbs.
//
//   node costs.mjs check   --trip algarve-2026 --user severin
//   node costs.mjs add     --trip … --user … --day 2026-06-22 \
//                          --label "Flüge Basel–Faro" --amount 780 --currency CHF --category flights
//   node costs.mjs add     --trip … --user … --before   (…same, into costs.md)
//   node costs.mjs budget  --trip … --user … --total 3000 --days 10 --currency CHF
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die, argv } from "../shared/lib.mjs";
import { CATEGORIES, MARK, costLine, readCostLines, writeCostLines, readCostsMd, writeCostsMd } from "../shared/costfile.mjs";

const verb = argv[0];
const trip = arg("trip") ?? die("--trip <name> is required.");
const user = arg("user") ?? die("--user <name> is required.");
const TRIP = join(ROOT, "content", user, "trips", trip);
if (!existsSync(TRIP)) die(`No trip folder at ${TRIP}.`);

const entryFiles = existsSync(join(TRIP, "entries"))
  ? readdirSync(join(TRIP, "entries")).filter((f) => f.endsWith(".md")).sort() : [];
const entryFor = (day) => {
  const same = entryFiles.filter((f) => f.startsWith(day));
  return same.sort((a, b) => {
    const t = (f) => readFileSync(join(TRIP, "entries", f), "utf8").match(/^time: "(.*)"/m)?.[1] ?? "";
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
  const cost = { label, amount, currency, category };

  if (has("before")) {                       // paid before leaving → costs.md
    const { own, bank } = readCostsMd(TRIP);
    writeCostsMd(TRIP, { lines: [...own, ...bank, costLine(cost)] });
    console.log(`Added to costs.md: ${label}, ${amount} ${currency ?? ""} (${category})`);
  } else {
    const day = arg("day") ?? die("--day YYYY-MM-DD, or --before for something paid before the trip.");
    const file = entryFor(day) ?? die(`No entry for ${day}. Add the day first, or use --before.`);
    const path = join(TRIP, "entries", file);
    const { own, bank } = readCostLines(readFileSync(path, "utf8"));
    writeCostLines(path, [...own, costLine(cost), ...bank]);
    console.log(`Added to ${file}: ${label}, ${amount} ${currency ?? ""} (${category})`);
  }
  process.exit(0);
}

if (verb === "budget") {
  const total = Number(arg("total")), days = Number(arg("days"));
  const currency = arg("currency") ?? "CHF";
  if (!Number.isFinite(total) || !Number.isFinite(days)) die("--total and --days must be numbers.");
  const { own, bank } = readCostsMd(TRIP);
  writeCostsMd(TRIP, { budget: { total, days, currency }, lines: [...own, ...bank] });
  console.log(`Budget: ${total} ${currency} over ${days} days.`);
  process.exit(0);
}

if (verb !== "check") die("Say: check, add, or budget.");

// check — what is recorded, and what is conspicuously absent. It asks the
// questions; it never answers them.
const parse = (line) => ({
  amount: Number(line.match(/amount: ([\d.]+)/)?.[1] ?? 0),
  currency: line.match(/currency: "(\w{3})"/)?.[1] ?? null,
  category: line.match(/category: "(\w+)"/)?.[1] ?? "other",
  label: line.match(/label: "(.*?)"/)?.[1] ?? "",
  bank: line.includes(MARK),
});

const md = readCostsMd(TRIP);
const before = [...md.own, ...md.bank].map(parse);
const days = {};
for (const f of entryFiles) {
  const text = readFileSync(join(TRIP, "entries", f), "utf8");
  const day = text.match(/^date: "(.*)"/m)?.[1] ?? f.slice(0, 10);
  const { own, bank } = readCostLines(text);
  (days[day] ??= []).push(...[...own, ...bank].map(parse));
}

const all = [...before, ...Object.values(days).flat()];
const seen = new Set(all.map((c) => c.category));
console.log(`${trip}: ${entryFiles.length} entries, ${all.length} costs recorded ` +
  `(${all.filter((c) => c.bank).length} from a statement, ${all.filter((c) => !c.bank).length} by hand).`);

const budget = md.text?.match(/^budget:\n(?:  \w+: .*\n)+/m)?.[0];
console.log(budget ? `\n${budget.trim()}` : `\nNo budget set. Ask what the trip was meant to cost, then: costs.mjs budget …`);

console.log(`\nRecorded, by category:`);
for (const c of CATEGORIES) {
  const list = all.filter((x) => x.category === c);
  console.log(`  ${c.padEnd(14)} ${list.length ? String(list.length).padStart(3) + " item(s)" : "  — nothing"}`);
}

console.log(`\nDays with nothing recorded:`);
const empty = Object.entries(days).filter(([, list]) => !list.length).map(([d]) => d);
console.log(empty.length ? "  " + empty.join(", ") : "  none");

const missing = ["flights", "accommodation", "transport"].filter((c) => !seen.has(c));
if (missing.length) console.log(`\nNothing at all under: ${missing.join(", ")}. ` +
  `Worth asking about — these are usually the biggest lines and almost never on a card statement in full.`);
