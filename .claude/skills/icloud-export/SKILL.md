---
name: icloud-export
description: Turn a time range of a Mac's iCloud/Photos library into a Fernscout travel journal — check the tools, ask what to export, export it, let the person choose and annotate the photos in a browser page, then write the days. Use when somebody says "help me export photos from iCloud on my mac", "make a journal from my holiday photos", "import my Photos album", or names a trip and a date range.
---

# iCloud → a journal

The person has a Mac, a Photos library, and a holiday they never wrote up. This
walks them from there to a folder of JSON documents and photographs they own.

**The commands, in order.** Everything lives in `.claude/skills/icloud-export/`,
and everything a run produces lands in `export/<trip>/` and `content/<user>/`,
both gitignored.

```bash
./check.sh                                           # 1. tools
node query.mjs   --trip <trip> --from … --to …       # 2. what is there
node narrow.mjs  --trip <trip> --who <person>        #    a date range is not a trip (optional)
node blur.mjs    --trip <trip>                       #    zones that should not be published to the metre
node export.mjs  --trip <trip>                       # 3. pull the files
node review.mjs                                      # 4. the person chooses and writes
node describe.mjs --trip <trip>                      #    contact sheets, AFTER the review
node build.mjs   --trip <trip> --user <user>         # 5. the content folder
```

**The order of 4 and 4½ is not a preference.** `describe.mjs` makes one contact
sheet per day so an agent can look at a trip without opening two thousand
files, and whatever is written from those sheets **outlives the review**: a
photograph the person turns off for privacy keeps its sentence. In one run 51
of 147 days carried prose describing removed photographs, one of them opening
by describing the payment cards their owner had just turned off. So
`describe.mjs` refuses to run before a review, and `--before-review` is how to
say the other order is deliberate (B1767).

`narrow.mjs` and `blur.mjs` also have an order between them, and it is
enforced rather than documented: `narrow.mjs` rebuilds the selection from the
untouched copy, so it re-applies a blur it would otherwise have undone
(B1770).

## The one rule

**You do not decide what happened.** The prose comes from `export/<trip>/notes.md`
— the person's own day notes and photo notes — and from nothing else. No weather
nobody mentioned, no meals nobody ate, no feelings nobody expressed. A day they
wrote nothing about gets a question, not a paragraph. One invented memory
presented to somebody's family as fact is not recoverable.

Everything you write is a draft. Putting a day on the site is a separate
call, made only when the person asks for it (the `publish` skill).

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

Five questions. Ask them together, in the person's own language:

| Ask | Why it matters |
| --- | --- |
| **Which dates?** | `--from 2026-06-22 --to 2026-07-01`. Both inclusive. |
| **What is the trip called?** | Becomes the folder and the URL: lowercase, dashes, `example-trip-2024` ages better than `holiday`. |
| **Is there an album?** | `--album "Example Trip"` is more precise than dates when they made one. Dates alone are fine. |
| **All photos, or only the good ones?** | `--favourites` takes only hearted ones; `--top 15` takes every favourite plus the best-scoring rest, up to fifteen a day. Nothing takes everything. |
| **Who else was on this trip?** | Their name and their email address, as the person gives it. `people` is the byline *and* write access, and the instance **mails every person newly added** to a trip, so a name with the wrong address is worse than a name not listed yet; **never infer one**, including from a face you recognise in the photographs. Somebody they don't want to list goes unlisted. Asked here, not at the end (step 7), because the answer shapes the figures at build time and a person looking at their own holiday photographs still remembers who was there. |

Photos scores its own pictures for composition and exposure, which is what
`--top` sorts by. It is a decent first pass and it is not taste — say so, and say
that anything left behind stays in Photos and can be added later.

Then run `query.mjs`, which reads the library and **writes nothing**:

```bash
node query.mjs --trip example-trip-2024 --from 2026-06-22 --to 2026-07-01 --top 15
```

It prints the photo count per day with place names, the download size, and a
rough time. **Read that back to the person and get a yes before exporting** —
anything not already on this Mac comes down from iCloud, and several hundred
photos is several gigabytes and several minutes.

## 3. Export

```bash
node export.mjs --trip example-trip-2024
```

