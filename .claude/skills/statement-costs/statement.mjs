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

/** Stage it in the inbox, where it belongs to no day, then read it from there. */
async function stage(path) {
  const form = new FormData();
  form.append("files", await fileFrom(path));
  form.append("meta", JSON.stringify({ description: "" }));
  const result = await call("POST", `/api/v1/${user}/inbox`, { body: form });
  if (!result.ok) die(`  the inbox refused it:\n${refusal(result)}`);
  return result.body.items[0];
}

async function read(path) {
  console.log(`\n${basename(path)}`);
  const staged = await stage(path);
  console.log(`  staged as ${staged.id}${staged.duplicate ? " (already there)" : ""}`);

  const body = { kind: "costs", inbox: staged.id };
  if (format) body.format = format;
  if (from) body.from = from;
  if (to) body.to = to;
  const result = await call("POST", `/api/v1/${user}/import`, { body });
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
    console.log(`  Send these to PUT /api/v1/${user}/trips/<trip>/rates if the trip has none.`);
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

  const result = await call("POST", `/api/v1/${user}/trips/${trip}/costs/import`, { body: { rows } });
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
