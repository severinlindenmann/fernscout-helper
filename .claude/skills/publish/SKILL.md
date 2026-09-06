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
yet are sent; then each day is published. **Running it twice does the same
work as running it once** — the second run finds everything already there and
sends nothing.

```
--user <username>     which journal. Required
--trip <id>           just one trip
--dry-run             print every call it would make, send none
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
and sends nothing. Read that back to the person before the real run. It is the
one cheap moment to notice that a trip is about to be created twice under two
ids, or that fourteen days are about to go up when they meant one.

## Two things it will not do

**It will not start while `validate-content` reports an error.** Half a
journal on a website is worse than none, and the errors are cheap to read
first. `--skip-validate` exists and is almost never the right answer; if you
reach for it, say out loud what you are overriding.

**It cannot create the journal itself.** A new journal needs an address
somebody owns, and a six-digit code goes to it — a script cannot read your
mail. If the journal is not there, it prints the two `curl` calls that make
one and stops.

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
  -d '{"user":"<username>","email":"<the owner address>"}'

curl -s -X POST https://fernscout.ch/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{"user":"<username>","email":"<the owner address>","code":"123456"}'

export FERNSCOUT_TOKEN=…
```

The owner can also hand over a token from their own page on the site — see
`https://fernscout.ch/agent.md`, "handover". Either way the token is theirs:
do not write it into a file in this repository.

## What it sends, field by field

Everything the file carries, not the fields anyone remembers:

| From | To |
| --- | --- |
| `trip.md` frontmatter + its prose | `POST …/trips` (the prose becomes `intro`) |
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
