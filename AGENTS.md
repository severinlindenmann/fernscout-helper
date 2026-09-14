# Fernscout Helper, for agents

A toolbox for getting somebody's life **into** a Fernscout travel journal:
extract what already exists, ask for what only they know, and write the journal's
own format. This repository is **tools, not content** — what a run produces is
theirs, and `import/`, `export/` and `content/` are all gitignored.

**Built and tested with Claude Code on macOS**, which is where `.claude/skills/`
is read without configuring anything and where the photo tools can reach a Photos
library directly. Nothing below assumes it: if you are a different agent, or on a
different machine, read the skill's `SKILL.md` and check what it needs before
running it.

## Start here

| They say | Skill |
| --- | --- |
| "help me export photos from iCloud on my Mac" | `icloud-export` |
| "import my Revolut statement", "what did the trip cost" | `statement-costs` |
| "add my GPS", "import my Timeline", "the map draws straight lines" | `gps-history` |
| "add the budget", "what did the trip cost", "I paid for the flights" | `trip-budget` |
| "check my journal", "is this right", "did I forget anything", "what else can I set" | `validate-content` |
| "publish", "put it online", "upload my journal", "sync the trip" | `publish` |
| "sync my journal", "get the newest version down", "I edited a day on the site" | `sync` |

**Read the skill's `SKILL.md` before running anything.** It carries the order of
the commands, the questions to ask, and — this matters more than it sounds —
where to stop and wait for a person.

If nothing here fits what they are asking for, say so plainly and offer to do it
by hand into the same format. A missing tool is not a reason to refuse the job.

## What belongs here, and what belongs on the instance

**If a thing can run on the server, it runs on the server and this repository
calls it.** That line decides where new work goes, and it is worth stating
because the tempting answer is always the other one.

What must be here is what a server cannot reach: a Photos library, an iCloud
export, a folder on somebody's disk, a PDF that never leaves the machine, and
the questions only a person can answer. Everything past that — parsing a file
into rows, checking those rows, deciding what they mean for a trip — belongs on
the instance, where every journal gets the same version of it and a format
change is one deployment rather than one laptop at a time.

`gps-history` is the shape to copy. It finds a location export on this machine,
asks the two questions that need asking, uploads it, and calls
`POST /api/v2/<user>/import` — and it parses **nothing**. Google Timeline,
Google Takeout, GPX and plain JSON Lines are all read by `importers/` in the
fernscout repository, which is MIT-licensed for exactly this reason: somebody
adding a format contributes it there, once, for everybody.

`statement-costs` is the same shape, since B677 moved its parser to the
instance: it finds the CSV, hands it over, holds the conversation about what
each merchant was, and sends the agreed rows back. It refuses outright to
choose a category, which is the one thing in that loop that is nobody's but the
owner's.

What is left in this repository after those two moves is the honest list: a
Photos library, an iCloud export, a folder on a disk, the questions, and the
checks that need to see the files themselves.

## The one rule

**You do not decide what happened.** Every word of an entry comes from what the
person told you, and every number from something they can point at. No weather
*you* remembered or guessed, no meals nobody ate, no amount anybody estimated.
`publish --weather` is the one exception that proves this rather than breaking
it: it asks the Open-Meteo archive what a day's weather actually was, for a
day that has coordinates — a record, not a memory, and never written from an
agent's own knowledge.

An empty field beats a plausible fiction. A blank one is a question they can
answer in four seconds; an invented one is a lie they may never notice, and one
invented memory presented to somebody's family as fact is not recoverable. The
journal renders a missing cost as "not counted" and a missing day as nothing at
all — both are correct outcomes, not gaps for you to fill.

Everything you write carries `status: draft`. **Publishing is never yours to
decide** — a person removes that line, or asks you to. "It looks finished" is not
consent, and neither is silence.

The `publish` skill does not soften that. It moves the decision to one place —
the person saying the word, once, for a whole run — instead of asking about
fourteen days one at a time. Run it because they asked, in this conversation,
in words; show them the `--dry-run` plan first; and offer `--drafts` whenever
there is any doubt about whether they meant the website or just the file.

## Four things that are easy to get wrong

- **Photographs are the most private thing here.** Every picture written into
  `content/` has its metadata stripped, because a phone writes the coordinates of
  somebody's front door into the file. Coordinates go in the frontmatter instead,
  where they can be seen and deleted. Do not work around this.
- **A statement says what was paid, never what it was for.** Categories are
  proposed to the person and corrected by them, never decided quietly.
- **Weather is looked up or handed over, never filled in.** Two routes, and
  both are fine. The lookup: a day with coordinates writes `weather: true`, and
  the instance looks that day up in a public archive **inside the write that
  asks for it** (fernscout B1713) — so the day comes back with the reading
  already on it. An archive lags real time, so a day written the same evening
  can come back with `weather` still `true` and nothing attached: that is "not
  yet", not a failure, and sending `weather: true` again is how to ask a second
  time. A day with no coordinates gets nothing rather than a guess.

  The second route is a reading of somebody's own, and using it is supported
  rather than tolerated: a reading from the person's own instrument, station or
  weather service goes across whole, in `weather` as an object, with the
  `source` naming where it came from and a `recordedAt` saying when. That is
  the point of the field — somebody's own tools are allowed to produce their
  own data. What may never be sent is a reading sourced `open-meteo`: that name
  means the server measured it, and a caller claiming it is refused by name.
  `convert.mjs` turns one it finds in an old folder back into `weather: true`
  and says so rather than dropping it quietly.

  What is forbidden is unchanged and is the only thing that ever was: writing
  a reading from this repository's own belief about what that day was probably
  like. The instance can check that a source was *named*; it cannot check that
  it was *real*, so inventing a plausible instrument to satisfy the check is
  the same lie with an extra step.
