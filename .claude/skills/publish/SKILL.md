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

It compares what is on disk with what the instance already has and makes up the
difference. A trip that is not there is created; a day that is not there is
written; a day that is there is corrected; photographs the day names and the
instance does not hold are uploaded; then each day is published.

**The folder is the instance's own documents.** `trip.json` (with `costs` and
`plan` as sections of it), `entries/<YYYY-MM-DD-slug>.json`,
`media/<day-slug>/…`, `originals/` beside it, `figures/<id>.json` at the
journal root. There is no translation step: the file on disk is the body that
goes over the wire. A folder still holding `trip.md` and `entries/*.md` is the
old shape and is converted once:

```bash
node .claude/skills/shared/convert.mjs <username>     # writes <username>-v2 beside it
```

Read the report it prints. Several of the things it finds are decisions only
the owner can make, and it makes none of them.

## Say the plan out loud first

```bash
node .claude/skills/publish/publish.mjs --user alex --dry-run
```

The dry run asks the instance what it already holds, then prints exactly what a
real run would create, correct, upload and publish. It writes nothing. Show it
to the person and get a yes — especially for the publishing, which is the half
that puts somebody's days in front of other people.

```
--user <name>         which journal (required)
--trip <id>           one trip instead of all of them
--dry-run             say what would happen; write nothing
--drafts              write the days and stop — do not put them on the site
--changed <file>      only the paths a sync says differ (sync passes this)
```

## Publishing is a separate decision, and it is theirs

Without `--drafts`, each day is published with its own call after it is
written. **That needs the person to have said so, in this conversation, in
words.** "It looks finished" is not consent and neither is silence. When there
is any doubt about whether they meant the website or just the files, run
`--drafts` and say plainly what is still a draft.

A day the instance already has on the site is left alone rather than published
twice.

## Asked, or declined — the thing most likely to stop a run

Every optional section of a trip and of a day must be either **sent** or named
in **`declined`** with a reason of ten characters or more. A document that does
neither comes back `422 incomplete`, listing what is still open.

Do not keep that list here. It is published at `/api/v2/openapi.json` as
`x-required-or-declined` on each write's body schema, with the reason each
section is asked about and the key that declines it — and that is what these
tools read.

**The reason is the owner's sentence, and it is written in the folder.** If a
run stops on `422 incomplete`, print what the server said and ask them. Never
write a decline to get past a refusal: "no photographs were taken on this day"
is either true or it is a lie, and the instance cannot tell the difference.

## What the run does per document

| | |
| --- | --- |
| not there yet | `PUT` — creates at the id the folder chose |
| already there | `PATCH` with `If-Match`, the ETag from the `GET` that preceded it |
| a photograph | `POST /api/v2/<user>/media`, with an `intent` naming the trip and the day |
| putting it up | `POST …/days/<slug>/publish`, one call per day |

`PUT` is create-only in v2: a create that finds something at that id answers
`409 stale_document` rather than overwriting it, and the stored document comes
back with the refusal so a caller can read it and decide.

**After an upload the folder is corrected to match the instance.** The server
stores a photograph under its own content hash; the run renames the local file
and the day's `src` to what the server answered with. That is what keeps the
folder a mirror — without it, the first sync after a publish would plan to pull
every photograph and push every photograph.

## Weather

A day with coordinates can carry `weather: true`, and the instance looks that
day up in a public archive **inside the write** — so the day comes back with
the reading already on it. An archive lags real time, so a day written the same
evening can come back with `weather` still `true` and nothing attached. That is
"not yet" rather than a failure, and sending `weather: true` again is how to ask
a second time; nothing on the instance comes back for it on its own.

A reading somebody actually took goes in `weather` as an object with its own
`source` and `recordedAt`. `open-meteo` as a source is refused by name: it
means the server measured it.

**Which is why a day that came down from the instance cannot go back up
unchanged.** A day the server looked up carries its own reading, `sync down`
writes that document to disk as-is — it is a byte mirror — and sending it back
is refused by name. 189 entries in one journal were in that state, so the
folder could no longer create its own days. Publishing now hands such a reading
back as `weather: true`, the ask that produced it, and says how many it did
that for; the file on disk keeps the reading, which is real data the instance
measured. The names that count as the server's own are read from
`/api/v2/status` rather than typed here — an instance that does not publish
them falls back to `open-meteo` and the run says so once (B1782).

## Figures go through the door they have

A figure has no `PATCH`. `PUT` is its correction door too, and carrying
`If-Match` is how a caller says "I have read this and mean to replace it" —
so correcting one with a `PATCH` answered 405 for every figure that already
existed. Since a refusal makes the whole run exit non-zero, five trips whose
days had all landed perfectly were reported FAILED and a real failure was
indistinguishable from the noise. A figure the instance already holds
unchanged is not written at all, and the run says `unchanged` rather than
claiming a correction (B1774).

## What a publish leaves behind for a sync

`publish` writes straight to the instance without going through a sync, and it
used to leave the sync baseline untouched: both sides then held identical
content while the baseline said they had never been synced, so the next
`sync down` called 1,267 files *"written on both sides, never synced"* and
refused to move. It was right to — without a baseline, "identical because one
came from the other" and "two people edited this" are the same observation.

So a plain run records agreement for the paths it actually wrote, reading the
site's manifest back rather than guessing at what landed. A run started *by* a
sync (`--changed`) leaves the baseline alone: it is the sync's to write at the
end of its own run (B1775).

## The limits are the instance's, not this repository's

The per-day photograph ceiling, the image size limit and the formats come from
`/api/v2/status` at run time, and the ceiling is printed at the top of a run.
Nothing here carries a number of its own — a `40` typed into a script was right
on the day somebody typed it and wrong the day the instance changed it.

## A token

```bash
curl -s -X POST https://fernscout.ch/api/auth/codes -H 'content-type: application/json' \
     -d '{"user":"<username>","email":"<your address>","for":"write"}'
# six digits arrive by mail, then
curl -s -X POST https://fernscout.ch/api/auth/codes/redeem -H 'content-type: application/json' \
     -d '{"user":"<username>","email":"<your address>","code":"123456","for":"write"}'
export FERNSCOUT_TOKEN=fs_agent_…
```

If the person would rather not deal with six digits, their journal's own page
can print a **handover** credential instead (it lasts twenty minutes and works
once): `POST /api/auth/handover` with `authorization: Bearer <handover>`
exchanges it for the same seven-day token.

It lasts seven days. `FERNSCOUT_URL` points these tools at a different
instance; everything defaults to `https://fernscout.ch`.

## When it refuses

Read what it printed. The instance answers a refusal with the field, what
arrived, what was expected, and — for an open section — the exact sentence that
would decline it, and this run prints all of it rather than the first line. Fix
the folder and run again: it is idempotent, so a second run does only what is
left.
