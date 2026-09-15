---
name: sync
description: Keep a local content/<user>/ folder and a running Fernscout instance in step, both ways — bring down what changed on the site, send up what changed here, and stop rather than overwrite when both moved. Use when somebody says "sync my journal", "get the newest version down", "I edited a day on the site and want it here", "pull my journal", or "keep my folder up to date".
---

# Sync

```bash
export FERNSCOUT_TOKEN=…                                  # the owner's, not a trip's
node .claude/skills/sync/sync.mjs down --user <username> --dry-run
node .claude/skills/sync/sync.mjs down --user <username>
node .claude/skills/sync/sync.mjs up   --user <username>
```

Content used to flow one way. `publish` walks the folder and sends the
difference up; there was no road down, so *edit on my laptop, publish, correct
a day on the site, then get the newest version back down here* ended in
unzipping a full export over the top and losing whatever was local.

This is that road. The instance publishes a manifest — every path, its size
and a hash of its bytes — and this compares three things: what the site has,
what the folder has, and what both agreed on last time. That third one is the
whole reason it can tell *"we differ"* from *"you changed it"*, and it lives
in `.fernscout-sync.json` in the journal's root.

## What a run does

| both sides | action |
| --- | --- |
| agree | nothing |
| only the site moved | pull |
| only the folder moved | push |
| **both moved** | **stop, name every file, write nothing** |
| both made the same edit | nothing — agreement is agreement however it got there |
| gone from one side, untouched on the other | named, and see the two deletion rules below |

`--prefer-local` and `--prefer-remote` resolve conflicts, per file, in the
named direction. Without one of them a conflict ends the run with a non-zero
exit and an untouched folder: silently overwriting a day somebody wrote on the
site is the same class of harm as inventing one.

## Deletions are two different questions

**Pruning this folder** — a file deleted on the site and still here — happens
behind `--yes`, and is refused outright rather than confirmed when it would
remove more than half the files on that side. Half is the shape of an accident
rather than an edit: a wiped folder, a `--user` pointing at the wrong journal,
an unzip that stopped half way.

**Deleting on the site never happens here.** The run names what you deleted
locally and stops. That is not caution, it is what the instance's own door
says: `DELETE …/trips/<trip>/days` refuses a **published** day outright, with
no confirmation code that could ever satisfy it, because destroying content
people have already read is not a self-served round trip — and a day that has
been on the site is the ordinary case in a journal worth syncing. Taking one
off the site is `unpublish`, and it is an editorial decision rather than
something a file diff gets to make.

## What is not in a sync

- **`gps/`.** No route on either side can hand back a coordinate. A position
  history is every address somebody sleeps at; what a reader ever sees is the
  derived line for one trip, and deleting `gps/` leaves every trip rendering
  identically. That is asserted by test on the instance, not promised here.
- **`config.json` comes down whole, and goes up in part.** The file a pull
  gives you is the journal exactly as the instance stores it, including
  `owner.tel`, `owner.telProvenAt` and `owner.telProvenMethod` — the proven
  telephone number and the record of how it was proven. Those three have no
  door and never will: proving a number is a round trip a file cannot perform,
  and the API's owner block is `{name, nickname, email}` with nothing else
  accepted. So a push sends the writable fields the contract lists and drops
  those, and restoring them into a journal is an operator's job rather than a
  client's. **Treat a pulled `config.json` as personal data**: it carries
  somebody's telephone number in plain text, in a folder people copy between
  machines.
- ~~**`figures/`**~~ — **they are in the sync now** (fernscout B1776). The
  figure library was outside the allow-list on both sides, so it travelled in
  neither direction: a folder that mirrors the instance was missing it
  entirely, and a hosted owner — who has no filesystem to copy it from — had no
  copy of their own figures at all. `figures/<id>.json` and nothing else under
  that folder.
- ~~**`originals/`**~~ — **they are in the sync now** (fernscout B1719). The
  full-resolution masters used to stay on the server, and every run printed how
  many files and bytes it had not fetched. That was honest, and it was still a
  backup that gave back every photograph at a quarter of its pixels — to an
  owner with no filesystem to fetch the masters from. A first pull is now as
  large as the journal really is; a later one carries only what the hashes say
  changed.
- **Generated output** — `postcards/`, `photobooks/`, `.ingest.json`, and each
  trip's `track.json`, which the server derives from a history this side never
  holds.
- **Dotfiles**, at any depth, including this script's own state file.

Drafts **are** in, both ways. The folder is a faithful mirror or it is not a
backup.

## The up leg is `publish`, told what changed

`sync up` does the compare and then runs `publish.mjs --changed`, handing it
the list of paths that actually differ. It is not a second implementation:
`publish` is where every typed route and every refusal lives, and a sync that
re-derived any of that would be two versions of the same knowledge with
somebody's journal in the middle. What sync adds is the one thing publish never
had — a hash — so a fourteen-day trip is no longer re-`PATCH`ed to correct one
day.

`publish` on its own is unchanged and still works exactly as before, including
its own `--dry-run` and `--drafts`.

**A push that does not land is not recorded as agreement.** After the up leg,
every path it planned is checked against the site's own manifest: one whose
remote copy did not move, or which is still not there, is named, kept out of
the sync state, and makes the run exit non-zero. That guard exists because
`config.json` was in the manifest and had no door in `publish` — so a sync
planned it, said `↑ config.json — changed locally`, sent nothing, exited 0 and
then recorded that both sides agreed. The next pull saw nothing to bring back
either, and an owner's renamed journal was gone for good. The journal has a
door now; this is for whatever the next one is.

**There is no file `PUT` on the instance, and that is deliberate.** A raw byte
door onto a day would bypass every validator there is — the required fields,
the transport modes, the currency codes, the rule that every declared locale
carries a translation, and `checkWeather`, which refuses a caller supplying its
own reading. It would be a door through which an agent writes a temperature
nobody measured, by design rather than by bug.

## Three `config.json` fields never travel

`owner.email`, `baseCurrency` and `media` are refused by the instance on
purpose, each for its own reason, and every run says so rather than passing
over them in silence — "every call succeeded" is not the same claim as "every
line arrived".

`baseCurrency` and `media` are read back from the site, so a run names them
specifically when the local copy differs. `owner.email` is not read back, ever:
a token that can read a journal's config is not permission to collect its
owner's address. So there is nothing to compare it against and the run states
it unconditionally instead of guessing.

## First run

Into an empty folder, it fetches everything — one request per file. That is
right for the incremental case this exists for and is a lot of round trips on
a first sync of a large journal; `/<user>/export.zip` is the bulk door if it
ever bites, byte-faithful for everything it carries. Note that the export
*does* ship each trip's `track.json`, which a sync excludes, so a folder
seeded that way needs those deleted or the next `up` offers to push a derived
file back at the thing that derives it.

## When it stops

It stops rather than half-finishing, every time, and says what already landed.
A run that could not re-read the manifest at the end leaves the sync state
alone and says so — the next run works it out again.

```bash
node .claude/skills/sync/sync.test.mjs      # the compare, the exclusions, the threshold
```
