---
name: icloud-export
description: Turn a time range of a Mac's iCloud/Photos library into a Fernscout travel journal — check the tools, ask what to export, export it, let the person choose and annotate the photos in a browser page, then write the days. Use when somebody says "help me export photos from iCloud on my mac", "make a journal from my holiday photos", "import my Photos album", or names a trip and a date range.
---

# iCloud → a journal

The person has a Mac, a Photos library, and a holiday they never wrote up. This
walks them from there to a folder of markdown and photographs they own.

**Five commands, in order.** Everything lives in `.claude/skills/icloud-export/`,
and everything a run produces lands in `export/<trip>/` and `content/<user>/`,
both gitignored.

```bash
./check.sh                                          # 1. tools
node query.mjs  --trip <trip> --from … --to …       # 2. what is there
node export.mjs --trip <trip>                       # 3. pull the files
node review.mjs --trip <trip>                       # 4. the person chooses and writes
node build.mjs  --trip <trip> --user <user>         # 5. the content folder
```

## The one rule

**You do not decide what happened.** The prose comes from `export/<trip>/notes.md`
— the person's own day notes and photo notes — and from nothing else. No weather
nobody mentioned, no meals nobody ate, no feelings nobody expressed. A day they
wrote nothing about gets a question, not a paragraph. One invented memory
presented to somebody's family as fact is not recoverable.

Everything you write carries `status: draft`. Leave the line there.

## 1. Check the tools

```bash
.claude/skills/icloud-export/check.sh
```

It installs nothing. If something is missing it prints the `brew install` line —
**show it to the person and ask** before running anything. `osxphotos` and
`exiftool` are the two that matter: without `exiftool` the exported photos carry
no coordinates at all, because Photos keeps location in its own database rather
than in the files.

The first run also makes macOS ask for permission, and the terminal needs Full
Disk Access. If `osxphotos` reports zero photos for a range that should have
some, that is usually why — not an empty library.

## 2. Ask, before touching anything

Four questions. Ask them together, in the person's own language:

| Ask | Why it matters |
| --- | --- |
| **Which dates?** | `--from 2026-06-22 --to 2026-07-01`. Both inclusive. |
| **What is the trip called?** | Becomes the folder and the URL: lowercase, dashes, `algarve-2026` ages better than `holiday`. |
| **Is there an album?** | `--album "Algarve"` is more precise than dates when they made one. Dates alone are fine. |
| **All photos, or only the good ones?** | `--favourites` takes only hearted ones; `--top 15` takes every favourite plus the best-scoring rest, up to fifteen a day. Nothing takes everything. |

Photos scores its own pictures for composition and exposure, which is what
`--top` sorts by. It is a decent first pass and it is not taste — say so, and say
that anything left behind stays in Photos and can be added later.

Then run `query.mjs`, which reads the library and **writes nothing**:

```bash
node query.mjs --trip algarve-2026 --from 2026-06-22 --to 2026-07-01 --top 15
```

It prints the photo count per day with place names, the download size, and a
rough time. **Read that back to the person and get a yes before exporting** —
anything not already on this Mac comes down from iCloud, and several hundred
photos is several gigabytes and several minutes.

## 3. Export

```bash
node export.mjs --trip algarve-2026
```

Safe to re-run: it only fetches what is missing. Live Photos drag a `.mov` along
and it removes them; `--videos` keeps them, and needs `ffmpeg`.

## 4. The review page

```bash
node review.mjs --trip algarve-2026
```

Opens `http://localhost:4321` in the browser. **Tell the person what to do there,
in two sentences** — the page says it too, but hearing it from you is what makes
them start:

> Go through the photos day by day. Press **Keep** on anything that does not
> belong to the trip to turn it off, and write a few words about each day in the
> big box — that is what the text gets written from. If one picture should be
> seen by fewer people than the rest of the day, set the dropdown under it to
> **Guests only** or **Private**.

The dropdown is the one thing on the page nobody expects, so **say it in words
rather than leaving them to find it.** It is per photograph, and it can only
ever narrow: **Guests only** means everybody they have let into the journal,
**Private** means only the people who were on the trip. It never shows a
picture to somebody the trip itself keeps out. Most photos want none of it —
the whole trip's own visibility is the answer for the whole trip, and this is
for the one frame with a stranger's child or somebody's front door in it.

Then **stop and wait.** Do not poll the file, do not guess when they are done.
The page ends with a note telling them to come back and say "I am done with the
photos, please continue", and that sentence is your cue.

