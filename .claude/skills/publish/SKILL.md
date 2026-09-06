---
name: publish
description: Send everything in content/ to a running Fernscout instance — creating the trip, writing every day, uploading the photographs and putting them on the site, without asking about each one. Use when somebody says "publish", "upload my journal", "put it online", "send it to fernscout", or "sync the trip".
---

# Publish

```bash
export FERNSCOUT_TOKEN=…                       # seven days; see below
node .claude/skills/publish/publish.mjs --user <username> --dry-run
node .claude/skills/publish/publish.mjs --user <username>
```

It compares what is on disk with what the instance already has and makes up
the difference. A trip that is not there is created; a day that is not there
is written; a day that is there is updated; photographs the day does not have
yet are sent; then each day is published.

**Running it twice is safe and does not duplicate anything** — no second trip,
no second day, no photograph uploaded twice. It is not silent, though: a second
run still sends the day bodies again, because the folder is the source of
truth and re-sending is how an edit on disk reaches the site. So the plan it
prints on a second run is shorter than the first, not empty.

For a trip that already exists, only what has its own door goes out on a
second run: `visibility`/`listed`, `rates`, `people`, `travellers` and
`tracks`. `title`, `start`, `end`, `tagline`, `accent`, `intro` and
`translations` have no door yet on an existing trip (B245, in the fernscout
repo) — editing those in `trip.md` after the trip is created does not reach
the site, and the run prints a warning naming whichever of them it finds
disagreeing with what the site shows, rather than reaching the site.

**Retitling a day is safe.** The first time this script writes a day it
records the slug the instance assigned back into that entry's own frontmatter
(`slug: "…"`, alongside `title:` and `date:`) — the same idea as a trip's own
`id:`. A later run matches by that recorded slug first, so fixing a typo in
`title:` still finds the same day and updates it, rather than looking like a
new one. A day written before this existed, or one edited before ever being
published again, falls back to matching by date and title as it always did,
and — only if that misses too and exactly one day on the instance shares the
date — to the date alone, which the run prints as a guess (`⚠ matched … loosely,
by date alone`). Two days sharing a date are never guessed between; a
genuinely new day on a date that already has one is still created.

```
--user <username>     which journal. Required
--email <address>     create the journal too, if it is not there yet
--code <six digits>   the code that address was mailed
--trip <id>           just one trip
--dry-run             print every call it would make, send none
--offline             with --dry-run: skip even the reads, print an unconfirmed plan
--drafts              write and upload, but do not put anything on the site
--skip-validate       start even though validate-content reports errors
```

`FERNSCOUT_URL` picks a different instance; it defaults to
`https://fernscout.ch`.

## Run the dry run first, always

```bash
node publish.mjs --user severin --dry-run
```

It prints the whole plan — every trip, every day, every batch of photographs —
and sends nothing. It does still *ask* the site what each day already holds
(reads only, nothing is sent), because that is the only way the photograph
count it prints is the count a real run would then send — a day that already
has 60 of its 75 photographs reports 15 pending, not 75. Read the plan back to
the person before the real run. It is the one cheap moment to notice that a
trip is about to be created twice under two ids, or that fourteen days are
about to go up when they meant one.

Add `--offline` to skip those reads too and get a plan with no network at all.
It is faster, and it is a guess: it cannot see what the site already has, so it
prints the whole local gallery as pending for every day, and says plainly that
the numbers are unconfirmed. Reach for it only when there truly is no
connection — the ordinary dry run is the one worth reading back to a person.

## Two things it will not do

**It will not start while `validate-content` reports an error.** Half a
journal on a website is worse than none, and the errors are cheap to read
first. `--skip-validate` exists and is almost never the right answer; if you
reach for it, say out loud what you are overriding.

**It cannot create the journal without one question.** A new journal is bound
to an address somebody owns, and a six-digit code goes to that address; no
script can read their mail. So it is two runs and exactly one question:

