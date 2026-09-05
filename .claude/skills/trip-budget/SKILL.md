---
name: trip-budget
description: Ask what a trip actually cost — flights, car hire, the hotel booked months ago, the cash nobody has a receipt for — and record it, including offering to read bank or credit-card statements. Use when somebody says "add the budget", "what did it cost", "add costs", "I paid for the flights", or when a trip's costs page is obviously missing the big lines.
---

# What the trip cost

A card statement is good at the coffee and bad at the trip. The flights were
booked in March, the hotel was paid on arrival in cash, the car was on somebody
else's card and settled later. **Those are the biggest lines and they are the
ones nobody thinks to mention** — which is why this skill asks rather than waits.

```bash
node costs.mjs check  --trip <trip> --user <user>          # what is there, what is not
node costs.mjs add    --trip … --user … --before  --label "Flights" --amount 780 --currency CHF --category flights
node costs.mjs add    --trip … --user … --day 2026-06-24 --label "Car hire" --amount 240 --currency EUR --category transport
node costs.mjs budget --trip … --user … --total 3000 --days 10 --currency CHF
```

## Start by looking

```bash
node costs.mjs check --trip algarve-2026 --user severin
```

It prints what is recorded, by category, which days have nothing, and which of
the three usual big lines — flights, accommodation, transport — are missing
entirely. **Ask about what it names, not about everything.** A person who has
already imported a statement does not want to be asked about lunch.

## Then ask, in this order

Ask a few at a time, in the person's own language, and take "I do not remember"
for an answer. An empty field beats a made-up number: the costs page says
"not counted" rather than inventing a total, which is the honest outcome.

**Before the trip** — these go in `costs.md` with `--before`:

| Ask about | Category |
| --- | --- |
| Flights, trains, ferries to get there and back | `flights` |
| Accommodation booked and paid in advance | `accommodation` |
| Car hire, rail pass, transfers booked ahead | `transport` |
| Tours, tickets, permits bought before leaving | `activities` |
| Insurance, visas, vaccinations, gear, bags | `preparation` |

**During the trip** — these go on a day with `--day`:

| Ask about | Category |
| --- | --- |
| Anything paid **in cash** — a statement never sees it | wherever it belongs |
| Fuel, tolls, parking, taxis | `transport` |
| The hotel bill settled at the desk | `accommodation` |
| Excursions, entrance fees, equipment hire | `activities` |
| Anything somebody else paid and was paid back for | wherever it belongs |

**And the budget itself**: what was the trip meant to cost, over how many days?
`costs.mjs budget` writes it, and the costs page then draws the real spending
against it.

## Ask about statements too

Say it plainly, once: *"If you have a bank or credit-card statement for those
dates, I can read it and add everything at once — you would only have to tell me
which lines were not the trip."*

- **Revolut** → the `revolut-costs` skill, which already knows the format.
- **Any other bank or card** → ask for a CSV export covering the trip dates. The
  shape differs per bank; `revolut-costs/parse.mjs` is the model to copy, and
  `apply.mjs` is reused unchanged — it is the same `costs.json` in the middle.
- **A PDF statement** is not worth parsing. Ask them to read out the handful of
  lines that were the trip, or export CSV instead.

**Say where the file goes and what happens to it:** `import/`, which is
gitignored, and nothing leaves the machine. A statement carries an IBAN, a
balance and every merchant somebody has paid for months. If they would rather
not, the interview above gets the big lines anyway.

## What the scripts guarantee

- Fernscout knows seven categories — `preparation`, `flights`, `accommodation`,
  `food`, `transport`, `activities`, `other` — and anything else is refused
  rather than quietly turned into `other`.
- A cost written by a person and a cost read from a statement live in the same
  list, and only the statement's own lines carry `# bank`. A re-import replaces
  those and **never touches the ones somebody typed**.
- `--day` needs an entry for that date. If there is none — a day whose
  photographs were all turned off — say so and ask whether to add the day, rather
  than moving the cost to a day it did not happen on.

## The one rule

**Do not invent an amount, and do not estimate one.** Not "flights were probably
around 300", not a per-day average filled in for a day nobody remembers. If they
do not know, it does not get recorded, and the page says as much. This is
somebody's money, in a document their family will read.