Everything they do is saved to `export/<trip>/review.json` as they type.

## 5. Build the content folder

```bash
node build.mjs --trip algarve-2026 --user severin
```

One entry per day, in `content/<user>/trips/<trip>/`. Photographs are resized to
**4000px** and **stripped of all metadata** — a phone writes the coordinates of
somebody's front door into a file — with the coordinates kept in the frontmatter
instead, where they can be seen and deleted. Photo notes become captions.

**4000 and not 2000, deliberately.** A Fernscout instance makes its own 2000px
copy for the web and keeps what you send **untouched, as the print master** —
`https://fernscout.ch/skill/ingest-photos.md` says so, and then says *"send the
largest file you have"*. Baking down to what the site happens to serve saves
nothing and silently costs the photobook: a 2000px file prints an A4 plate at
about 170 dpi, against the 300 it is built for. `--max-edge` overrides it; the
instance's ceiling is 8000px and 50 MB an image, in `/api/health`. A trip of
twenty-odd days lands around half a gigabyte.

The review page is built at the same size, because B646 says there is exactly
one derivative and the picture somebody approves has to be the picture that
goes out — byte for byte, not merely similar. That costs the first review run
some time and some disk in `export/<trip>/baked/`, which is the honest price of
not having two resizes that can disagree.

Anything held back on the review page is written as `visibility: "guest"` or
`visibility: "private"` inside its gallery item. On a running site that photo
is absent from the gallery, absent from the day, and its file answers 404 to
anybody below that level — it is not merely hidden from the page. Nothing is
written for a picture nobody held back, which is what the ordinary case looks
like.

It leaves two things empty on purpose: **every title, and every paragraph.**

## 6. Write the days

Read `export/<trip>/notes.md`. It is the person's words, arranged by day. Write
each entry's `title:` and its prose from that, in **their** language — if the
notes are in German, the journal is in German; if they are in dialect, tidy the
spelling and keep the words.

A day the notes call "**Nothing was written about this day**" gets no prose. Ask
about it, or leave the placeholder. Both beat an invention.

Write `trip.md` too, if it is not there:

```markdown
---
id: algarve-2026
title: "Algarve 2026"
start: "2026-06-22"
end: "2026-07-01"
status: current
accent: sky                 # sky | yellow | green | coral | navy
visibility: private         # private | public | guest — start closed
---

A paragraph about what this trip was, from what they told you.
```

`private` means the people who were there. Never widen it without being asked,
and never write a `passwordHash:` line.

A **photograph's** own label is the narrower version of the same idea, and it
only ever narrows: a `guest` photo inside a `private` trip stays private,
because a label cannot let anybody past the gate the trip is already holding.
There is no `public` — a picture nobody held back is already everybody's who
can see the trip. If they ask for one photo to be held back and the whole trip
is already `private`, say so rather than writing a label that changes nothing.

## 7. Offer what is still missing

Now, and not before, ask whether they want to add:

- **Costs** — `costs:` on a day, or a `costs.md` for the trip. Needs a rate in
  `trip.md` (`rates: { EUR: 0.94 }` reads "1 EUR = 0.94 in your base currency" —
  it is easy to write upside down).
- **Places** — days whose photos had no GPS have no `lat:`/`lng:`. They can say
  where it was.
- **More photographs** — a day that came out thin, or the ones `--top` left
  behind. Re-run from step 2 with a higher `--top`; `--update` means nothing is
  downloaded twice, and `build.mjs` rewrites the entries while keeping the
  captions.
- **Anything else that happened** — the days with no notes are listed at the end
  of `notes.md`.

## 8. Where it goes from here

The folder *is* the journal — markdown and photographs they own, readable
without any of this. Two ways to see it as a website, and both are theirs to
choose:

- **Their own hosted journal on fernscout.ch.** They need an email address they
  own. Hand them this, to paste into a fresh agent session:

  > Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der
  > Übersicht unter https://fernscout.ch/documentation.txt und der vollständigen
  > Anleitung unter https://fernscout.ch/agent.md. Du brauchst dafür eine
  > E-Mail-Adresse, die mir gehört.

- **Their own server**, from the Fernscout repository, pointing `CONTENT_DIR` at
  this `content/` folder.

**Publishing is never yours to decide.** Every entry is a draft; a person removes
the `status: draft` line, or asks you to. Ask in words, and wait for an answer —
"it looks finished" is not consent, and neither is silence.
