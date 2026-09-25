# Fernscout Helper

Tools for getting your life **into** a [Fernscout](https://github.com/severinlindenmann/fernscout)
travel journal: your photos, your location history, your bank statements. You
open this folder with an AI agent and say what you want in your own words. What
comes out is a journal of JSON documents and photographs that belongs to you.

You don't host anything and you don't install server software. Your photos,
statements and location history stay on your machine. Nothing leaves it until
you choose to publish.

## Quickstart

```bash
git clone https://github.com/severinlindenmann/fernscout-helper
cd fernscout-helper
claude          # or any agent that reads .claude/skills/
```

Then start with your photos:

> Help me export the photos from my last trip from iCloud.

That runs `icloud-export`, which turns a trip's photos into draft days. The other
tools add to those days: costs, the route, a check for gaps, publishing.

Every tool asks for a **username**. It isn't a login. It is the name of your
folder under `content/`, for example `alex`, and it becomes your journal's
address if you publish.

## What works best

**[Claude Code](https://claude.com/claude-code) on a Mac.** That is what this is
built and tested with:

- **Claude Code** reads `.claude/skills/` by itself, so the tools are there as
  soon as you've cloned the folder. Another agent works too if it reads the same
  format, or if you paste a `SKILL.md` in by hand.
- **A Mac** is where the photo tools can reach your library directly: your
  iCloud photos are already on the machine, `sips` makes the previews, and Photos
  hands over the places it knows.

Everything except the photo export works on any system: a statement is a CSV and
a journal is JSON. The photo half wants a Mac today because the tool for other
systems doesn't exist yet.

## The tools

| Skill | Say | Needs |
| --- | --- | --- |
| `icloud-export` | "help me export photos from iCloud" (**start here**) | a Mac |
| `find-trips` | "find the trips in my photos" | a Mac |
| `statement-costs` | "import my Revolut statement" | a journal |
| `trip-budget` | "what did the trip cost", "add the flights" | anywhere |
| `gps-history` | "add my GPS", "import my Timeline" | a journal on an instance |
| `validate-content` | "check my journal", "did I forget anything" | anywhere |
| `publish` | "publish", "put it online" | a journal on an instance |
| `sync` | "sync my journal", "I edited a day on the site" | a journal on an instance |

Each skill is one folder: `.claude/skills/<name>/` holds a `SKILL.md` you can
read start to finish and the plain Node scripts it runs. There is no build step
and no `npm install`. Skills that need an outside tool (`icloud-export` needs
`osxphotos` and `exiftool`) check for it and ask before installing anything.

## What you get

```
content/<username>/trips/<trip>/
  trip.json                   the trip: dates, travellers, budget, planned route
  entries/2026-06-23-….json   one day: what happened, its photos, what it cost
  media/…                     the photos, resized, with location and camera data removed
```

JSON documents and photographs in a folder you own: no database, no account. Every
day starts as a **draft**, and nothing is published until you say so.

## Then what

The folder is already the journal. To read it as a website:

- **Your own server.** The [Fernscout app](https://github.com/severinlindenmann/fernscout)
  is the software. Point its `CONTENT_DIR` at this folder's `content/`.
- **Hosted, at [fernscout.ch](https://fernscout.ch).** You need an email address
  you own. Paste this into a fresh agent session:

  > Walk me through creating my own travel journal, following the overview at
  > https://fernscout.ch/documentation.txt and the full guide at
  > https://fernscout.ch/agent.md. You'll need an email address that belongs to me.

## Your data stays out of git

`import/`, `export/` and `content/` are ignored: your statements, photos, notes
and journal never go into this repository. It holds the tools only.

When a tool is about to send something to your journal, like your location
history or a statement, it tells you what goes where and asks first.

## Licence

MIT, except the Fernscout name and logo:
`.claude/skills/icloud-export/assets/fernscout-logo.svg` is not licensed under
MIT. See `TRADEMARK.md` and `BRAND-LICENSE` in the
[Fernscout repository](https://github.com/severinlindenmann/fernscout).
