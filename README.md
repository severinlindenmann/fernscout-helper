# Fernscout Helper

Tools for making a [Fernscout](https://fernscout.ch) travel journal out of what
you already have — photographs on your Mac, and a holiday you never wrote up.

**You do not host anything, and you do not run any server software.** You clone
this, open it with an AI agent, and say what you want. The result is a folder of
markdown and photographs that belongs to you and reads without any of this.

```bash
git clone https://github.com/severinlindenmann/fernscout-helper
cd fernscout-helper
claude          # or any agent that reads .claude/skills/
```

Then say, in your own words:

> Help me export photos from iCloud on my Mac.

That is the whole interface. The agent checks whether the tools are installed,
asks you which dates and which trip, exports the photographs, opens a page in
your browser where you pick the ones that belong and write a few words about each
day, and then writes the journal from what you wrote.

## What you get

```
content/<you>/trips/<trip>/
  trip.md                     what the trip was
  entries/2026-06-23-….md     one day, its photos, what happened
  media/…                     the pictures, resized, with every trace of
                              metadata removed
```

Markdown and JPEGs in a folder you own. No database, no account, no lock-in.
Every day starts as a **draft** — nothing is published until you say so.

## The tools

| Skill | Say |
| --- | --- |
| `icloud-export` | "help me export photos from iCloud on my Mac" |
| `revolut-costs` | "add my budget from this Revolut statement" |

More will follow. Each one lives in `.claude/skills/<name>/` with its
instructions in `SKILL.md` and its scripts beside them, so a skill is one folder
you can read end to end.

## What it needs

macOS, and:

```bash
brew install osxphotos exiftool node
```

`osxphotos` reads the Photos library, `exiftool` rescues the GPS locations Photos
keeps in its own database rather than in the files, and `node` runs the review
page. `sips`, which makes the previews, is already on your Mac. The agent checks
all of this for you and asks before installing anything.

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

`export/`, `content/` and `import/` — your photographs, your notes, your journal
and your bank statements. This repository is the tools; none of what it touches
belongs in it.

MIT.
