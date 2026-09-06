# Fernscout Helper

A toolbox for getting your life **into** a [Fernscout](https://fernscout.ch)
travel journal — extracting content from wherever it already lives, writing what
is missing, and formatting all of it the way the journal expects.

You do not host anything and you do not run any server software. You clone this,
open it with an AI agent, and say what you want in your own words. What comes out
is a folder of markdown and photographs that belongs to you and reads without any
of this.

```bash
git clone https://github.com/severinlindenmann/fernscout-helper
cd fernscout-helper
claude          # or any agent that reads .claude/skills/
```

Then, for example:

> Help me export photos from iCloud on my Mac.

## What works best

**[Claude Code](https://claude.com/claude-code) on a MacBook.** That is what this
is built and tested against, and it is the combination where everything works
without you arranging anything:

- **Claude Code** reads `.claude/skills/` by itself, so the tools are simply
  there once you have cloned the folder — nothing to configure, install or
  point at. Another agent works too if it reads the same format, or if you paste
  a `SKILL.md` in by hand.
- **A Mac** is where the photo tools can reach your library directly. Your
  iCloud photos are already on the machine, `sips` for the previews is built into
  macOS, and Photos will hand over the locations it keeps in its own database.
  Nothing has to be uploaded anywhere.

Everything else still works elsewhere — a statement is a CSV and a journal is
markdown, on any operating system. It is the photo half that wants a Mac today,
and that is a missing tool rather than a decision. See **The tools** below for
what each one needs.

## The three jobs

Every tool here does one of three things.

| | |
| --- | --- |
| **Extract** | Get what already exists out of wherever it is stuck — a phone's photo library, a bank's CSV export, a chat log, a folder of camera files |
| **Create** | Ask for what only a person knows — what happened that day, what the flights cost, who was there — and write it down without inventing the rest |
| **Format** | Turn all of it into the journal's own shape: `trip.md`, one entry per day, sized galleries, costs, coordinates |

## The tools

| Skill | Say | Needs |
| --- | --- | --- |
| `icloud-export` | "help me export photos from iCloud on my Mac" | macOS |
| `revolut-costs` | "import my Revolut statement" | anywhere |
| `trip-budget` | "what did the trip cost", "add the flights" | anywhere |
| `validate-content` | "check my journal", "did I forget anything" | anywhere |
| `publish` | "publish", "put it online" | a journal on an instance |

**A skill is one folder.** `.claude/skills/<name>/` holds a `SKILL.md` you can
read start to finish and the scripts it runs, so nothing is hidden and nothing
needs a build step. `.claude/skills/shared/` holds the few things more than one
of them needs.

More will follow, and they will not all be for a Mac: photos off an Android
phone, a Windows folder of camera files, Google Photos, a chat export, a
handwritten notebook photographed page by page. The pattern is the same each
time — get the content out, ask for what only a person knows, write the journal's
own format.

## What you get

```
content/<you>/trips/<trip>/
  trip.md                     what the trip was, and the budget
  costs.md                    what was spent before leaving
  entries/2026-06-23-….md     one day: what happened, its photos, what it cost
  media/…                     the pictures, resized, with every trace of
                              metadata removed
```

Markdown and JPEGs in a folder you own. No database, no account, no lock-in.
Every day starts as a **draft** — nothing is published until you say so.

## What it needs

Nothing to install for the repository itself: the scripts are plain Node with no
dependencies, so there is no `npm install`. Individual skills need their own
tools — `icloud-export` wants `osxphotos`, `exiftool` and Node on a Mac — and
each one checks for them and asks before installing anything.

## Then what

The folder is already the journal. If you want it as a website:

- **Hosted, on fernscout.ch** — you need an email address you own. Paste this
  into a fresh agent session:

  > Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der
  > Übersicht unter https://fernscout.ch/documentation.txt und der vollständigen
  > Anleitung unter https://fernscout.ch/agent.md. Du brauchst dafür eine
  > E-Mail-Adresse, die mir gehört.

- **Your own server** — the [Fernscout repository](https://github.com/severinlindenmann/fernscout)
  is the software. Point its `CONTENT_DIR` at the `content/` folder here.

## What stays out of git

`import/`, `export/` and `content/` — your statements, your photographs, your
notes and your journal. This repository is the tools; nothing it touches belongs
in it.

MIT.