- **Extracting costs time, bandwidth and sometimes money.** Anything not already
  on the machine is downloaded. Always run the step that counts and estimates
  first, read it back, and get a yes.
- **When a person is doing something, stop.** After opening a review page or
  handing over a question, do not poll files and do not guess that they are
  finished. They will tell you.

## The shape of the repository

```
.claude/skills/<name>/       one skill: SKILL.md and its scripts, together
.claude/skills/shared/       lib.mjs (arguments, CSV) · frontmatter.mjs (reading the
                             YAML a v1 folder was written in — kept for the converter
                             and nothing else) · journal.mjs (a folder, parsed) ·
                             convert.mjs (a v1 folder → the shape the instance stores,
                             once, into a new directory) · syncManifest.mjs (the local
                             walk, the hash the instance uses, and the three-way
                             compare) · api.mjs (the v2 contract and the instance's own
                             limits) · selftest.mjs (do these tools still agree with the
                             site? — and since B1715 it actually asks)
.claude/skills/shared/fixtures/  the three test journals, in the v1 shape on
                             purpose: they are what convert.mjs takes as input, and
                             selftest.mjs converts each one before checking it.
                             Committed, unlike content/, because a fixture nobody
                             can clone is not a test
import/<source>/             gitignored — statements and exports, exactly as they arrived
export/<trip>/               gitignored — working files: photos, review.json, notes.md, costs.json
content/<user>/trips/<trip>/ gitignored — the journal itself
```

Scripts are plain Node with **no dependencies** — `node:` builtins, plus
command-line tools a skill checks for. Keep it that way: somebody who clones this
should not have to run `npm install` before their photographs work.

## When the site changes under you

**These tools follow an instance rather than defining anything**, and that is
the whole design: types, enums, the asked-or-declined lists and the upload
limits all come from `<site>/api/v2/openapi.json` and `<site>/api/v2/status`
at run time. **The file shape is no longer a separate question**, and that is
the deepest thing B1715 changed: the folder holds the instance's own
documents — `trip.json` with costs and plan as sections of it,
`entries/<YYYY-MM-DD-slug>.json`, `media/<day-slug>/<hash>.jpg`, `originals/`
beside it — so "what may a file carry" and "what does a write accept" are one
question with one answer, and it is the server's.

What these tools keep for themselves, permanently, is only the half no server
can answer because it cannot see the disk: every `media` `src` having a file
behind it, a `media/<folder>/` no day names, a filename's date against the
document's own, two files claiming one slug, a day outside its trip's dates.

The history is worth keeping, because this repository has made the same
mistake three times. The file shape was a hand-kept copy here (`model.mjs`)
and fell behind: the site gained a third answer for a day whose costs nobody
recorded (`unrecorded: [costs]`, beside `without: [costs]`) and a perfectly
good journal came back with two errors, both wrong. So the copy was replaced
by reading `<site>/content-model.json` — and *that* document then described v1
for a year after the instance had stopped accepting it, which is how a
migration of four real trips came to be made entirely by hand. It is retired
now (fernscout B1700).

The rule that comes out of all three: **do not re-derive what the instance
will accept — ask it.** `validate-content` sends each document through
`?dryRun=true`, which writes nothing and answers with what would have been
accepted, or refuses with the field, the reason, and the sentence that would
decline an open section. A validator that cannot drift is worth more than one
that is clever.

```bash
node .claude/skills/shared/selftest.mjs
```

It does three things, in this order. **Every route these skills call is in
the instance's own contract** — read out of `/api/v2/openapi.json`, not
compared against a list typed here. That check did not exist until B1715, and
its absence is the whole story: this self-test was green while every write
route in this repository answered 404, because what it actually checked was
fixtures and two documents the site publishes, never a route. Then the unit
tests run. Then the three fixture journals — one with every option set, one
valid and incomplete, one with a planted fault of each kind — are converted
and checked, each against what it should say.

The fixtures live there and not under `content/` because `content/` is
gitignored — correctly, it is where somebody's own photographs go — and a
fixture that only exists on the machine that wrote it is not a regression
test. **Run it after the site is deployed with anything new**, and when a
validation message looks wrong.

If it says a route is missing, the instance has moved and these skills have
not. If it stops noticing a planted fault, the fix is in
`validate-content/validate.mjs`.

## Adding a skill

Three jobs, and a new skill does one of them: **extract** content from where it
is stuck, **create** what only a person knows, or **format** it into the
journal's shape.

One folder under `.claude/skills/`, holding a `SKILL.md` whose frontmatter
`description` says *when* to use it in the words somebody would actually type,
and the scripts it runs. Put anything a second skill would need in
`shared/` rather than importing across skill folders.

**Nothing here is macOS-only by design.** `icloud-export` needs a Mac because
that is where the Photos library is; a skill for an Android export, a Windows
folder of camera files, a Google Photos takeout or a chat log needs nothing of
the sort. Say what a skill requires in its `SKILL.md` and check for it in the
script — do not assume the machine.

## The wider project

Fernscout is a self-hostable travel journal:
<https://github.com/severinlindenmann/fernscout>. The content model this
repository writes — `trip.json`, `entries/YYYY-MM-DD-slug.json`, `media/`,
`originals/` — is that project's, and `https://fernscout.ch/agent.md` is the full guide to
working against a running instance over the network.

If they want a journal on the web rather than a folder, they need an email
address they own, and this is the prompt to hand them for a fresh session:

> Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der Übersicht
> unter https://fernscout.ch/documentation.txt und der vollständigen Anleitung
> unter https://fernscout.ch/agent.md. Du brauchst dafür eine E-Mail-Adresse, die
> mir gehört.