```bash
node publish.mjs --user them --email them@example.com            # asks for the code
node publish.mjs --user them --email them@example.com --code 123456
```

`--dry-run` will not mail the code — it says it would and stops, because a
signup mail is not a thing to rehearse. So for a journal that does not exist
yet the dry run cannot show you a full plan; there is nothing to plan against
until the journal is there.

The second run creates the journal from `config.json`, then does the whole
publish in the same breath — trip, days, photographs, on the site. It prints a
**sign-in link for the person** (once, fifteen minutes) and the journal's own
seven-day token. Hand over the sign-in link in your reply, immediately; do not
write the token into a file in this repository.

## About publishing, which is the part that matters

This repository's rule is that **publishing is never the agent's to decide**,
and this skill does not change that. What changes is where the decision
happens: it is the person saying *"publish"*, once, for the whole run, instead
of fourteen times for fourteen days.

So:

- **Run this because they asked for it, in words, in this conversation.**
  Never on your own initiative, never as the tidy end of some other job, and
  never because a day "looks finished".
- **If they only want it written and not on the site yet, use `--drafts`.**
  Offer that when there is any doubt. A draft is readable by them and by
  nobody else, and a later run without the flag publishes it.
- **Read the dry run back first.** That is the moment they can say "not that
  trip".
- **Report what happened, exactly.** The script prints one line per action;
  hand those over. Do not say "published" about anything it did not print.

## The token

Seven days, from a six-digit code that goes to the journal owner's address:

```bash
curl -s -X POST https://fernscout.ch/api/auth/request \
  -H 'content-type: application/json' \
  -d '{"user":"<username>","email":"<the owner address>","kind":"agent"}'

curl -s -X POST https://fernscout.ch/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{"user":"<username>","email":"<the owner address>","code":"123456","kind":"agent"}'

export FERNSCOUT_TOKEN=…
```

**`"kind":"agent"` on both calls, and it is the mistake to watch for.** Without
it the default is `guest`: the second call still answers `200 OK`, with
`{"ok":true,"expires":…,"scope":"read"}` and **no token in it** — the
credential went into a cookie a script does not have. Nothing about that
response says you asked for the wrong thing. This skill's own instructions had
it wrong until it was tested end to end.

The owner can also hand over a token from their own page on the site — see
`https://fernscout.ch/agent.md`, "handover". Either way the token is theirs:
do not write it into a file in this repository.

## What it sends, field by field

Everything the file carries, not the fields anyone remembers:

| From | To |
| --- | --- |
| `trip.md` frontmatter + its prose, a trip that does not exist yet | `POST …/trips` (the prose becomes `intro`) |
| `visibility:` / `listed:` on a trip that already exists | `PATCH …/trips/<trip>/visibility` |
| `rates:` on a trip that already exists | `PATCH …/trips/<trip>/rates` |
| `people:` on a trip that already exists | `PATCH …/trips/<trip>/people` |
| `travellers:` on a trip that already exists | `PATCH …/trips/<trip>/travellers` |
| `tracks:` on a trip that already exists | `PATCH …/trips/<trip>/tracks` |
| `title`/`start`/`end`/`tagline`/`accent`/`intro`/`translations` edited on a trip that already exists | nowhere — no door yet (B245); the run warns instead |
| `costs.md` budget, costs and prose | `PUT …/trips/<trip>/costs` |
| each `entries/*.md` + its prose | `POST …/days` (`content`), or `PATCH` if it is there |
| `without: [costs]` on a day | `costs: false` — *there was no money on this day* |
| `gallery:` items whose files are on disk | multipart `POST …/media`, batched under the size limit |
| — | `POST …/days/<slug>/publish`, unless `--drafts` |

Photographs already in the day's gallery on the instance are not sent again —
the site's own copy is the record, so there is no local state file to go
stale.

## When something is refused

It stops at the first refusal, prints the field and what the instance said,
and sends nothing further. What already landed stays — the run is designed to
be repeated, so fix the file and run it again.
