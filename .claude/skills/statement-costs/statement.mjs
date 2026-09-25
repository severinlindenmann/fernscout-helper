#!/usr/bin/env node
// A bank statement on this machine → what the trip cost, in the journal.
//
//   node statement.mjs --user <username> --file import/revolut/statement.csv \
//                      --trip example-trip-2024 --from 2026-06-22 --to 2026-07-01
//   node statement.mjs --user <username> --trip example-trip-2024 --apply rows.json
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
 * bytes are. A `bank_export` is asked two things, `trip` and `format`, and each
 * is answered or declined; `day` is not asked of it at all, and sending it is
 * refused rather than ignored.
 */
async function stage(path) {
  const form = new FormData();
  form.set("file", await fileFrom(path));
  form.set("intent", JSON.stringify({
    kind: "bank_export",
    ...(trip ? { trip } : {}),
    ...(format ? { format } : {}),
    declined: {
      ...(trip ? {} : { trip: "a statement is read first and only then belongs to a trip" }),
      ...(format ? {} : { format: "let the server detect it" }),
    },
  }));
  const result = await call("POST", `/api/v2/${user}/media`, { body: form });
  if (!result.ok) die(`  the upload was refused:\n${refusal(result)}`);
  const item = result.body.items?.[0] ?? result.body;
  if (!item?.src) die(`  the upload accepted nothing back: ${JSON.stringify(result.body).slice(0, 200)}`);
  return item;
}

async function read(path) {
  console.log(`\n${basename(path)}`);
  const staged = await stage(path);
  console.log(`  staged as ${staged.src}${staged.duplicateOf ? " (already there)" : ""}`);

  // v2 reads a staged statement through a door of its own —
  // `GET .../statements/{src}` — and writes nothing: a report to have the
  // conversation over, which is the whole shape of this skill. It takes no
  // query: the format rode on the upload's intent, and the trip's window is
  // applied here, to what is shown, since it changes nothing on the server.
  const result = await call("GET", `/api/v2/${user}/statements/${encodeURIComponent(staged.src)}`);
  if (!result.ok) die(`  refused:\n${refusal(result)}`);

  const d = result.body;
  const inWindow = (date) => (!from || date >= from) && (!to || date <= to);
  const payments = d.payments.filter((p) => inWindow(p.date));
  console.log(
    `  ${d.dateRange.from ?? "?"} → ${d.dateRange.to ?? "?"} — ${d.payments.length} payment(s)` +
      (from || to ? `, ${payments.length} of them between ${from ?? "the start"} and ${to ?? "the end"}` : ""),
  );
  if (!from && !to)
    console.log("  ⚠ no --from/--to: this is the whole statement, not the trip");

  console.log("\nBy day:");
  const byDay = new Map();
  for (const p of payments) byDay.set(p.date, [...(byDay.get(p.date) ?? []), p]);
  for (const [date, list] of byDay) {
    console.log(`  ${date}`);
    for (const p of list) console.log(`       ${money(p.amount)} ${p.currency}  ${p.label}`);
  }

  // The server's merchant list is over the whole statement; the window is
  // only ours, so it is totalled again here from the payments inside it.
  const merchants = new Map();
  for (const p of payments) {
    const key = `${p.merchant}\u0000${p.currency}`;
    const m = merchants.get(key) ?? { name: p.merchant, currency: p.currency, total: 0, count: 0 };
    m.total += p.amount;
    m.count += 1;
    merchants.set(key, m);
  }
  console.log("\nBy merchant, biggest first — this is the list to agree:");
  for (const m of [...merchants.values()].sort((x, y) => y.total - x.total))
    console.log(`  ${money(m.total)} ${m.currency}  ${m.name}  (${m.count}×)`);

  if (Object.keys(d.rates).length > 0) {
    console.log("\nWhat the money actually cost — the median rate paid, for currencies the trip's own rates don't cover:");
    for (const [currency, rate] of Object.entries(d.rates))
      console.log(`  1 ${currency} = ${rate} in the account's currency`);
    console.log(
      `  Do not copy a number across by hand: send {"rates": {"currencies": [...]}} on the\n` +
      `  trip and let the server rate them.`,
    );
  }

  // A file to fill in, rather than a prompt: agreeing forty rows is a
  // conversation, and a conversation is not a thing to hold in argv.
  if (trip) {
    const out = resolve(ROOT, "export", `${trip}-costs.json`);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          trip,
          statement: staged.src,
          note:
            "Set a category on each row you want written, and delete the rows that were " +
            "not the trip. Categories: preparation, flights, accommodation, food, " +
            "transport, activities, other. A statement says what was paid, never what it " +
            "was for — agree these with the person whose money it was.",
          rows: payments.map((p) => ({
            date: p.date,
            label: p.label,
            amount: p.amount,
            currency: p.currency,
            category: null,
          })),
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
  const { rows, statement } = JSON.parse(readFileSync(full, "utf8"));

  const missing = rows.filter((r) => !r.category);
  if (missing.length > 0)
    die(
      `${missing.length} row(s) have no category, and a category is not yours to choose.\n` +
        `Agree them first — ${missing.slice(0, 3).map((r) => r.label).join(", ")}${missing.length > 3 ? ", …" : ""}\n` +
        "Delete the rows that were not the trip rather than giving them one.",
    );

  const body = { rows, ...(statement ? { statement } : {}) };
  const result = await call("POST", `/api/v2/${user}/trips/${trip}/costs/apply`, { body });
  if (!result.ok) die(`refused:\n${refusal(result)}`);

  const d = result.body;
  for (const w of d.written ?? [])
    console.log(`  ${w.date}  ${w.slug}  +${w.added}${w.kept ? ` (kept ${w.kept} of theirs)` : ""}`);
  // A date with no day written is not dropped (B1844): it goes on the trip's
  // own costs, the block for spend that belongs to no day.
  for (const f of d.filedToTrip ?? [])
    console.log(`  ${f.date}  no day that date — ${f.rows} row(s) filed to the trip's own costs`);
  if (d.total !== undefined) console.log(`\n${d.total} row(s) written.`);
}

console.log(`${SITE} · ${user}`);
if (file) await read(resolve(ROOT, file));
if (apply) await write(apply);
