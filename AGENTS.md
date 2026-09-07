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
| "import my Revolut statement" | `revolut-costs` |
| "add my GPS", "import my Timeline", "the map draws straight lines" | `gps-history` |
| "add the budget", "what did the trip cost", "I paid for the flights" | `trip-budget` |
| "check my journal", "is this right", "did I forget anything", "what else can I set" | `validate-content` |
| "publish", "put it online", "upload my journal", "sync the trip" | `publish` |

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
`POST /api/v1/<user>/import` — and it parses **nothing**. Google Timeline,
Google Takeout, GPX and plain JSON Lines are all read by `importers/` in the
fernscout repository, which is MIT-licensed for exactly this reason: somebody
adding a format contributes it there, once, for everybody.

`revolut-costs` is the one that still has it the wrong way round — 122 lines of
statement parsing that would work identically on the server. B677 in the
fernscout repository is the move.

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
- **Weather is an archive lookup, not a field to fill in.** A day with
  coordinates can carry it — `validate-content` tips the offer, `publish
  --weather` sends it for the whole trip in one run — but it is always the
  server asking Open-Meteo for what a day actually was, at the person's word,
  never this repository's own guess. A day with no coordinates gets nothing.
- **Extracting costs time, bandwidth and sometimes money.** Anything not already
  on the machine is downloaded. Always run the step that counts and estimates
  first, read it back, and get a yes.
- **When a person is doing something, stop.** After opening a review page or
  handing over a question, do not poll files and do not guess that they are
  finished. They will tell you.

## The shape of the repository

```
.claude/skills/<name>/       one skill: SKILL.md and its scripts, together
.claude/skills/shared/       lib.mjs (arguments, CSV) · costfile.mjs (costs: blocks)
                             frontmatter.mjs (reading YAML) · contentModel.mjs (the file
                             shape — reads it off <site>/content-model.json, falling back
                             to the committed content-model.snapshot.json only when the
                             instance cannot be reached) · snapshot.mjs (refreshes that
                             snapshot from a real instance; never hand-edit the JSON) ·
                             pattern.mjs (a `pattern` rule, matched without ever handing
                             an untrusted regex to RegExp) · journal.mjs (a folder,
                             parsed) · api.mjs · selftest.mjs (do these tools still agree
                             with the site?)
.claude/skills/shared/fixtures/  the three test journals selftest.mjs runs —
                             committed, unlike content/, because a fixture nobody
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
the whole design: types, enums, required lists and the upload limits all come
from `<site>/openapi.json` and `<site>/api/health` at run time, and the shape
of the *files* — which keys a `trip.md` may carry, which of them never travel
— comes from `<site>/content-model.json`, published for exactly the reason a
contract about HTTP cannot describe that on its own. What these tools keep
for themselves, permanently, is only the half no server can answer because it
cannot see the disk: every `gallery:` `src` existing, a `media/<slug>/`
folder belonging to no day, a filename's date against the frontmatter's, two
files sharing a slug, a date inside the trip with no day at all.

That last part — the file shape — used to be a hand-kept copy here
(`model.mjs`), and it fell behind more than once: the site gained a third
answer for a day whose costs nobody recorded (`unrecorded: [costs]`, beside
`without: [costs]`), and these tools did not know the key. A perfectly good
journal came back with two errors, both wrong. The validator was working
correctly and had simply not been told — which is the whole reason the copy
is gone and the shape is fetched now too.

Fetching it does mean a clone with no network cannot check anything the
first time. `content-model.snapshot.json`, committed beside `contentModel.mjs`
and refreshed with `node .claude/skills/shared/snapshot.mjs`, is the answer:
generated from a real instance, never hand-edited, and only ever reached for
when the live document cannot be — every run that falls back to it says so,
plainly, naming which snapshot and when it was taken. `selftest.mjs` fails
the moment it disagrees with the live document, which is what makes a
committed copy acceptable here when it was not acceptable as `model.mjs`:
nothing compared that one to anything.

```bash
node .claude/skills/shared/selftest.mjs
```

Three test journals under `.claude/skills/shared/fixtures/` — one with every
option set, one valid and incomplete, one with a planted fault of each kind —
run through the validator, each checked against what it should say. They live
there and not under `content/` because `content/` is gitignored — correctly,
it is where somebody's own photographs go — and a fixture that only exists on
the machine that wrote it is not a regression test. **Run it after the site is
deployed with anything new**, and when a validation message looks wrong.

If it reports a real field as unknown, the fix is in the fernscout repo's
content-model.json — this repository only reads it, and `snapshot.mjs`
refreshes the committed fallback to match. If it stops noticing a planted
fault, the fix is in `validate-content/validate.mjs`.

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
repository writes — `trip.md`, `costs.md`, `entries/YYYY-MM-DD-slug.md`, `media/`
— is that project's, and `https://fernscout.ch/agent.md` is the full guide to
working against a running instance over the network.

If they want a journal on the web rather than a folder, they need an email
address they own, and this is the prompt to hand them for a fresh session:

> Führe mich durch das Anlegen meines eigenen Reisetagebuchs, nach der Übersicht
> unter https://fernscout.ch/documentation.txt und der vollständigen Anleitung
> unter https://fernscout.ch/agent.md. Du brauchst dafür eine E-Mail-Adresse, die
> mir gehört.
