---
name: find-trips
description: Find the trips hiding in years of somebody's photo library — the weeks they were away, with dates, day counts and place names, ready to hand to icloud-export. Use when somebody says "find my trips", "what trips do I have in my photos", "search the last 10 years", "I don't remember when we went", or wants to write up a back catalogue rather than one named holiday.
---

# Finding the trips nobody wrote down

`icloud-export` starts with a question its user often cannot answer: *which
dates?* Somebody who wants to write up one holiday knows. Somebody who wants
ten years of them does not, and will not enjoy scrolling a library to find out.

This reads the library's **metadata only** — no file is fetched from iCloud,
nothing is written into the library, and it takes a couple of minutes for a
decade — and prints the candidate trips: from, to, how many days, how many
photographs, how far from home, and the place names.

```bash
node .claude/skills/find-trips/discover.mjs \
     --home 46.9480,7.4474 --home 47.3779,8.5403 --years 10
```

Needs `osxphotos` and a Mac with the Photos library; `../icloud-export/check.sh`
tests for it, and Full Disk Access is the usual reason a full library reports
zero photographs.

## Ask these before running it

| Ask | Why |
| --- | --- |
| **Where is home?** | One `--home` per place they regularly sleep. Two is common — a flat and a parents' house — and getting this wrong makes ordinary weekends look like holidays. Never guess it from the photographs. |
| **How far counts as away?** | `--radius`, default 100 km. In a small country this catches day trips; raise it to 150 and short domestic weekends disappear. |
| **Whose phone is whose?** | See below. This is the one that changes the answer most, and it cannot be worked out from the files. |

## A library is not one person

The single most misleading thing in a shared library is that everybody's
photographs look alike. A relative's week in Hungary, a friend's city break,
the pictures somebody sent by message — all of it sits under the same dates as
the owner's own life.

Write `export/household.json` and the detection runs **per person**:

```json
{
  "radiusKm": 100,
  "perDay": 15,
  "people": {
    "severin": [
      { "model": "Phone A", "to": "2018-02-05" },
      { "model": "Phone B", "from": "2018-02-05", "to": "2019-12-19" },
      { "model": "Phone C", "from": "2019-12-19", "to": "2024-08-20" },
      { "model": "Phone D", "from": "2024-08-20" }
    ],
    "wife": [{ "model": "Phone E" }]
  }
}
```

A camera belongs to somebody **for a stretch of time**, because people replace
phones and hand the old one on. Read the camera models out of the library
first and show them the list — they will recognise their own phones, and the
handover dates fall out of the ranges:

```bash
osxphotos query --field d "{photo.date}" --field model "{photo.exif_info.camera_model}" \
  | sort | uniq -c
```

**Do not infer who owns a camera.** Ask. On the library this was built against,
the owner's four phones in sequence were obvious only once he said so, and two
frequent companions were never resolved at all.

## Three things it gets right, each learned the hard way

- **A day is a journey, not a point.** Anchoring a day to the *median* of its
  photographs puts 31 December — Baden in the morning, Gyál at night — in the
  middle of the Baltic Sea, further from home than the radius and further from
  every photograph actually taken. That day vanished silently. A day is
  compared against *every* place its owner stood.
- **Two people can be a thousand kilometres apart on the same day.** Detected
  per person, one July week came out as his three days in Piedmont and her
  seven in Hungary. Detected per library, it was one impossible trip spanning
  both, and the place filter downstream then dragged 185 photographs of a
  Hungarian village into an Italian weekend.
- **A run never ends on a guess.** Days with no coordinates are carried
  *inside* a run (up to `--gap`) but never start or end one.

## What it cannot do, and must therefore say

It cannot tell you whether a trip was **yours**. A week of somebody else's
photographs in your library is indistinguishable from a week of your own. The
output is candidates; the person confirms them. On a real ten-year run, of 35
candidates six were deleted as other people's or duplicates, and two more were
one trip that had to be split.

It also **under-reports the edges**: a trip is only as long as the days
somebody photographed. Two days of an eleven-day sailing trip had no
photographs at all — correctly absent, but worth saying out loud rather than
letting the dates look authoritative.

## Then hand it to icloud-export

The dates go straight into the next skill, one trip at a time:

```bash
node ../icloud-export/query.mjs --trip aland-2023 --from 2023-07-22 --to 2023-08-01
```

Export on the **wider** of the candidate ranges when in doubt. A day the person
never sees is unrecoverable; a day they reject costs one click.

```bash
node --test .claude/skills/find-trips/discover.test.mjs
```
