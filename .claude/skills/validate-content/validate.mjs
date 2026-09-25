#!/usr/bin/env node
// Check a journal on disk against the instance that will receive it.
//
//   node validate.mjs                       every journal in content/
//   node validate.mjs --user alex             one of them
//   node validate.mjs --trip example-trip-2024   one trip
//   node validate.mjs --json                for another program to read
//   node validate.mjs --offline             the disk checks only, no network
//
// Two severities, and the difference matters:
//
//   error  the instance will refuse this, or the site cannot read it.
//   warn   it will be accepted and is probably not what anybody meant.
//
// It reports. It changes nothing — not the files, not the instance. Half of
// what it finds is a question for a person ("nine days have no costs"), and a
// tool that quietly answered those would be inventing what happened.
//
// ## Two halves, and only one of them lives here
//
// **What the instance will accept** is the instance's own question, and since
// v2 there is a door that answers it exactly: every write route takes
// `?dryRun=true` and replies with what it *would* have accepted — or refuses,
// with the field, the reason, and for an open section the sentence that would
// decline it. So this sends each document through that door and prints what
// comes back. It is not a second implementation of the rules and it cannot
// drift from them, which is the failure this whole repository keeps having:
// `model.mjs` was a hand-kept copy of the file shape and fell behind, it was
// replaced by reading `/content-model.json`, and that document then described
// v1 for a year while the instance refused what it advertised (B1700 retired
// it). A validator that re-derives the rules is a validator that will
// eventually pass a journal the server rejects, and reject fields the server
// requires.
//
// **What a server cannot know** is what stays here, permanently, because it
// is about a folder the instance has never seen: a `media` src with no file
// behind it, a media folder belonging to no day, a filename's date against the
// document's own, two files claiming one slug, a day outside its trip's dates.
// That half is real work and no door will ever do it.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { arg, has } from "../shared/lib.mjs";
import { CONTENT, isJournalShaped, mediaFile, readJournal, suggestedContentDir, usernames } from "../shared/journal.mjs";
import { asWritten, call, FALLBACK_RESERVED_SOURCES, refusal, reservedSources, SITE } from "../shared/api.mjs";

const found = [];
/** Which source names are the server's own — read from it, never typed here
 * (B1782, B1783). Offline this is unused. */
const reserved = { sources: FALLBACK_RESERVED_SOURCES, fallback: true };
const say = (severity, where, message, fix) => found.push({ severity, where, message, fix });
const error = (w, m, f) => say("error", w, m, f);
const warn = (w, m, f) => say("warn", w, m, f);

const onlyUser = arg("user");
const onlyTrip = arg("trip");
const asJson = has("json");
const offline = has("offline");

/** Does the folder's own date agree with the name it is filed under? The
 * filename is the day's identity on the wire — `2026-08-26-hoi-an` IS the
 * address — so a `date` inside that says otherwise is a day that will sort
 * and render somewhere its file name does not suggest. */
function checkDayIdentity(where, entry) {
  if (!entry.document) return;
  const inside = entry.document.date;
  if (entry.fileDate && inside && entry.fileDate !== inside) {
    error(where, `the filename says ${entry.fileDate} and the document says ${inside}`,
      "rename the file, or correct the date — they are the same fact in two places");
  }
  if (!entry.fileDate) {
    error(where, "the filename does not begin with a date",
      "a day is filed as YYYY-MM-DD-slug.json, and that name is its address on the instance");
  }
}

/** Every photograph a day names, against the disk. This is the check no
 * server can make, and the one that catches a journal published with holes in
 * it: the day says there is a picture, and there is no file. */
function checkMedia(journal, trip, entry, where) {
  for (const item of entry.document?.media ?? []) {
    const file = mediaFile(journal, item.src);
    if (!file || !existsSync(file)) {
      error(where, `media ${item.src} is named by the day and is not on disk`,
        "put the file there, or take the entry off the day — publishing it now writes a gap");
    }
  }
}

