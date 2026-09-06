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

**Against the instance's published schema** — every field, its type, and the
values it accepts, fetched live and cached for a day. A key that is not a
field is an error with a suggestion (`visibilty` → `visibility`), because a
key nothing reads is silently dropped and the write still says it worked.

**The file format itself** — the keys that never cross the API, and so cannot
be in that schema: `gallery:` is the media call, `status: draft` is the publish
call, `id:` is the folder's name.

**The things only a folder can answer**, which is the half no server can do:

- every `gallery:` `src` is actually on disk, in a format the instance takes,
  and not empty
- `media/<slug>/` folders that belong to no day
- the filename's date against the frontmatter's, and both against the trip
- two files sharing a slug
- dates inside the trip that have no day at all
- a budget with no day-level spending anywhere under it
- a day with `lat`/`lng` and no `weather:` — tipped as an offer to ask the
  Open-Meteo archive what the day actually was, via `publish --weather`; a day
  with no coordinates gets no tip, because there is nothing honest to offer it.
  If the journal has not switched `features.weather` on in `config.json`, the
  tip says that instead of the archive offer — asking without it is accepted
  and does nothing

**Drift between these tools and the instance**, in both directions. A field
the instance accepts that this repository does not offer is a tip; a key these
tools write that the instance does not list is a warning, because it will be
dropped on publish and nothing will say so.

## When the schema cannot be fetched

It says so and checks the file format alone. That is a weaker check, and the
report says which one you got — do not report a clean run as a clean bill
when the instance's own rules were never consulted.

## Then

When there are no errors, `publish` sends it. That skill refuses to start
while this one reports any, which is deliberate: a half-written journal is
worse than one that has not started.
