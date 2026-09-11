#!/usr/bin/env node
// Put what is in content/ onto the instance, creating whatever is missing.
//
//   node publish.mjs --user severin                 the whole journal
//   node publish.mjs --user severin --trip algarve-2026
//   node publish.mjs --user severin --dry-run       say what it would do
//   node publish.mjs --user severin --dry-run --offline   … without asking the site
//   node publish.mjs --user severin --drafts        write the days, do not publish them
//   node publish.mjs --user severin --weather       ask the archive for every day's weather
//
// `--weather` is the one place this repository asks a whole trip a single
// question rather than fourteen days one at a time — see AGENTS.md. It sends
// `weather: true` on every day that has `lat`/`lng`, which asks the server to
// look that day up in the Open-Meteo archive; a day with no coordinates is
// left alone rather than asked, because the server has nothing to look up
// and asking anyway would claim a certainty nobody has. It also needs the
// journal's own `config.json` to have switched `features.weather` on —
// `/api/health`'s capability is only the server's ceiling, and a request sent
// under a journal that has not opted in comes back 200 and does nothing, so
// this checks first and says plainly what to add rather than sending it.
//
// It asks nothing. Everything it does is decided by comparing what is on disk
// with what the instance already has: a trip that is not there is created, a
// day that is not there is written, a day that is there is patched, and
// photographs that are not on the day yet are sent. Running it twice does the
// same work as running it once.
//
// `--dry-run` still asks the site what each day already holds, because that
// is the only way its printed counts can be the counts a real run would then
// send — a plan is not a rehearsal if it guesses at the one number that
// measures time, bandwidth and money. `--offline` (the same flag
// `validate-content` uses) skips that asking and says so in what it prints:
// a no-network plan is allowed to exist, but not to look like it asked.
//
// **It refuses to start while `validate.mjs` reports an error.** Publishing
// content the instance will partly reject leaves a journal half-written, which
// is worse than not starting — and the errors are cheap to read first.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, has } from "../shared/lib.mjs";
import { SITE, call, health, refusal, token } from "../shared/api.mjs";
import { galleryFile, readJournal } from "../shared/journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const user = arg("user");
const only = arg("trip");
const dry = has("dry-run");
const offline = has("offline");
const draftsOnly = has("drafts");
// The owner said the word for the whole trip, once — see AGENTS.md's "one
// rule". Applied to every day that has lat/lng; a day with no coordinates
// gets nothing rather than a guess, because the server has nothing to look up
// and asking anyway would claim a certainty nobody has.
const weather = has("weather");

if (!user) {
  console.error("Which journal? node publish.mjs --user <username>");
  process.exit(1);
}
if (offline && !dry) {
  console.error("--offline only makes sense with --dry-run: a real run has to ask the site to send anything.");
  process.exit(1);
}

const did = [];
const note = (line) => { did.push(line); console.log(line); };
const step = (what) => (dry ? `would ${what}` : what);

/** Stop on anything the instance refused. A half-written journal is the one
 * outcome worse than not starting. */
function refuse(result, what) {
  console.error(`\n✗ ${what}\n      ${refusal(result).replace(/\n/g, "\n")}`);
  console.error("\nNothing further was sent. Fix the above and run again — what already landed stays.");
  process.exit(1);
}

/**
 * Set (or fix) the `slug:` line in an entry's own frontmatter — textually,
 * the same discipline the server itself uses when it edits a file (see
 * `spliceScalar` in the fernscout repo): find the line if it is there, replace
 * it; otherwise insert one just above the closing `---`. Never touches
 * anything else in the file, so a hand-written comment or key order survives.
 *
 * B578. A day's title is something a person edits — fixing a typo, rewording
 * it — and title+date used to be the *only* way this script found a day it
 * had already written. Recording the slug the instance actually assigned,
 * once, the way `id:` records a trip's own address, means a later run finds
 * the same day even after every other field on it has changed. Skipped
 * entirely on a file with no frontmatter block to edit, and never called
 * during `--dry-run` — a plan sends nothing, and that includes this.
 */