/**
 * A media or originals folder no day points at — either a day nobody wrote,
 * or photographs nobody will ever see.
 *
 * **Matched against what the days actually reference, not against the day
 * slugs.** A folder is called whatever the `src` says it is called: the
 * migrated journals file photographs under the whole day slug, and the demo
 * journal files them under a shorter name of its own. Comparing folder names
 * to day slugs reported all three of the demo journal's folders as orphans on
 * the first run of this check — a validator confidently wrong about perfectly
 * good content, which is the exact failure this repository keeps having.
 */
function checkOrphanFolders(journal, trip, where) {
  const referenced = new Set();
  for (const entry of trip.entries) {
    for (const item of entry.document?.media ?? []) {
      const match = String(item.src ?? "").match(/^\/media\/[^/]+\/([^/]+)\//);
      if (match) referenced.add(match[1]);
    }
  }
  for (const [kind, folders] of [["media", trip.mediaFolders], ["originals", trip.originalFolders]]) {
    for (const folder of folders) {
      if (!referenced.has(folder)) {
        warn(where, `${kind}/${folder}/ is named by no day`,
          "either a day is missing, or these photographs are not part of this trip");
      }
    }
  }
}

/** A day outside the trip it is filed under. The instance does not refuse
 * this, and it is almost always a typo in one of the two dates. */
function checkDates(trip, where) {
  const from = trip.trip?.document?.dates?.from;
  const to = trip.trip?.document?.dates?.to;
  if (!from || !to) return;
  for (const entry of trip.entries) {
    const date = entry.document?.date ?? entry.fileDate;
    if (date && (date < from || date > to)) {
      warn(`${where}/${entry.slug}`, `this day is ${date} and the trip runs ${from} to ${to}`,
        "correct whichever is wrong — the trip's dates decide what the site shows");
    }
  }
}

/**
 * The instance's own verdict on one document, through the door that exists
 * for it.
 *
 * `?dryRun=true` writes nothing and answers with what it would have accepted.
 * A `422 incomplete` is the interesting one: it names every section that is
 * neither answered nor declined, and the sentence that would decline each —
 * which is the thing a person has to write, and the thing no tool may write
 * for them.
 */
async function askTheInstance(path, document, where) {
  const existing = await call("GET", path);
  const result = existing.ok
    ? await call("PATCH", `${path}?dryRun=true`, { body: document, ifMatch: existing.etag })
    : await call("PUT", `${path}?dryRun=true`, { body: document });
  if (result.ok) return { ok: true };
  if (result.status === 401 || result.status === 403) {
    error(where, `the instance refused the credential (${result.status})`,
      "a validation run reads and dry-runs the whole journal, so it needs the owner's token");
    return { ok: false, status: result.status };
  }
  error(where, refusal(result).split("\n").join("\n      "),
    "this is the instance's own answer — fix the folder, and never invent a decline to get past it");
  return { ok: false, status: result.status, code: result.body?.error };
}

async function validateJournal(user) {
  const journal = readJournal(user);
  if (journal.configProblem) error(`${user}/config.json`, journal.configProblem, "the file does not parse as JSON");
  else if (!journal.config) error(user, "no config.json", "a journal folder has one, and it names who it belongs to");

  for (const figure of journal.figures) {
    if (figure.problem) error(`${user}/figures/${figure.id}.json`, figure.problem, "the file does not parse as JSON");
  }
  // No cap on the library itself — the demo journal holds sixteen and the
  // instance is perfectly happy with them. The ten is the most figures ONE
  // TRIP may name, which is checked per trip below.
  const figureIds = new Set(journal.figures.map((f) => f.id));

  for (const trip of journal.trips) {
    if (onlyTrip && trip.id !== onlyTrip) continue;
    const where = `${user}/${trip.id}`;

    if (!trip.trip) { error(where, "no trip.json", "every trip folder has one — costs and plan are sections of it"); continue; }
    if (trip.trip.problem) { error(where, trip.trip.problem, "the file does not parse as JSON"); continue; }

    // A folder written by the old tools, spotted by what it still has. Left
    // as an error rather than converted here: converting is `convert.mjs`,
    // it writes a new folder, and it reports four decisions only a person can
    // make.
    for (const old of ["trip.md", "costs.md", "plan.md"]) {
      if (existsSync(join(trip.dir, old))) {
        error(where, `${old} is still here — this folder predates the v2 content model`,
          "node .claude/skills/shared/convert.mjs <user> writes the converted folder beside it");
      }
    }

    checkOrphanFolders(journal, trip, where);
    checkDates(trip, where);

    // A trip names figures out of the journal's library; one it names that is
    // not there is a refusal on the wire and a missing walker on the page.
    const named = trip.trip.document?.figures?.figures ?? [];
    for (const id of named) {
      if (!figureIds.has(id)) {
        error(where, `this trip names the figure "${id}" and figures/${id}.json is not there`,
          "create it, or take the name off the trip — the instance refuses a trip naming a figure it does not have");
      }
    }
    if (named.length > 10) {
      error(where, `this trip names ${named.length} figures`, "a trip may name at most ten");
    }

    const seen = new Map();
    for (const entry of trip.entries) {
      const dayWhere = `${where}/${entry.slug}`;
      if (entry.problem) { error(dayWhere, entry.problem, "the file does not parse as JSON"); continue; }
      checkDayIdentity(dayWhere, entry);
      checkMedia(journal, trip, entry, dayWhere);
      if (seen.has(entry.slug)) error(dayWhere, `two files claim the slug ${entry.slug}`, "one day, one address — rename one of them");
      seen.set(entry.slug, entry.file);
    }

    if (offline) continue;
    const verdict = await askTheInstance(`/api/v2/${user}/trips/${trip.id}`, trip.trip.document, where);
    /**
     * B1777: a day cannot be checked before its trip exists.
     *
     * This used to ask about every day regardless, so a first run over a
     * journal the instance has never seen answered `404 unknown_trip` 145
     * times and the 26 real trip-level errors were somewhere in the middle of
     * it. Correct information, and useless. A trip that exists and is refused
     * for a content reason still has its days checked — that refusal is about
     * the document, not the address.
     */
    if (verdict.status === 404) {
      warn(where, `${trip.entries.length} day(s) were not checked — the instance does not hold this trip yet`,
        "publish the trip first, or read the trip-level refusal above; a day's address is under its trip");
      continue;
    }
    for (const entry of trip.entries) {
      if (!entry.document) continue;
      await askTheInstance(
        `/api/v2/${user}/trips/${trip.id}/days/${entry.slug}`,
        // B1782: a reading the instance made itself is handed back as the ask
        // that produced it, exactly as publish does — the two have to agree
        // about what a writable document is, or this passes what publish is
        // refused for.
        { ...asWritten(entry.document, reserved.sources), slug: entry.slug },
        `${where}/${entry.slug}`,
      );
    }
  }
}

if (!offline) Object.assign(reserved, await reservedSources());

// ── which journals ─────────────────────────────────────────────────────────
const all = usernames();
if (!all.length) {
  const suggestion = suggestedContentDir();
  console.error(
    `Nothing journal-shaped under ${CONTENT}.` +
    (suggestion ? `\nDid you mean FERNSCOUT_CONTENT_DIR=${suggestion}?` : ""),
  );
  process.exit(1);
}
const users = onlyUser ? [onlyUser] : all;
for (const user of users) {
  if (!isJournalShaped(join(CONTENT, user))) {
    error(user, "this does not look like a journal", "a journal folder has a config.json and a trips/ directory");
    continue;
  }
  await validateJournal(user);
}

// ── say it ─────────────────────────────────────────────────────────────────
const errors = found.filter((f) => f.severity === "error");
const warnings = found.filter((f) => f.severity === "warn");

if (asJson) {
  console.log(JSON.stringify({ site: offline ? null : SITE, found }, null, 1));
} else {
  for (const f of found) {
    console.log(`${f.severity === "error" ? "✗" : "!"} ${f.where}\n    ${f.message}${f.fix ? `\n    → ${f.fix}` : ""}`);
  }
  console.log(
    found.length
      ? `\n${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` +
        (offline ? " — disk checks only; the instance was not asked what it would accept." : "")
      : offline
        ? "\nNothing wrong on disk. The instance was not asked what it would accept (--offline)."
        : `\nNothing wrong, and ${SITE} would accept all of it.`,
  );
}
process.exit(errors.length ? 1 : 0);
