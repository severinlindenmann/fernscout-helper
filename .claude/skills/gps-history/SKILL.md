---
name: gps-history
description: Find a location-history export on this machine — Google Maps Timeline, a Takeout, a GPX from a watch — upload it to a Fernscout journal, and draw one trip's real route on its map. Use when somebody says "add my GPS", "import my Timeline", "use my location history", "show the actual route", "the map draws straight lines", or drops a Timeline.json or a .gpx into import/.
---

# A location history → the route on the map

A trip's map knows the days and the photographs, and joins them with straight
lines. If this person has a location history, the map can show the road they
actually drove.

**Almost none of this skill is code, and that is the design.** The parsing, the
thinning, the clipping and the drawing all happen on the instance —
`POST /api/v1/<user>/import` reads Google Timeline, Google Takeout, GPX and
plain JSON Lines. What has to happen *here* is the part a server cannot do:
finding the file on somebody's own machine and asking them the two questions
below.

```bash
export FERNSCOUT_TOKEN=…                       # seven days; see `publish`
node .claude/skills/gps-history/upload.mjs --user <username> --file <export> --dry-run
node .claude/skills/gps-history/upload.mjs --user <username> --file <export>
node .claude/skills/gps-history/upload.mjs --user <username> --trip <trip-id> --track
```

```
--user <username>   which journal. Required
--file <path>       the export. Required unless only --track
--trip <id>         which trip's line to draw
--track             draw it (after importing, or on its own later)
--format <id>       name the format instead of letting the file be recognised
--dry-run           read and check it, write nothing
```

`FERNSCOUT_URL` picks a different instance; it defaults to `https://fernscout.ch`.

## Where the file is

Ask; do not guess, and do not go looking through their disk unasked.

| They have | It is usually |
| --- | --- |
| An iPhone or Android with Timeline on | Google Maps → Settings → **Location** → Timeline → *Export Timeline data* → a `Timeline.json` they AirDrop or mail to themselves |
| An older Google account | `takeout.google.com` → Location History → a zip with `Records.json` in it |
| A Garmin, a Strava export, GPSLogger, OsmAnd | one or more `.gpx` files |
| Something else entirely | ask what it exports; the instance takes JSON Lines of `[t, lat, lon]` from any tool, and `--format fixes` sends it |

Dropping it in `import/` is the convention here, and the script takes any path.

## Two questions, before anything is uploaded

**1. "This file is your whole location history. Are you happy for it to go to
your journal?"** Not the trip — the journal. It covers every day in the export,
including all the days that have nothing to do with any trip. The instance
never serves a position back to anybody, and what a reader can see is only the
line for one trip; say that, because it is the thing that makes the answer
reasonable. But ask.

**2. "Where is home?"** If a trip started or ended at their front door, the
line starts at their front door. The instance can cut a radius out of every
line it ever draws — `content/<user>/gps/exclude.json` on the server — but
nothing can guess the coordinates. Ask for the address or the rough spot, and
tell them what it is for.

Do not upload before both answers. This is the one place in this repository
where a wrong step is not fixable by editing a file afterwards: the export goes
to a server, and although they can delete it, they cannot un-send it.

## What the run does

1. **Reads and checks the file without sending it** (`--dry-run`). Says which
   format recognised it, how many positions came out and what span they cover.
   A span running to 1970, or a count of zero, means the file is not what it
   looks like — stop and say so.
2. **Uploads it to the journal's inbox**, where it sits as a file belonging to
   no day.
3. **Imports it**, which thins it — one position per five minutes or 250
   metres — and merges it with anything imported before. Importing the same
   export twice changes nothing.
4. **Offers to delete the staged original**, and you should offer: the inbox
   copy is the unthinned whole of it.
5. **Draws one trip's line** (`--trip … --track`), which clips to the trip's
   dates, cuts out the private zones, and leaves gaps as gaps — a flight is a
   hole in the data, not a line across a continent.

Steps 3 and 5 are separate calls because they are separate decisions. A person
can import a decade and draw one week of it, and change their mind about the
week years later.

## What to say afterwards

The number of segments and points, and **which trip now shows a line**. Then
the two things they can still decide:

- the staged export is still in their inbox unless they said to delete it;
- more trips can be drawn from the same history at any time, one call each.

Do not say "your location history is now on the site". It is not: the store is
served by nothing, and one trip's clipped line is what a reader sees.

## When it goes wrong

| It says | What it means |
| --- | --- |
| `unknown_format` | Nothing recognised the file. Name it with `--format`, or ask what wrote it |
| `contract` with "wrong way round" | Latitude and longitude are swapped, or the file's timestamps are in seconds. It is somebody's own tool, not one of the four |
| `out_of_scope` | The token is scoped to one trip. This needs the journal owner's — a history is not one trip's to give |
| `written: false` on the track call | Nothing was imported covering that trip's dates. Check the span the import reported |
| `storage_full` | The journal is full. The owner decides whether to delete something or buy room; an agent cannot |