function recordSlug(entry, slug) {
  if (entry.data.slug === slug) return;
  const lines = entry.text.split("\n");
  if (lines[0]?.trim() !== "---") return;
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closing < 0) return;
  const at = lines.findIndex((line, i) => i > 0 && i < closing && /^slug:(\s|$)/.test(line));
  const rendered = `slug: "${slug}"`;
  if (at >= 0) lines[at] = rendered;
  else lines.splice(closing, 0, rendered);
  const updated = lines.join("\n");
  writeFileSync(entry.path, updated);
  entry.text = updated;
  entry.data.slug = slug;
}

// ── 1. the content has to be right before any of it is sent ────────────────
if (!has("skip-validate")) {
  try {
    execFileSync(process.execPath, [join(HERE, "../validate-content/validate.mjs"), "--user", user], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error(
      "validate.mjs reports errors, so nothing was sent.\n" +
      `Run:  node .claude/skills/validate-content/validate.mjs --user ${user}\n` +
      "Fix what it marks ✗ and run this again. (--skip-validate overrides, and is almost never right.)",
    );
    process.exit(1);
  }
}

/**
 * Fail here, with the instructions, rather than half-way through a journal.
 *
 * Unless a journal is being created: that path starts from an address and a
 * mailed code and ends holding a token of its own, so demanding one first
 * would be asking for the thing this run is about to produce.
 */
const creating = Boolean(arg("email"));
if (!creating) {
  try { token(); } catch (missing) { console.error(missing.message); process.exit(1); }
}

/** What this server will take in an upload — its answer, not a guess here. */
let LIMITS = {};
try { LIMITS = (await health()).doc?.media ?? {}; } catch { LIMITS = {}; }
const journal = readJournal(user);
console.log(
  `${SITE} · content/${user}` +
  (dry ? ` · dry run, nothing is sent${offline ? " · offline — the photograph counts below are not checked against the site" : ""}` : "") +
  "\n",
);

// `/api/health`'s capability is the server's ceiling; whether *this* journal
// has opted in is `config.json`'s own `features.weather.enabled`, and the two
// are checked separately on purpose. A `PATCH …/days/<slug>` with
// `weather: true` under a journal that has not opted in comes back 200 and
// fills in nothing — the server's own refusals never reach this call, so
// there is no error here to catch and nothing this script can tell apart from
// success. Sending it anyway would be fourteen requests that look like they
// worked and were not.
const weatherOn = journal.config?.features?.weather?.enabled === true;
if (weather && !weatherOn) {
  console.log(
    "--weather was asked for, but this journal has not switched it on: add\n" +
    '  "weather": { "enabled": true }\n' +
    "to features in content/" + user + "/config.json, then run this again. Nothing about the " +
    "weather was sent this run.\n",
  );
}
const sendWeather = weather && weatherOn;

// ── 2. the journal itself ──────────────────────────────────────────────────
let status = process.env.FERNSCOUT_TOKEN
  ? await call("GET", `/api/v1/${user}/status`)
  : { ok: false, status: 404, body: null };

/**
 * The journal itself, when there is not one yet.
 *
 * This is the one step that cannot be silent, and the reason is not a design
 * choice here: a new journal is bound to an address somebody owns, and the
 * server mails a six-digit code to it. No script can read their mail.
 *
 * So it is two runs and exactly one question, which is as close to "just
 * publish" as the address check allows:
 *
 *   node publish.mjs --user u --email you@example.com     asks for the code
 *   node publish.mjs --user u --email you@example.com --code 123456
 *
 * Everything after that — the trip, the days, the photographs, the publishing
 * — happens in the same run without asking anything.
 */
if (status.status === 404 || status.status === 401) {
  const email = arg("email");
  const code = arg("code");
  if (!email) {
    console.error(
      `There is no journal called "${user}" on ${SITE} yet.\n\n` +
      "Creating one needs an address you own — a six-digit code goes to it, and no script\n" +
      "can read your mail. Run this again with the address:\n\n" +
      `  node publish.mjs --user ${user} --email <your address>\n\n` +
      "then once more with the code it sends you.",
    );
    process.exit(1);
  }
  if (!code) {
    // A dry run sends nothing, and that has to include this. It used to mail a
    // real six-digit code from a run whose whole promise is "nothing is sent"
    // — a person got a signup mail for a journal nobody had decided to create.
    if (dry) {
      console.log(
        `Would ask ${SITE} to mail a signup code to ${email}, and stop there.\n` +
        "A new journal is bound to an address somebody owns, so that step cannot be\n" +
        "rehearsed. Run without --dry-run when they are ready, then again with --code.",
      );
      process.exit(0);
    }
    const asked = await call("POST", "/api/auth/signup/request", {
      auth: false,
      body: { username: user, email },
    });
    if (!asked.ok) refuse(asked, "POST /api/auth/signup/request");
    console.log(
      `A six-digit code is on its way to ${email}. It works for 30 minutes.\n` +
      "When you have it, run:\n\n" +
      `  node publish.mjs --user ${user} --email ${email} --code <the six digits>\n`,
    );
    process.exit(0);
  }

  const verified = await call("POST", "/api/auth/signup/verify", {
    auth: false,
    body: { username: user, email, code },
  });
  if (!verified.ok) refuse(verified, "POST /api/auth/signup/verify");

  // config.json is the whole description of the journal, so the create call is
  // built from it rather than from anything asked for here.
  const c = journal.config ?? {};
  const made = await call("POST", "/api/v1/journals", {
    headers: { authorization: `Bearer ${verified.body.token}` },
    auth: false,
    body: {
      username: user,
      title: c.title ?? user,
      ...(c.tagline ? { tagline: c.tagline } : {}),
      ownerName: c.owner?.name ?? "",
      ownerNickname: c.owner?.nickname ?? c.owner?.name ?? "",
      visibility: c.visibility ?? "public",
      defaultLocale: c.defaultLocale ?? "en",
      locales: c.locales ?? [c.defaultLocale ?? "en"],
      ...(c.baseCurrency ? { baseCurrency: c.baseCurrency } : {}),
      ...(c.displayCurrencies ? { displayCurrencies: c.displayCurrencies } : {}),
      ...(c.units ? { units: c.units } : {}),
      ...(c.startLocation ? { startLocation: c.startLocation } : {}),
    },
  });
  if (!made.ok) refuse(made, "POST /api/v1/journals");
  note(`created the journal ${user}`);
  console.log(
    `\n  Give this to ${c.owner?.name ?? "them"}, now, in your reply — it signs them in once,\n` +
    `  for 15 minutes, so they can see their own drafts:\n\n      ${made.body.signIn}\n\n` +
    `  And this is the journal's agent token, good for seven days. Keep it out of any file\n` +
    `  in this repository:\n\n      export FERNSCOUT_TOKEN=${made.body.token}\n`,
  );
  process.env.FERNSCOUT_TOKEN = made.body.token;
  status = await call("GET", `/api/v1/${user}/status`);
}

if (!status.ok) refuse(status, `GET /api/v1/${user}/status`);
note(`journal ${user} exists — ${status.body?.trips?.length ?? "?"} trips already there`);

/**
 * The journal's own settings, from config.json.
 *
 * Missed entirely until this was tested end to end: the folder is where a
 * person defines their journal, and the title, the languages and the
 * currencies in it were never sent anywhere. A trip would be created inside a
 * journal still called whatever the signup called it.
 *
 * Two calls, because the server refuses a body naming `features` alongside a
 * profile field — deliberately, so "turn mail off" cannot also rename the
 * journal by accident.
 */
if (journal.config) {
  const profile = {};
  for (const key of ["title", "tagline", "visibility", "startLocation", "units",
                     "locales", "defaultLocale", "displayCurrencies", "manualRates"]) {
    if (journal.config[key] !== undefined) profile[key] = journal.config[key];
  }
  if (Object.keys(profile).length) {
    note(`  ${step(`set the journal's own fields — ${Object.keys(profile).join(", ")}`)}`);
    if (!dry) {
      const patched = await call("PATCH", `/api/v1/${user}/config`, { body: profile });
      if (!patched.ok) refuse(patched, `PATCH /api/v1/${user}/config`);
    }
  }
  const features = Object.fromEntries(
    Object.entries(journal.config.features ?? {})
      .filter(([, value]) => value && typeof value.enabled === "boolean")
      .map(([name, value]) => [name, value.enabled]),
  );
  const requestedFeatureKeys = Object.keys(features);
  if (requestedFeatureKeys.length) {
    if (dry) {
      note(`  ${step(`set features — ${Object.entries(features).map(([k, v]) => `${k}=${v}`).join(", ")}`)}`);
    } else {
      const patched = await call("PATCH", `/api/v1/${user}/config`, { body: { features } });
      // A capability this server cannot offer is refused, and that is a fact
      // about the server rather than a mistake in the folder: say it and go on.
      if (!patched.ok) {
        console.log(`      note: ${patched.body?.error ?? patched.status} — ${patched.body?.message ?? "features left as they were"}`);
      } else {
        // Print the server's own note verbatim (B1400) — it, not this
        // script, knows which keys actually got written, and duplicating
        // that wording here is the two-places-disagree problem. The note
        // alone does not name *which* requested keys were left unapplied,
        // so call those out separately.
        const changedKeys = new Set(patched.body?.changed ?? []);
        const unapplied = requestedFeatureKeys.filter((key) => !changedKeys.has(key));
        note(`  ${step("set features")} — ${patched.body?.note ?? `changed: ${[...changedKeys].join(", ") || "none"}`}`);
        if (unapplied.length) {
          note(`      not applied: ${unapplied.join(", ")}`);
        }
      }
    }
  }
}

// ── 3. each trip ───────────────────────────────────────────────────────────
const remote = await call("GET", `/api/v1/${user}/trips`);
if (!remote.ok) refuse(remote, `GET /api/v1/${user}/trips`);
const existing = new Set((remote.body?.trips ?? []).map((t) => t.id));

for (const trip of journal.trips) {
  if (only && trip.id !== only) continue;
  const data = trip.trip?.data ?? {};
  console.log(`\n── ${trip.id}`);

  if (!existing.has(trip.id)) {
    // Everything trip.md carries, in one call. The body is the intro.
    const body = { id: trip.id, title: data.title, start: data.start, end: data.end };
    for (const key of ["tagline", "status", "accent", "visibility", "listed", "costsVisibility",
                       "test", "people", "travellers", "rates", "tracks", "translations"]) {
      if (data[key] !== undefined && data[key] !== null) body[key] = data[key];
    }
    if (trip.trip?.body) body.intro = trip.trip.body;
    note(`  ${step("create the trip")}`);
    if (!dry) {
      const made = await call("POST", `/api/v1/${user}/trips`, { body });
      if (!made.ok) refuse(made, `POST /api/v1/${user}/trips (${trip.id})`);
    }
  } else {
    note("  trip is already there");
    // The one-field doors, for a trip that existed before this run.
    if (data.visibility !== undefined || data.listed !== undefined) {
      const body = {};
      if (data.visibility !== undefined) body.visibility = data.visibility;
      if (data.listed !== undefined) body.listed = data.listed;
      note(`  ${step(`set visibility ${JSON.stringify(body)}`)}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/visibility`, { body });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/visibility`);
      }
    }
    if (data.rates && Object.keys(data.rates).length) {
      note(`  ${step("set the trip's rates")}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/rates`, { body: { rates: data.rates } });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/rates`);
      }
    }
    // B524 built three more doors for a trip that already exists — people,
    // travellers, tracks — and this used to walk through none of them: an
    // edited trip.md said nothing had changed as long as the trip itself was
    // already there. "trip is already there" is not "trip.md has nothing left
    // to send".
    if (data.people && data.people.length) {
      note(`  ${step("set the trip's people")}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/people`, { body: { people: data.people } });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/people`);
      }
    }
    if (data.travellers && data.travellers.length) {
      note(`  ${step("set the trip's travellers")}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/travellers`, { body: { travellers: data.travellers } });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/travellers`);
      }
    }
    if (data.tracks && Object.keys(data.tracks).length) {
      note(`  ${step("set what the trip tracks")}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/tracks`, { body: { tracks: data.tracks } });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/tracks`);
      }
    }

    // The fields with no door at all — B245, still open. Silence here is what
    // B572 was: a `trip.md` edited after the first publish, and nothing
    // saying so. This cannot write them, but it can say which of them differ
    // from what the site already shows, so an operator finds out from this
    // run rather than from the site looking wrong later.
    const detail = offline ? { ok: false } : await call("GET", `/api/v1/${user}/trips/${trip.id}`);
    if (detail.ok) {
      const live = detail.body ?? {};
      const stale = [];
      for (const key of ["title", "start", "end", "tagline", "accent", "translations", "cover"]) {
        if (data[key] === undefined || data[key] === null) continue;
        if (JSON.stringify(data[key]) !== JSON.stringify(live[key])) stale.push(key);
      }
      if (trip.trip?.body && trip.trip.body !== (live.intro ?? "")) stale.push("intro");
      if (stale.length) {
        console.log(
          `  ⚠ ${stale.join(", ")} differ${stale.length === 1 ? "s" : ""} from what ${SITE} shows, ` +
          `and there is no call that can change ${stale.length === 1 ? "it" : "them"} on an existing trip ` +
          "(B245, in the fernscout repo, still open). Edit it there by hand for now.",
        );
      }
    } else if (!offline) {
      console.log(`      note: could not read the trip back to check title/start/end/tagline/accent/intro/translations/cover (${detail.status})`);
    }
  }

  // ── the budget and the costs paid before leaving ─────────────────────────
  if (trip.costs) {
    const body = {};
    if (trip.costs.data.budget) body.budget = trip.costs.data.budget;
    if (trip.costs.data.costs) body.costs = trip.costs.data.costs;
    if (trip.costs.body) body.body = trip.costs.body;
    note(`  ${step(`put costs.md — ${body.costs?.length ?? 0} lines${body.budget ? " and a budget" : ""}`)}`);
    if (!dry) {
      const put = await call("PUT", `/api/v1/${user}/trips/${trip.id}/costs`, { body });
      if (!put.ok) refuse(put, `PUT …/${trip.id}/costs`);
    }
  }

  // ── the days ─────────────────────────────────────────────────────────────
  //
  // **The slug is the server's to choose, not the filename's.** It is made
  // from the title, and a file called `2026-03-01-tag-eins.md` whose title is
  // "Abfahrt in Basel" becomes `abfahrt-in-basel`. Assuming otherwise sent the
  // photographs to a day that did not exist, and — worse, on a second run —
  // would have written every day again under the name it expected.
  //
  // So: find the day the instance already has, and take the slug from the
  // answer. Three ways, tried in order of how sure they are — B578, after a
  // retitled day was found "new" by the second of these, which then hit the
  // idempotency key from its first write and stopped the whole run on a 409
  // whose message was about a key, not about a day that just needed updating:
  //
  //   1. the slug this same script recorded into the file the last time it
  //      wrote this day (see `recordSlug` above) — exact, and survives any
  //      retitle or rename, because it does not depend on either.
  //   2. date + title, unchanged since the day was last sent — exact, and the
  //      only test this file used before B578.
  //   3. date alone, when exactly one remote day shares it — a guess, made
  //      only when the first two have nothing, and named as a guess in what
  //      this prints. Two days sharing a date are left alone rather than
  //      guessed at; a genuinely new day on a date that already has one is
  //      still created.
  // A trip about to be created in this same run cannot have any days on the
  // instance yet, so a 404 here is the empty list that plan needs rather than
  // a refusal — the same reasoning `refuse()` already gets for a trip that
  // exists, just not yet for one that does not. `--offline` skips the request
  // outright, matching the two other places this file already does that.
  const isNewTrip = !existing.has(trip.id);
  const listed = offline ? { ok: false } : await call("GET", `/api/v1/${user}/trips/${trip.id}/days`);
  let days;
  if (listed.ok) days = listed.body?.days ?? listed.body?.entries ?? [];
  else if (offline || (isNewTrip && listed.status === 404)) days = [];
  else refuse(listed, `GET …/${trip.id}/days`);
  const bySlug = new Map(days.map((d) => [d.slug, d]));
  const byTitleDate = new Map(days.map((d) => [`${d.date}|${d.title}`, d]));
  const byDate = new Map();
  for (const d of days) {
    if (!byDate.has(d.date)) byDate.set(d.date, []);
    byDate.get(d.date).push(d);
  }
  // A remote day matched once by any of the three ways below is not offered
  // to a second local file in the same run — otherwise a genuinely new day
  // sharing a date with one already claimed by the date-only guess would be
  // "matched" onto it too, and never created at all.
  const claimed = new Set();
  // The date-alone guess below is only sound when the *local* side is just as
  // unambiguous as the remote side it already checks — B647: a Friday split
  // into two local entries, matched against one remote day sharing that date,
  // let the first entry processed win the date-alone branch and overwrite the
  // other Friday's content. Counting local entries per date the same way
  // `byDate` counts remote ones is the other half of the invariant the
  // comment above states.
  const localByDate = new Map();
  for (const e of trip.entries) {
    const d = e.data.date ?? e.fileDate;
    localByDate.set(d, (localByDate.get(d) ?? 0) + 1);
  }

  for (const entry of trip.entries) {
    const date = entry.data.date ?? entry.fileDate;
    const body = { title: entry.data.title, date, content: entry.body };
    for (const key of ["time", "location", "country", "countryCode", "lat", "lng", "tags", "costs",
                       "transportMode", "transportFrom", "transportTo", "travelScene", "test", "translations"]) {
      if (entry.data[key] !== undefined && entry.data[key] !== null) body[key] = entry.data[key];
    }
    // `weather` never lives in the file — it is an instruction to the
    // server, not content, which is exactly what `never-in-file` means in
    // <site>/content-model.json — so it is not in the key list above. `--weather`
    // supplies it here instead, and only for a day the archive can actually
    // answer: no lat/lng, no request, never a guess standing in for one.
    if (sendWeather && body.lat !== undefined && body.lng !== undefined) body.weather = true;
    // The two answers that are not values. On disk they are their own lines;
    // over the API they are the field itself, which is what makes them
    // findable — a caller stuck on `costs` reads about `costs`.
    //
    //   without:    [costs]  →  "costs": false      there was none
    //   unrecorded: [costs]  →  "costs": "unknown"  there was some and it is gone
    //
    // Sending the wrong one writes a false statement into somebody's journal,
    // so they are mapped separately rather than folded together. B560.
    //
    // B597: `without: false` is not the same promise for every field.
    // openapi.json's `Draft` schema says so in words for two of them —
    // `photos` ("`false`, and only on create — this day has no photographs")
    // and `coordinates` ("`false`, and only on create — this day has no one
    // place to put on a map") — and `DayEdit`'s editable-field list leaves
    // both out entirely, so PATCH refuses either with 400 unsupported_field.
    // `costs` carries no such restriction: its `false` is on both schemas,
    // because a day whose costs were recorded and later found to be none has
    // to be able to say so after the fact — so it still goes straight onto
    // `body` and is sent whichever call this turns out to be.
    //
    // The guard below is on the *field*, not on the answer or on `without` as
    // a whole: only `photos` and `coordinates` are held back, into their own
    // bucket, added to the body only where the day is being created.
    // `unrecorded: → "unknown"` is not documented as create-only at all —
    // PATCH refuses it for these same two fields only because the route's
    // editable list omits them altogether, which is B599, a separate ticket.
    // This set should narrow to nothing once B599 lands and the route
    // accepts `photos`/`coordinates` on an update.
    const CREATE_ONLY_FALSE = new Set(["photos", "coordinates"]);
    const createOnlyFalse = {};
    for (const track of entry.data.without ?? []) {
      if (CREATE_ONLY_FALSE.has(track)) createOnlyFalse[track] = false;
      else body[track] = false;
    }
    for (const track of entry.data.unrecorded ?? []) body[track] = "unknown";

    const recorded = typeof entry.data.slug === "string" ? entry.data.slug : null;
    let existing = null;
    let how = null;
    if (recorded && bySlug.has(recorded) && !claimed.has(recorded)) {
      existing = bySlug.get(recorded);
      if (existing.title !== entry.data.title || existing.date !== date) {
        how = `by its recorded slug "${recorded}" — its title or date on the instance ` +
          `no longer match this file, which is exactly the edit this match is meant to survive`;
      }
    }
    if (!existing) {
      const byTD = byTitleDate.get(`${date}|${entry.data.title}`);
      if (byTD && !claimed.has(byTD.slug)) existing = byTD;
    }
    // A guess, made only when *both* sides agree there is nothing else it
    // could be: one remote day on this date, and — since B647 — exactly one
    // local entry on it too. Two local entries sharing a date make the guess
    // provably ambiguous (which one is "the" day on that date?), so both are
    // left to be created instead, however many remote days share the date.
    let guessed = false;
    if (!existing) {
      const sameDate = (byDate.get(date) ?? []).filter((d) => !claimed.has(d.slug));
      if (sameDate.length === 1 && localByDate.get(date) === 1) {
        existing = sameDate[0];
        guessed = true;
        how = `loosely, by date alone (${date}) — neither its recorded slug nor its title ` +
          `matched, and this was the only day the instance has on that date`;
      }
    }
    let slug = existing?.slug ?? null;
    if (slug) claimed.add(slug);
    if (how) console.log(`  ⚠ matched ${slug} ${how}`);

    const weatherNote = body.weather ? " + ask the archive for the weather" : "";
    if (!slug) {
      note(`  ${step(`write ${entry.file}${weatherNote}`)}`);
      if (dry) slug = entry.slug;
      else {
        const made = await call("POST", `/api/v1/${user}/trips/${trip.id}/days`, {
          body: { ...body, ...createOnlyFalse, idempotency_key: `${trip.id}:${entry.slug}` },
        });
        if (made.ok) {
          slug = made.body.slug;
          claimed.add(slug);
          note(`      → ${slug}`);
        } else if (made.status === 409 && made.body?.error === "idempotency_key_reused") {
          // Not really a refusal — a caller reading "idempotency_key_reused"
          // has no reason to think of a day at all, and the actual cause here
          // is almost always this file's title having changed since the day
          // was first written: the matches above missed it (no recorded slug
          // yet, and more than one day shares its date), so it looked new,
          // and its idempotency key is the one its *old* title produced.
          // B578. The server's own refusal names the slug that key already
          // belongs to, so the day is not lost — update it there instead of
          // failing the whole run over what is really a match this script
          // could not make on its own.
          const recovered = String(made.body?.message ?? "").match(/created "([^"]+)"/)?.[1];
          if (!recovered) {
            refuse(made,
              `POST …/days (${entry.file}) — this day already exists under a different title, ` +
              "but its slug could not be read out of the refusal, so nothing more could be done.");
          }
          console.log(
            `  ⚠ this is not a new day: the instance already holds it as "${recovered}", under a title ` +
            "this file no longer carries. Updating it there instead of writing a second day.",
          );
          note(`  ${step(`update ${recovered}`)}`);
          const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/days/${recovered}`, { body });
          if (!patched.ok) refuse(patched, `PATCH …/days/${recovered}`);
          slug = recovered;
          claimed.add(slug);
        } else {
          refuse(made, `POST …/days (${entry.file})`);
        }
      }
    } else {
      note(`  ${step(`update ${slug}${weatherNote}`)}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/days/${slug}`, { body });
        if (!patched.ok) refuse(patched, `PATCH …/days/${slug}`);
      }
    }
    // Never record a slug this run only guessed at — writing it back turns
    // one wrong match into a permanent one, repeated on every future run.
    if (!dry && slug && !guessed) recordSlug(entry, slug);

    // ── the photographs ────────────────────────────────────────────────────
    // The instance's own gallery is the record of what has been sent, so a
    // second run uploads nothing rather than duplicating everything. No local
    // state file to go stale.
    //
    // A dry run asks this too, unless told not to: it is the same call the
    // real run is about to make (the day either already existed, or `slug`
    // just came back from creating it above), and skipping it is how a dry
    // run once reported "would send 75 files" for a day that already held 60
    // of them — every gallery item counted as pending because nobody had
    // asked. `--offline` keeps the old no-network behaviour, and says so.
    const there = offline ? { ok: false } : await call("GET", `/api/v1/${user}/trips/${trip.id}/days/${slug}`);

    // B597: a `photos`/`coordinates` `false` held back from an update (above)
    // is not silently re-sendable, so a file edited to add `without: [photos]`
    // after the day was first created — one that never got `photos: false` at
    // the time — cannot be corrected by this run. That is not nothing: say it,
    // the same way B572 flags a trip field with no door of its own, rather
    // than let the instance quietly keep disagreeing with the file.
    if (there.ok) {
      const remoteWithout = new Set(there.body?.without ?? []);
      const remoteUnrecorded = new Set(there.body?.unrecorded ?? []);
      const disagreeing = [...CREATE_ONLY_FALSE]
        .filter((track) => (entry.data.without ?? []).includes(track))
        .filter((track) => !remoteWithout.has(track) && !remoteUnrecorded.has(track));
      if (disagreeing.length) {
        console.log(
          `  ⚠ ${slug}: this file's without: names ${disagreeing.join(", ")}, but the instance was ` +
          `not told that at creation and there is no call left that can set ${disagreeing.length === 1 ? "it" : "them"} now ` +
          "(false is create-only for these fields, per openapi.json). Fix it on the instance by hand for now.",
        );
      }
    }
    const gallery = (there.ok ? (there.body?.entry?.gallery ?? there.body?.gallery) : null) ?? [];
    const already_uploaded = new Set(gallery.map((item) => basename(String(item.src ?? ""))));
    const pending = (entry.data.gallery ?? [])
      .map((item) => ({ item, file: galleryFile(journal, trip, item.src) }))
      .filter(({ item, file }) => file && !already_uploaded.has(basename(file)) && !String(item.src).startsWith("http"));

    if (pending.length) {
      // The instance's own whole-request ceiling, from /api/health, with a
      // little room left: this is the limit a batch of phone originals meets
      // first, and it was a guess in this file until the server published it.
      const LIMIT = Math.floor((LIMITS.requestMaxBytes ?? 64 * 1024 * 1024) * 0.6);
      let batch = [], size = 0;
      const batches = [];
      for (const one of pending) {
        const bytes = statSync(one.file).size;
        if (batch.length && size + bytes > LIMIT) { batches.push(batch); batch = []; size = 0; }
        batch.push(one); size += bytes;
      }
      if (batch.length) batches.push(batch);

      note(`  ${step(`send ${pending.length} file${pending.length === 1 ? "" : "s"} for ${slug}`)}` +
           (batches.length > 1 ? ` in ${batches.length} batches` : "") +
           (offline ? " (offline — not checked against the site, so this may be too high)" : ""));
      if (!dry) {
        for (const group of batches) {
          const form = new FormData();
          form.set("day", slug);
          for (const { item, file } of group) {
            form.append("files", new Blob([readFileSync(file)]), basename(file));
            form.append("captions", item.caption ?? "");
          }
          const sent = await call("POST", `/api/v1/${user}/trips/${trip.id}/media`, { body: form });
          if (!sent.ok) refuse(sent, `POST …/media (${slug})`);
        }
      }
    }

    // ── on the site ────────────────────────────────────────────────────────
    if (!draftsOnly) {
      note(`  ${step(`publish ${slug}`)}`);
      if (!dry) {
        const live = await call("POST", `/api/v1/${user}/trips/${trip.id}/days/${slug}/publish`);
        // Already published is not a failure — this run is meant to be repeatable.
        if (!live.ok && live.status !== 409) refuse(live, `POST …/days/${slug}/publish`);
      }
    }
  }
}

console.log(
  `\n${dry ? "Dry run — nothing was sent." : `Done. ${did.length} steps.`}` +
  (draftsOnly ? "\nThe days are drafts. Publish them with a run without --drafts." : "") +
  `\n${SITE}/${user}`,
);
