#!/usr/bin/env node
// A bank statement on this machine → what the trip cost, in the journal.
//
//   node statement.mjs --user <username> --file import/revolut/statement.csv \
//                      --trip algarve-2026 --from 2026-06-22 --to 2026-07-01
//   node statement.mjs --user <username> --trip algarve-2026 --apply rows.json
//
// **This script parses nothing.** Reading the statement is the instance's job
// — `importers/costs/` in the fernscout repository, running on the server
// where every journal gets the same version of it. What is here is the half a
// server cannot do: find the file on somebody's own disk, and hand it over.
//
// It is deliberately two runs with a conversation in between. The first prints
// what the statement holds; the second sends back the rows a person has agreed,
// with the categories they chose. Nothing reaches a day in between.
import { existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { ROOT, arg, die } from "../shared/lib.mjs";
import { SITE, call, refusal, token } from "../shared/api.mjs";

const user = arg("user") ?? die("--user <username> is required.");
const file = arg("file");
const trip = arg("trip");
const from = arg("from");
const to = arg("to");
const apply = arg("apply");
const format = arg("format");

if (!file && !apply) die("--file <statement.csv> to read one, or --apply <rows.json> to write.");
token();

const money = (n) => n.toFixed(2).padStart(9);

async function fileFrom(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path)) chunks.push(chunk);
  return new File([Buffer.concat(chunks)], basename(path), { type: "text/csv" });
}

/**
 * Stage it where it belongs to no day, then read it from there.
 *
 * One upload door in v2 — `POST .../media`, with an `intent` saying what the
 * bytes are. A `bank_export` belongs to no day by its nature, and saying so is
 * a decline like any other rather than an omission.
 */
async function stage(path) {
  const form = new FormData();
  form.set("file", await fileFrom(path));
  form.set("intent", JSON.stringify({
    kind: "bank_export",
    declined: {
      trip: "a statement is read first and only then belongs to a trip",
      day: "a statement covers weeks, not one day",
    },
  }));
  const result = await call("POST", `/api/v2/${user}/media`, { body: form });
  if (!result.ok) die(`  the upload was refused:\n${refusal(result)}`);
  return result.body.items?.[0] ?? result.body;
}

async function read(path) {
  console.log(`\n${basename(path)}`);
  const staged = await stage(path);
  console.log(`  staged as ${staged.id}${staged.duplicate ? " (already there)" : ""}`);

  // v2 reads a staged statement through a door of its own —
  // `GET .../statements/{src}` — rather than through the import route, and it
  // writes nothing: a report to have the conversation over, which is the whole
  // shape of this skill. The window and the format are query parameters.
  const query = new URLSearchParams();
  if (format) query.set("format", format);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const src = encodeURIComponent(staged.src ?? staged.id);
  const result = await call("GET", `/api/v2/${user}/statements/${src}${query.size ? `?${query}` : ""}`);
  if (!result.ok) {
    console.error(`  refused:\n${refusal(result)}`);
    for (const problem of result.body?.problems ?? []) console.error(`      ${problem}`);
    process.exit(1);
  }

  const d = result.body;
  console.log(`  ${d.format} — ${d.read} rows in the file, ${d.spending.payments} of them spending`);
  if (!from && !to)
    console.log("  ⚠ no --from/--to: this is the whole statement, not the trip");

  console.log("\nBy day:");
  for (const day of d.spending.days) {
    console.log(`  ${day.date}  ${money(day.total)} ${day.currency}`);
    for (const p of day.payments)
      console.log(`       ${money(p.amount)} ${p.currency}  ${p.description}`);
  }

  console.log("\nBy merchant, biggest first — this is the list to agree:");
  for (const m of d.spending.merchants)
    console.log(`  ${money(m.total)} ${m.currency}  ${m.description}  (${m.payments}×)`);

  if (Object.keys(d.rates).length > 0) {
    console.log("\nWhat the money actually cost:");
    for (const [currency, rate] of Object.entries(d.rates))
      console.log(`  ${currency}: ${rate}   # 1 ${currency} = ${rate} in the account's currency`);
    console.log(
      `  These are v1's convention — units per 1 unit of the account's currency. A trip's\n` +
      `  rates are units per 1 EUR in v2, so do not copy a number across: send\n` +
      `  {"rates": {"currencies": [...]}} on the trip and let the server rate them.`,
    );
  }

  const { transfers, incoming } = d.skipped;
  if (transfers || incoming)
    console.log(
      `\nLeft out of the spending: ${transfers} transfer(s) and ${incoming} payment(s) coming in.`,
    );

  // A file to fill in, rather than a prompt: agreeing forty rows is a
  // conversation, and a conversation is not a thing to hold in argv.
  if (trip) {
    const out = resolve(ROOT, "export", `${trip}-costs.json`);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          trip,
          note:
            "Set a category on each row you want written, and delete the rows that were " +
            "not the trip. Categories: preparation, flights, accommodation, food, " +
            "transport, activities, other. A statement says what was paid, never what it " +
            "was for — agree these with the person whose money it was.",
          rows: d.spending.days.flatMap((day) =>
            day.payments.map((p) => ({
              date: day.date,
              label: p.description,
              amount: p.charged?.amount ?? p.amount,
              currency: p.charged?.currency ?? p.currency,
              category: null,
            })),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nexport/${trip}-costs.json written. Nothing is in the journal yet.`);
    console.log("Agree the categories with them, fill them in, then:");
    console.log(`  node statement.mjs --user ${user} --trip ${trip} --apply export/${trip}-costs.json`);
  } else {
    console.log("\nNothing is in the journal, and nothing will be until you send rows back.");
    console.log("Re-run with --trip <id> to get a file to agree the categories in.");
  }
}

async function write(path) {
  if (!trip) die("--apply needs --trip <id>: which trip these costs belong to.");
  const full = resolve(ROOT, path);
  if (!existsSync(full)) die(`No such file: ${full}`);
  const { rows } = JSON.parse(readFileSync(full, "utf8"));

  const missing = rows.filter((r) => !r.category);
  if (missing.length > 0)
    die(
      `${missing.length} row(s) have no category, and a category is not yours to choose.\n` +
        `Agree them first — ${missing.slice(0, 3).map((r) => r.label).join(", ")}${missing.length > 3 ? ", …" : ""}\n` +
        "Delete the rows that were not the trip rather than giving them one.",
    );

  const result = await call("POST", `/api/v2/${user}/trips/${trip}/costs/apply`, { body: { rows } });
  if (!result.ok) {
    console.error(`refused:\n${refusal(result)}`);
    for (const p of result.body?.problems ?? [])
      console.error(`      row ${p.row}: ${p.field} — ${p.expected}, got ${p.got}`);
    process.exit(1);
  }

  const d = result.body;
  console.log(d.message);
  for (const w of d.written)
    console.log(`  ${w.date}  ${w.slug}  +${w.added}${w.kept ? ` (kept ${w.kept} of theirs)` : ""}`);
  for (const o of d.orphaned) console.log(`  ${o.date}  no day written — ${o.rows} row(s) not recorded`);
  if (d.next) console.log(`\n${d.next}`);
}

console.log(`${SITE} · ${user}`);
if (file) await read(resolve(ROOT, file));
if (apply) await write(apply);
