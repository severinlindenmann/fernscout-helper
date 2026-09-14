---
name: validate-content
description: Check a journal in content/ against the instance that will receive it — what is wrong, what will be refused, and which options exist and are not set. Use when somebody says "check my journal", "is this right", "validate", "did I forget anything", "what else can I set", or before publishing anything.
---

# Is this journal right, and what have I not set?

```bash
node .claude/skills/validate-content/validate.mjs --user <username>
```

It reads every file under `content/<username>/`, compares it against the
contract the instance itself publishes at `<site>/openapi.json`, and prints
what it finds. **It changes nothing** — not the files, not the site.

```
node validate.mjs                       every journal in content/
node validate.mjs --user severin        one of them
node validate.mjs --trip algarve-2026   one trip
node validate.mjs --all                 every occurrence, not a count per repeated finding
node validate.mjs --json                for a program to read
node validate.mjs --offline             the cached schema, no network
node validate.mjs --refresh             fetch the schema again now
```

`FERNSCOUT_URL` picks a different instance; it defaults to
`https://fernscout.ch`. No token is needed — the contract is public.

## What the three marks mean

| | | |
| --- | --- | --- |
| `✗` | error | The instance will refuse this, or the site cannot read it. Publishing is blocked. |
| `!` | warning | It will be accepted and is probably not what anybody meant. |
| `·` | tip | An option that exists and is not set. **Never a defect.** |

**A tip is an offer, not a to-do list.** "`tags` is not set" on fourteen days
is a thing worth knowing once; it is not fourteen jobs, and a journal with no
tags is a perfectly good journal. Read the tips out to the person as *choices
available*, and let them pick. Do not work down the list.

## How to use it in a conversation

1. **Run it and read the errors out.** They are specific and they name the
   file and the line. Fix those first, in the files.
2. **Take the warnings one at a time.** Each is a real question — "a budget is
   set and none of the fourteen days records any spending" is either true or
   it means somebody's costs never left their laptop, and only they know
   which.
3. **Offer the tips as a short list**, in their own words: *"you could add
   coordinates, tags, or what each day cost — do any of those matter to you?"*
   Then stop and let them answer.
4. **Never invent a value to clear a finding.** An empty field is a question
   somebody can answer in four seconds; a filled-in one is a lie they may
   never notice. This is the repository's one rule and it applies hardest
   here, because a validator makes filling things in feel like tidying up.

## What it checks

**What the instance would accept — by asking it.** Every trip and every day is
sent through `?dryRun=true`, which writes nothing and answers with what it
would have accepted, or refuses with the field, what arrived, what was
expected, and — for a section that is neither answered nor declined — the key
that would decline it.

That is the whole of this half, and the reason it is not more than that is
worth stating: this repository has re-derived the instance's rules twice and
been wrong both times. `model.mjs` was a hand-kept copy of the file shape and
fell behind. Reading `/content-model.json` replaced it, and that document then
described v1 for a year while the instance refused what it advertised. A
validator that asks cannot drift; a validator that knows will.

**The things only a folder can answer**, which is the half no server can do
because it has never seen the disk:

- every `media` `src` has a file behind it
- `media/<folder>/` and `originals/<folder>/` that no day names
- the filename's date against the document's own — the filename IS the day's
  address on the instance, so the two disagreeing is a real fault
- two files claiming one slug
- a day outside its trip's dates
- a trip naming a figure that `figures/<id>.json` does not hold
- a folder still in the old Markdown shape, which is an error with the
  converter's command beside it

## Online and offline

`--offline` runs the disk half alone and **says so in the report**. It is a
weaker check and it must not be reported as a clean bill of health: the
instance's own rules were never consulted. Without the flag the run needs the
owner's token, because a dry run is still a write route.

## Then

When there are no errors, `publish` sends it. That skill refuses to start
while this one reports any, which is deliberate: a half-written journal is
worse than one that has not started.
