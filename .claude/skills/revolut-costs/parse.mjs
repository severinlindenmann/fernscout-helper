#!/usr/bin/env node
// Read a Revolut consolidated statement and pull out what was spent on a trip.
//
//   node parse.mjs --file import/revolut/consolidated_….csv \
//                  --from 2026-06-22 --to 2026-07-01 [--trip algarve-2026]
//
// Writes export/<trip>/costs.json when --trip is given, and always prints the
// days, the merchants and the exchange rate the trip actually cost.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, arg, die, splitCsv } from "../icloud-export/lib.mjs";

const file = arg("file") ?? die("--file <statement.csv> is required.");
const from = arg("from"), to = arg("to"), trip = arg("trip");
const path = resolve(ROOT, file);
if (!existsSync(path)) die(`No such file: ${path}`);

// "-€50.00" · "1,150.69 CHF" · "-46.09 CHF" · "€0.00"
const SYMBOL = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY" };
function money(cell) {
  if (!cell) return null;
  const m = cell.trim().match(/^(-?)\s*([€$£¥]?)\s*(-?[\d,.]+)\s*([A-Z]{3})?$/);
  if (!m) return null;
  const [, sign, sym, num, code] = m;
  const currency = code ?? SYMBOL[sym];
  if (!currency) return null;
  const value = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { amount: (sign === "-" ? -1 : 1) * value, currency };
}

// "Jun 26, 2026" → "2026-06-26"
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function isoDate(cell) {
  const m = cell.trim().match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  if (!m) return null;
  const mm = MONTHS.indexOf(m[1]) + 1;
  return mm ? `${m[3]}-${String(mm).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// The statement is sections, one per account, each with its own little table.
// A header row tells us whether the money columns are one (the account is in
// the base currency) or two (local, then base).
const lines = readFileSync(path, "utf8").split(/\r?\n/);
const rows = [];
let account = "", cols = null;
for (const line of lines) {
  const c = splitCsv(line);
  const first = c[0]?.trim();
  if (/^[A-Za-z].*\([A-Z]{3}\)$/.test(first ?? "")) { account = first; cols = null; continue; }
  if (first === "Date" && c[1] === "Description") {
    cols = { dual: c[3] === "Money in/out" && c[4] === "Money in/out" };
    continue;
  }
  if (!cols || !first) continue;
  const date = isoDate(first);
  if (!date) { if (first === "Total") cols = null; continue; }
  const local = money(c[3]);
  const base = cols.dual ? money(c[4]) : local;
  if (!local || !base) continue;
  rows.push({ date, description: c[1], revolutCategory: c[2], account,
              amount: local.amount, currency: local.currency,
              base: base.amount, baseCurrency: base.currency });
}
if (!rows.length) die("No transactions found. Is this a Revolut consolidated statement?");

const inRange = rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
// Moving your own money between your own pots is not a trip cost. Never dropped
// silently — they are listed below and kept in the file, marked.
const isTransfer = (r) => /^(Exchange|Transfers?|Top-Up)$/i.test(r.revolutCategory) ||
                          /^Transfer (to|from) Revolut/i.test(r.description);
const spend = inRange.filter((r) => r.amount < 0 && !isTransfer(r));
const skipped = inRange.filter((r) => isTransfer(r) || r.amount >= 0);

console.log(`${rows.length} transactions in the statement, ${inRange.length} between ${from ?? "the start"} and ${to ?? "the end"}.\n`);

const byDay = {};
for (const r of spend) (byDay[r.date] ??= []).push(r);
for (const [day, list] of Object.entries(byDay).sort()) {
  const total = list.reduce((n, r) => n + r.base, 0);
  console.log(`${day}   ${(-total).toFixed(2)} ${list[0].baseCurrency}`);
  for (const r of list.sort((a, b) => a.base - b.base))
    console.log(`   ${(-r.amount).toFixed(2).padStart(8)} ${r.currency}  ${r.description}`);
}

const merchants = {};
for (const r of spend) merchants[r.description] = (merchants[r.description] ?? 0) - r.base;
console.log(`\nBy merchant, biggest first — this is the list to sort into categories:`);
for (const [name, total] of Object.entries(merchants).sort((a, b) => b[1] - a[1]))
  console.log(`   ${total.toFixed(2).padStart(9)}  ${name}`);

// What one unit of the foreign currency actually cost, from the amounts the
// bank moved: the debit divided by what was received. This is the number
// trip.md's `rates:` wants, and it is easy to write upside down.
const rates = {};
for (const r of spend) {
  if (r.currency === r.baseCurrency) continue;
  (rates[r.currency] ??= []).push(Math.abs(r.base) / Math.abs(r.amount));
}
if (Object.keys(rates).length) {
  console.log(`\nWhat the money actually cost (for trip.md → rates:):`);
  for (const [cur, list] of Object.entries(rates)) {
    const median = list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
    console.log(`   ${cur}: ${median.toFixed(4)}   # 1 ${cur} = ${median.toFixed(4)} ${spend[0].baseCurrency}, from ${list.length} payments`);
  }
}

const total = spend.reduce((n, r) => n + r.base, 0);
console.log(`\n${spend.length} payments, ${(-total).toFixed(2)} ${spend[0]?.baseCurrency ?? ""} in total.`);
if (skipped.length) console.log(`${skipped.length} rows left out as transfers, exchanges or money coming in — they are in the file, marked "skip".`);

if (trip) {
  const dir = join(ROOT, "export", trip);
  mkdirSync(dir, { recursive: true });
  const out = [
    ...spend.map((r, i) => ({ id: `s${i}`, ...r, keep: true, category: null, label: r.description })),
    ...skipped.map((r, i) => ({ id: `x${i}`, ...r, keep: false, skip: "transfer or money in", category: null, label: r.description })),
  ];
  writeFileSync(join(dir, "costs.json"), JSON.stringify({ trip, from, to, rates, transactions: out }, null, 2));
  console.log(`\nexport/${trip}/costs.json written. Nothing is in the journal yet.`);
  console.log(`Next: agree the categories with the person, then node apply.mjs --trip ${trip} --user <user>`);
}
