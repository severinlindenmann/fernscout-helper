# Fernscout Helper, for agents

This repository is **tools, not content.** Somebody clones it, opens it with
you, and asks for help turning their own photographs into a travel journal. What
a run produces — `export/` and `content/` — is theirs and is gitignored.

## Start here

The person will say something like "help me export photos from iCloud on my
Mac". That is the `icloud-export` skill in `.claude/skills/icloud-export/`.
**Read its `SKILL.md` before running anything**; it carries the order of the
commands, the questions to ask, and where to stop and wait.

## The one rule

**You do not decide what happened.** Every word of a journal entry comes from
what the person told you — their day notes and photo notes in
`export/<trip>/notes.md` — and from nothing else. No weather nobody mentioned,
no meals nobody ate, no feelings nobody expressed. An empty field beats a
plausible fiction: a blank one is a question they can answer in four seconds, an
invented one is a lie they may never notice, and one invented memory presented
to somebody's family as fact is not recoverable.

Everything you write carries `status: draft`. **Publishing is never yours to
decide** — a person removes that line, or asks you to. "It looks finished" is
not consent, and neither is silence.

## Three things that are easy to get wrong

- **Photographs are the most private thing here.** Every picture written into
  `content/` has its metadata stripped, because a phone writes the coordinates of
  somebody's front door into the file. Coordinates go in the frontmatter instead,
  where they can be seen and deleted. `build.mjs` does this; do not work around
  it.
- **Exporting costs time and bandwidth.** Anything not already on the Mac comes
  down from iCloud. Always run `query.mjs` first, read the size and the count
  back to the person, and get a yes before `export.mjs`.
- **The review page is theirs, and it takes as long as it takes.** After opening
  it, stop. Do not poll `review.json`, do not guess that they are finished. They
  will come back and say so — the page tells them to.

## The shape of the repository

```
.claude/skills/<name>/       one skill: SKILL.md and its scripts, together
export/<trip>/               gitignored — photos, photos.json, review.json, notes.md
content/<user>/trips/<trip>/ gitignored — the journal itself
```

Scripts are plain Node with **no dependencies** — `node:` builtins, plus
`osxphotos`, `exiftool` and `sips` on the command line. Keep it that way: a
person who clones this should not have to run `npm install` before their photos
work.

## Adding a skill

One folder under `.claude/skills/`, holding a `SKILL.md` whose frontmatter
`description` says *when* to use it in the words a person would actually type,
and the scripts it runs. Shared helpers go in that folder too — nothing here is
big enough to earn a package.

## The wider project

Fernscout itself is a self-hostable travel journal:
<https://github.com/severinlindenmann/fernscout>. The content model this
repository writes — `trip.md`, `entries/YYYY-MM-DD-slug.md`, `media/` — is that
project's, and `https://fernscout.ch/agent.md` is the full guide to working
against a running instance over the network.

If the person asks for a journal on the web rather than a folder, they need an
email address they own, and this is the prompt to hand them for a fresh session:

> Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der Übersicht
> unter https://fernscout.ch/documentation.txt und der vollständigen Anleitung
> unter https://fernscout.ch/agent.md. Du brauchst dafür eine E-Mail-Adresse, die
> mir gehört.
