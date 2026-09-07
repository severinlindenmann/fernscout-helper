---
name: statement-costs
description: Read a bank or card statement on this machine and put what a trip actually cost into the journal — costs on each day, and the exchange rate the money really cost. Use when somebody says "add my budget", "import my Revolut statement", "what did the trip cost", "bring in the costs", or drops a bank CSV into import/.
---

# A statement → what the trip cost

Revolut exports a **consolidated statement** as CSV: `Accounts` → the
three-dot menu → *Statement*, CSV, the period you want. Drop it in
`import/revolut/`, which is gitignored — somebody's account history is not this
repository's business, and it holds merchant names, balances and an IBAN.

**The parsing happens on the instance, not here.** `importers/costs/` in the
fernscout repository reads the file; this skill finds it on the machine, hands
it over, and holds the conversation in the middle. A bank nobody has written a
reader for yet is a file to contribute *there*, once, for every journal — not a
script on one laptop.

```bash
export FERNSCOUT_TOKEN=…                       # seven days; see `publish`
node .claude/skills/statement-costs/statement.mjs --user <username> \
     --file import/revolut/statement.csv --trip algarve-2026 \
     --from 2026-06-22 --to 2026-07-01
# … agree the categories with them, fill them into the file …
node .claude/skills/statement-costs/statement.mjs --user <username> \
     --trip algarve-2026 --apply export/algarve-2026-costs.json
```

```
--user <username>   which journal. Required
--file <path>       the statement to read
--trip <id>         which trip; also names the file you agree categories in
--from / --to       ISO dates. Send them: a statement holds the fortnight either side
--apply <rows.json> send the agreed rows back, and write them
--format <id>       name the bank instead of letting the file be recognised
```

## The one rule here

**A bank statement says what was paid, never what it was for.** "Nito, €28" is
a fact; "dinner in Lagos" is a guess. The instance drops the bank's own
category on the way in, deliberately, so there is nothing to be tempted by.
Propose, show the list, let them correct it — then write.

`other` is a real category and a good one. A plausible category you chose is
the kind of fiction nobody catches later.

## 1. Read it back

The first run prints what the statement holds: the spending day by day, the
same payments **by merchant** biggest-first, what was left out (transfers,
money coming in — counted, never silently dropped), and **what the money
actually cost** — the amount debited divided by the amount received, per
currency. That last number is what `trip.md`'s `rates:` wants, and it is easy
to write upside down.

**Send `--from` and `--to`.** Without them you get the whole statement, which
includes the rent.

Nothing is written by this run. With `--trip` it leaves
`export/<trip>-costs.json`: one row per payment, each with `category: null`.

## 2. Agree the categories

Seven exist: `preparation`, `flights`, `accommodation`, `food`, `transport`,
`activities`, `other`. Anything else is refused rather than turned into
`other`.

Go through the **merchant** list with the person — twenty merchants is a
two-minute conversation, seventy payments is not, and one decision about a
merchant covers every payment to it. Two things to raise rather than decide:

- **Subscriptions and the month.** A statement spanning the trip also spans the
  month: hosting bills, an app subscription, the parking at home. They are in
  the range and they are not the holiday. Ask.
- **Anything you cannot name.** A payee that is just a person's name, or a
  transfer with no description, is not yours to classify.

Delete the rows that were not the trip. Do not give them a category to get rid
of them.

## 3. Write it

`--apply` sends the agreed rows. The instance puts them on the day each one
happened, and:

- **adds, never replaces** — costs somebody wrote by hand stay;
- **picks the earliest day** when a date has several, by `time:`;
- **reports a date with no day** rather than attaching it to a neighbour.

Sending the same file twice writes the costs twice. If you need to correct one,
say so and fix it on the day rather than re-running.

The run refuses outright if any row still has `category: null`, which is the
one thing this skill will not do on somebody's behalf.

## 4. Then tell them what it says

The trip's costs page adds it up by category, by country and by day. Read the
total back, along with anything you were unsure about. Costs are
`costsVisibility: public` by default — everyone who can read the trip sees the
numbers; `costsVisibility: guests` narrows it.

The rates are **not** written by any of this. If the trip has none, offer them:
`PUT /api/v1/<user>/trips/<trip>/rates`.

## Another bank

Write an importer, in the fernscout repository, under `importers/costs/`. It is
MIT-licensed, it is one file, and `importers/costs/schema.ts` is the whole
contract — a `Payment` is `{date, amount, currency, description}` with the sign
the statement wrote. Then every journal can read that bank, not just this
laptop.