Safe to re-run: it only fetches what is missing. Live Photos drag a `.mov` along
and it removes them; `--videos` keeps them, and needs `ffmpeg`.

**It checks what actually landed, and fails if something did not.** `osxphotos`
does not always honour `--convert-to-jpeg` — 21 of 28 files in one trip came
out as `.HEIC` — and since every later step reads only JPEGs those photographs
were *invisible* rather than broken: a fifteen-photograph day became a
three-photograph sheet and the run said it had succeeded. So anything left in
another format is converted (with its tags copied across, because the
coordinates are the whole reason `--exiftool` is not optional), and then what
is on disk is compared with what was asked for. `--check` runs just that pass
over an export that already happened (B1772).

## 4. The review page

```bash
node review.mjs                       # every exported trip, with an index
node review.mjs --trip example-trip-2024   # straight into one of them
```

Opens `http://localhost:4321` in the browser. **One server, all the trips** —
`/` lists everything under `export/` with how far each one has got, and each
trip is at `/t/<trip>/`. Ten years of a library came out as 26 trips, which
used to mean 26 servers on 26 ports (B1778). **Tell the person what to do there,
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

Everything they do is saved to `export/<trip>/review.json` as they type. A save
keeps whatever else is in that file, because two of its keys are not the
page's.

**`flags` is one of them, and it is the most useful thing here.** Looking at
every photograph of a trip finds what nobody went looking for: in one ten-year
run the per-day descriptions turned up an identity card front and back with its
MRZ, a bank card with the full cardholder name, a phone screen with a name,
IBAN and BIC, a hostel envelope with a door code, hotel cards with guest names
and Wi-Fi passwords, and a parcel label with a name and address. So whoever
reads the contact sheets writes what they saw into `review.json`:

```json
{
  "flags": {
    "IMG_4412.JPG": "an identity card, front and back — name, photo, ID number"
  },
  "observed": { "2026-06-23": "what the day's photographs show, as a memory-jogger" }
}
```

The page then outlines those frames in red, says how many there are, and offers
a jump straight to them instead of the person hunting by date. **It marks; it
does not decide** — turning the photograph off is still their press, and an
unflagged photograph is not a claim that there is nothing in it (B1779).

## 5. Build the content folder

```bash
node build.mjs --trip example-trip-2024 --user alex
```

One entry per day, in `content/<user>/trips/<trip>/`. **It replaces the trip
rather than adding to it**: it used to write into whatever was already there,
and every one of 18 rebuilt trips ended up with exactly double the entries —
old files beside new ones, each individually valid, so a validation pass called
it "28 entries, 0 issues". A second build refuses unless `--force` says to
replace what is there; `originals/` is never touched (B1768). Photographs are resized to
**4000px** and **stripped of all metadata** — a phone writes the coordinates of
somebody's front door into a file — with the coordinates kept in the day's
`coordinates` field instead, where they can be seen and deleted. Photo notes become captions.

**4000 and not 2000, deliberately.** A Fernscout instance makes its own 2000px
copy for the web and keeps what you send **untouched, as the print master** —
`https://fernscout.ch/skill/ingest-photos.md` says so, and then says *"send the
largest file you have"*. Baking down to what the site happens to serve saves
nothing and silently costs the photobook: a 2000px file prints an A4 plate at
about 170 dpi, against the 300 it is built for. `--max-edge` overrides it; the
instance's ceilings (12000px, 64 megapixels and 50 MB an image today) are
`limits.imageMaxEdge`, `imageMaxPixels` and `imageMaxBytes` in
`<site>/api/v2/status` — read them there rather than quoting them. A trip of
twenty-odd days lands around half a gigabyte.

The review page is built at the same size, because B646 says there is exactly
one derivative and the picture somebody approves has to be the picture that
goes out — byte for byte, not merely similar. That costs the first review run
some time and some disk in `export/<trip>/baked/`, which is the honest price of
not having two resizes that can disagree.

Anything held back on the review page is written as `visibility: "guest"` or
`visibility: "private"` on its item in the day's `media`. On a running site that photo
is absent from the gallery, absent from the day, and its file answers 404 to
anybody below that level — it is not merely hidden from the page. Nothing is
written for a picture nobody held back, which is what the ordinary case looks
like.

