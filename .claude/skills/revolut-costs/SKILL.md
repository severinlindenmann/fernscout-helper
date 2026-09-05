---
name: revolut-costs
description: Read a Revolut statement export and put what a trip actually cost into the journal — costs on each day, and the exchange rate the money really cost. Use when somebody says "add my budget", "import my Revolut statement", "what did the trip cost", "bring in the costs", or drops a bank CSV into import/.
---

# Revolut → what the trip cost

Revolut exports a **consolidated statement** as CSV: `Accounts` → the three-dot
menu → *Statement*, CSV, the period you want. Drop it in `import/revolut/`,
which is gitignored — somebody's account history is not this repository's
business, and it is going to hold merchant names, balances and an IBAN.

```bash
node parse.mjs --file import/revolut/consolidated_….csv \
               --from 2026-06-22 --to 2026-07-01 --trip algarve-2026
node apply.mjs --trip algarve-2026 --user severin --dry-run
node apply.mjs --trip algarve-2026 --user severin
```

## The one rule here

**A bank statement says what was paid, never what it was for.** "Nito, €28" is
a fact; "dinner in Lagos" is a guess. Propose categories, show the person the
list, and let them correct it — then write. Guessing quietly is how a journal
ends up saying something its author never said.

## 1. Parse, and read it back

`parse.mjs` reads the statement and writes **nothing into the journal**. It
prints:

- every payment, day by day, in the currency it was paid in
- the same payments **by merchant**, biggest first — the list to sort into
  categories, and much shorter than the list of payments
- **what the money actually cost**: the amount debited divided by the amount
  received, per currency, taken across every payment. That is the number
  `trip.md`'s `rates:` wants — `EUR: 0.9218` reads *1 EUR = 0.9218 CHF*, and it
  is easy to write upside down.

Transfers, exchanges and money coming in are left out — moving your own money
between your own pots is not a trip cost. They are **kept in `costs.json` and
marked**, never silently dropped, because "where did that €500 go" is a question
somebody will ask.

With `--trip`, it writes `export/<trip>/costs.json`: one row per payment, each
with `keep` and `category`.

## 2. Agree the categories

Fernscout knows exactly seven: `preparation`, `flights`, `accommodation`,
`food`, `transport`, `activities`, `other`. Anything else is refused by
`apply.mjs` rather than quietly turned into `other`.

Go through the merchant list **with the person**. Group it — twenty merchants
is a two-minute conversation, seventy payments is not. Two things to raise
rather than decide:

- **Subscriptions and work.** A statement that spans the trip also spans the
  month: hosting bills, an app subscription, the parking at home. They are in
  the range and they are not the holiday. Ask.
- **Anything you cannot name.** A payee that is just a person's name, or a bank
  transfer with no description, is not yours to classify.

Edit `costs.json` — `keep: false` to leave a payment out, `category` to set one.

## 3. Write it

`apply.mjs` puts a `costs:` block on the day's entry and the rate in `trip.md`.
Both are marked `# from the bank statement`, and **re-running replaces what it
wrote before** — so fixing a category is: edit `costs.json`, run again. It never
touches prose, titles or galleries.

Where a day has several entries, the costs go on the earliest one.

It reports what it could not place: a day with payments but no entry — usually a
day whose photographs were all turned off. Add the day, or set those payments to
`keep: false`. Do not leave it unsaid.

## 4. Then tell them what it says

The trip's costs page adds it up by category, by country and by day. Read the
total back to the person, along with anything you had to guess. Costs are
`costsVisibility: public` by default — everyone who can read the trip sees the
numbers. If that is not what they want, `costsVisibility: guests` in `trip.md`
narrows it to the people who were there and the readers they have approved.

## Another bank

The parser handles the shape Revolut writes: sections per account currency, one
money column when the account is in your base currency and two when it is not,
`"Jun 26, 2026"` dates, `-€50.00` and `1,150.69 CHF` amounts. A different bank
means a different reader — copy `parse.mjs`, keep `apply.mjs`, and it is the
same `costs.json` in the middle.