It leaves two things empty on purpose: **every title, and every paragraph.**

## 6. Write the days

Read `export/<trip>/notes.md`. It is the person's words, arranged by day. Write
each entry's `title` and its `content` from that, in **their** language — if the
notes are in German, the journal is in German; if they are in dialect, tidy the
spelling and keep the words.

A day the notes call "**Nothing was written about this day**" gets no prose. Ask
about it, or leave the placeholder. Both beat an invention.

Write `trip.json` too, if it is not there — the whole trip is one document
now, with costs and the planned route as sections of it:

```json
{
  "id": "example-trip-2024",
  "title": "Example Trip 2024",
  "dates": { "from": "2026-06-22", "to": "2026-07-01" },
  "accent": "sky",
  "visibility": "private",
  "teaser": false,
  "people": [
    { "name": "The journal's owner", "email": "the address they sign in with — ask, never guess" }
  ],
  "intro": "A paragraph about what this trip was, from what they told you.",
  "declined": {
    "buddies": "travelling solo",
    "costs": "nothing has been recorded about what this trip cost yet",
    "plan": "no planned route was written down for this trip"
  }
}
```

There is no `status:` — the dates say whether a trip is past, current or
upcoming. Every optional section is either written or named in `declined` with
a real reason; the two above are examples of the shape, not sentences to paste
when they are not true.

`private` means the people who were there. Never widen it without being asked.
A `private` or `guest` trip must say whether its existence may show as a
locked card — `teaser`, `true` or `false`; ask, and `false` is the quiet
answer. (A `public` trip uses `listed` instead.)

`people` always holds at least the owner, with the address they sign in with.
If step 2's answer was just the person you are talking to, decline `buddies`
("travelling solo") rather than inventing company. Everybody else listed gets
a mail from the instance saying they are on the trip — say that before adding
anyone. If they named someone with an address, carry that same address into
the figure's own `person` when you build the figures below, so their figure is
tied to them rather than left an anonymous shape; a name with no address gets
no `person`, since an inferred one is exactly the address this rule exists to
keep out. Figures are their own documents in v2 — one file each under
`figures/`, journal-wide — and a trip names the ones it uses.

A **photograph's** own label is the narrower version of the same idea, and it
only ever narrows: a `guest` photo inside a `private` trip stays private,
because a label cannot let anybody past the gate the trip is already holding.
There is no `public` — a picture nobody held back is already everybody's who
can see the trip. If they ask for one photo to be held back and the whole trip
is already `private`, say so rather than writing a label that changes nothing.

## 7. Offer what is still missing

Now, and not before, ask whether they want to add:

- **Costs** — `costs` on a day for what was spent that day, or the trip's own
  `costs.items` for what was paid **before leaving** (or belongs to no day);
  a trip carrying the same money in both reports its spend twice. A foreign
  currency needs the trip to name it — `"rates": {"currencies": ["EUR"]}` — and
  the server rates it; do not write a rate number.
- **Places** — days whose photos had no GPS have no `coordinates`. They can say
  where it was.
- **More photographs** — a day that came out thin, or the ones `--top` left
  behind. Re-run from step 2 with a higher `--top`; `--update` means nothing is
  downloaded twice, and `build.mjs` rewrites the entries while keeping the
  captions.
- **Anything else that happened** — the days with no notes are listed at the end
  of `notes.md`.

## 8. Where it goes from here

The folder *is* the journal — JSON documents and photographs they own, readable
without any of this. Two ways to see it as a website, and both are theirs to
choose:

- **Their own hosted journal on fernscout.ch.** They need an email address they
  own. Hand them this, to paste into a fresh agent session:

  > Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der
  > Übersicht unter https://fernscout.ch/documentation.txt und der Anleitung zum
  > Schreiben eines Tages unter https://fernscout.ch/skill/add-a-day.md. Du
  > brauchst dafür eine E-Mail-Adresse, die mir gehört.

- **Their own server**, from the Fernscout repository, pointing `CONTENT_DIR` at
  this `content/` folder.

**Publishing is never yours to decide.** Every entry is a draft until a person
asks for it to go on the site — then the `publish` skill makes that call. Ask in
words, and wait for an answer —
"it looks finished" is not consent, and neither is silence.
