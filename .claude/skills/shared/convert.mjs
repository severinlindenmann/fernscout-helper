#!/usr/bin/env node
// A folder written by the old tools, converted once into the shape the
// instance actually stores — B1715.
//
//   node .claude/skills/shared/convert.mjs <user> [--from <dir>] [--into <dir>] [--force]
//
// v1's folder was Markdown with frontmatter and three files per trip; v2's is
// JSON, one document per trip, and every optional section either answered or
// named in `declined` with a reason. These are not the same folder with
// different syntax, and four of the differences are content rather than shape
// — which is why this is a conversion a person reads the report of, not a
// reader kept alive inside the tools forever:
//
// 1. **`without:` and `unrecorded:` meant different things.** `without:
//    [costs]` was "nothing was spent"; `unrecorded: [costs]` was "money was
//    spent and nobody wrote down what". The first is an answer in v2,
//    `costs: []`; only the second declines. A port that maps them to one
//    thing destroys a fact the owner recorded deliberately (B560).
// 2. **A trip's costs changed meaning.** In v2 `costs.items` is *preparation*
//    — money spent before leaving — and everything spent on the trip belongs
//    to its days. One real folder's `costs.md` was line-for-line the same
//    spend its own days already carried; sending both reports the trip at
//    double. This never decides: it compares, and says what it found.
// 3. **The exchange-rate convention flipped**, silently — v1 was units per 1
//    unit of the journal's base currency, v2 is units per 1 EUR. An old
//    number cannot be converted without inventing one, so only the currency
//    NAMES are carried over and the server rates them from the ECB.
// 4. **A reading the server itself looked up cannot be re-sent.**
//    `weatherData` sourced `open-meteo` is the server's own, and a caller may
//    never claim that source; the day asks for the lookup again instead
//    (`weather: true`) and the instance answers it in the write.
//
// Nothing is overwritten: the converted journal is written beside the old one
// as `<user>-v2` (or wherever `--into` says), so the original folder is still
// there to compare against and to fall back to.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { FALLBACK_RESERVED_SOURCES } from "./api.mjs";
import { join, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter.mjs";
import { CONTENT } from "./journal.mjs";
import { arg, argv, has } from "./lib.mjs";

const notes = [];
const warnings = [];
const note = (line) => notes.push(line);
const warn = (line) => warnings.push(line);

/** The instance's own name for a stored file: SHA-256, hex, cut to 32. Not
 * md5, which is the obvious wrong guess from the length — `syncManifest.mjs`
 * carries the same function and was verified byte-for-byte against three real
 * files pulled back out of the instance. */
export function contentHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);
}

/** v1 wrote one sentence per declined section; v2 wants a reason of ten
 * characters or more, and these are the two the hand migration used. They are
 * kept apart deliberately — see the header.
 *
 * `costs` is deliberately NOT in `WITHOUT`: "nothing was spent" is an
 * *answer* in v2, `costs: []`, not a decline (B560, and upstream's own
 * `scripts/example-to-v2.mts`). Only `unrecorded` — money spent, figures
 * gone — declines costs. `lib/entries.ts` reads every decline on a
 * trackable field as `unrecorded`, so writing "nothing spent" as a decline
 * would turn a zero-spend day into a lost-figures day on the site. */
export const WITHOUT = {
  coordinates: "no position was recorded for this day",
  photos: "no photographs were taken on this day",
  media: "no photographs were taken on this day",
};
export const UNRECORDED = {
  costs: "money was spent but nobody recorded what it went on",
  coordinates: "a position was not written down for this day",
  photos: "photographs were taken but none were kept",
  media: "photographs were taken but none were kept",
};

/** v1's `photos` is v2's `media`; everything else keeps its name. */
const RENAMED_DECLINE = { photos: "media" };

function declineFrom(list, table, into, why) {
  for (const field of Array.isArray(list) ? list : []) {
    const name = RENAMED_DECLINE[field] ?? field;
    into[name] = table[field] ?? why;
  }
}

/** A day's own slug in v2 IS its filename: `2026-08-26-hoi-an`. */
function daySlugOf(file) {
  return basename(file, extname(file));
}

/**
 * One day, converted.
 *
 * Every key v1 had is either carried, translated, or reported — nothing is
 * dropped in silence, because a key that vanishes without a line in the report
 * is exactly how a migration loses something the owner wrote on purpose.
 */
function convertDay(file, raw, tripId, where) {
  const { data, body } = parseFrontmatter(raw);
  const slug = daySlugOf(file);
  const bareSlug = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const day = {
    slug,
    title: data.title,
    date: data.date,
    content: (body ?? "").trim(),
    status: "draft",
  };

  const declined = {};
  const carry = (key, to = key) => { if (data[key] !== undefined) day[to] = data[key]; };
  for (const key of ["time", "timezone", "location", "country", "countryCode",
    "transportMode", "transportFrom", "transportTo", "tags", "translations",
    "visibility", "travelScene", "test"]) carry(key);

  // Translations: v2 wants title AND content in every block (strict). A
  // missing half is never filled in here — a translated title is somebody's
  // words, and so is a translated paragraph. A block with only a title is
  // dropped (the title is quoted in the report, so nothing is lost); a block
  // with prose and no title is kept, because dropping prose is worse than a
  // refusal that names the one field somebody has to add.
  if (day.translations && typeof day.translations === "object") {
    const kept = {};
    for (const [locale, block] of Object.entries(day.translations)) {
      const hasTitle = typeof block?.title === "string" && block.title.trim() !== "";
      const hasContent = typeof block?.content === "string" && block.content.trim() !== "";
      if (hasTitle && !hasContent) {
        warn(`${tripId}/${slug}: translations.${locale} had a title and no content — v2 needs both, so it was dropped. The title was: ${JSON.stringify(block.title)}`);
        continue;
      }
      if (!hasTitle && hasContent) {
        warn(`${tripId}/${slug}: translations.${locale} has content and no title — kept, and the instance will refuse the day until somebody writes that title (it is never copied from the main one)`);
      }
      if (!hasTitle && !hasContent) {
        warn(`${tripId}/${slug}: translations.${locale} was empty — dropped`);
        continue;
      }
      kept[locale] = block;
    }
    if (Object.keys(kept).length) day.translations = kept;
    else delete day.translations;
  }

  if (data.lat !== undefined && data.lng !== undefined) {
    day.coordinates = { lat: data.lat, lng: data.lng };
  } else if (data.lat !== undefined || data.lng !== undefined) {
    warn(`${tripId}/${slug}: only one of lat/lng — a position is both or neither, so neither was written`);
  }

  // The gallery becomes `media`, and its src moves with the folder rename
  // below: v1 kept a day's photographs under the bare slug, v2 under the
  // whole day slug. `width`/`height`/`type` are the server's own, derived
  // from the bytes at upload — they are not sent and are not kept here.
  if (Array.isArray(data.gallery) && data.gallery.length) {
    const media = [];
    for (const item of data.gallery) {
      const src = moveMedia({ src: item.src, tripId, bareSlug, daySlug: slug, ...where });
      if (src) where.srcMap?.set(item.src, src);
      if (!src) {
        warn(`${tripId}/${slug}: ${item.src} is in the gallery and not on disk — the day was written without it`);
        continue;
      }
      const out = { src };
      if (item.caption) out.caption = item.caption;
      if (item.visibility) out.visibility = item.visibility;
      media.push(out);
    }
    if (media.length) day.media = media;
  }

  // Weather: the server's own reading cannot be re-sent, so the day asks for
  // the lookup again. Anybody else's reading travels whole. Which names are
  // the server's own is not typed here — a converter has no instance to ask,
  // so it uses the one fallback copy in `api.mjs` (B1782).
  if (data.weatherData && typeof data.weatherData === "object") {
    const source = String(data.weatherData.source ?? "").toLowerCase();
    if (FALLBACK_RESERVED_SOURCES.some((name) => name.toLowerCase() === source)) {
      day.weather = true;
      note(`${tripId}/${slug}: the archive's own reading cannot be re-sent — the day asks for it again (weather: true)`);
    } else {
      day.weather = data.weatherData;
    }
  } else if (data.weather === true) {
    day.weather = true;
  }

  // Costs, three answers kept apart (B560): a list is what was spent; "nothing
  // was spent" (`costs: false`, `without: [costs]`) is the answer `[]`; and
  // "money was spent and the figures are gone" (`costs: "unknown"`,
  // `unrecorded: [costs]`) is the only one that declines.
  const without = (Array.isArray(data.without) ? data.without : []).filter((f) => f !== "costs");
  const nothingSpent = data.costs === false || (Array.isArray(data.without) && data.without.includes("costs"));
  const figuresLost = data.costs === "unknown" || (Array.isArray(data.unrecorded) && data.unrecorded.includes("costs"));
  if (Array.isArray(data.costs)) {
    day.costs = data.costs;
    if (nothingSpent || figuresLost) {
      warn(`${tripId}/${slug}: carries ${data.costs.length} cost item(s) AND says ${figuresLost ? "the figures are lost" : "nothing was spent"} — kept the items and dropped the other claim; check which is true`);
    }
  } else if (figuresLost) {
    declined.costs = UNRECORDED.costs;
  } else if (nothingSpent) {
    day.costs = [];
    note(`${tripId}/${slug}: "nothing was spent" became costs: [] — an answer in v2, not a decline`);
  } else if (data.costs !== undefined) {
    warn(`${tripId}/${slug}: costs: ${JSON.stringify(data.costs)} is not a list, false or "unknown" — nothing was carried for it`);
  }

  declineFrom(without, WITHOUT, declined, "this day has none of it");
  declineFrom((Array.isArray(data.unrecorded) ? data.unrecorded : []).filter((f) => f !== "costs"),
    UNRECORDED, declined, "nobody wrote this down");
  if (data.coordinates === false) declined.coordinates = WITHOUT.coordinates;
  if (data.photos === false) declined.media = WITHOUT.media;
  if (Object.keys(declined).length) day.declined = declined;

  for (const key of ["cover", "slug", "gallery", "lat", "lng", "weatherData", "weather",
    "without", "unrecorded", "photos", "status", "costs", "coordinates"]) delete data[key];
  const leftover = Object.keys(data).filter((k) => day[k] === undefined);
  if (leftover.length) warn(`${tripId}/${slug}: carried nothing for ${leftover.join(", ")} — no v2 field of that name`);

  return day;
}

/**
 * One photograph, moved to where and what the instance calls it.
 *
 * Two renames at once, and they have to happen together or the day's `media`
 * and the file on disk disagree:
 *
 * - **the folder**: v1 filed a day's photographs under the bare slug
 *   (`media/arrival/`), v2 under the whole day slug
 *   (`media/2026-12-20-arrival/`).
 * - **the name**: the instance stores a file by its content hash
 *   (`8b0cb97a….jpg`), and the master under `originals/` takes the *same*
 *   name as its derivative, so the pair can be found from either side.
 *
 * **The master is looked up by `src`, not by `from`.** In folders these tools
 * wrote, a gallery entry's `from:` is the original camera filename and its
 * `src:` basename is the published number, and the two diverge wherever a
 * photograph was dropped during review. Files under `originals/` are named by
 * `src`. Keying this off `from` silently misses files — it did, on two
 * photographs, until somebody compared the mapping against the disk.
 *
 * Returns the new `src`, or null when the file named is not on disk — which
 * is a real fault worth reporting rather than a path to invent.
 */
function moveMedia({ src, sourceTripDir, targetTripDir, tripId, bareSlug, daySlug }) {
  if (typeof src !== "string") return null;
  const name = src.split("/").pop();
  const from = join(sourceTripDir, "media", bareSlug, name);
  if (!existsSync(from)) return null;

  const stored = `${contentHash(from)}${extname(name)}`;
  copyMedia(from, join(targetTripDir, "media", daySlug), stored);

  const master = join(sourceTripDir, "originals", bareSlug, name);
  if (existsSync(master)) copyMedia(master, join(targetTripDir, "originals", daySlug), stored);

  return `/media/${tripId}/${daySlug}/${stored}`;
}

/** The whole spend a trip's days carry, for the comparison in `convertTrip`. */
function daySpend(days) {
  return days.flatMap((d) => (Array.isArray(d.costs) ? d.costs : []).map((c) => ({ ...c, date: d.date })));
}

function sum(items) {
  return items.reduce((n, item) => n + (Number(item.amount) || 0), 0);
}

/**
 * The same money, written twice — and how to recognise it.
 *
 * v1's `costs.md` held a trip's whole spend, and its days held their own
 * besides. When a statement import wrote both, the trip's copy carries the
 * date in its label — `"BudapestGO (2026-07-13)"` — where the day carries the
 * bare name on the day of that date. So a naive `label === label` finds
 * nothing and reports a folder as clean: measured on a real journal, it found
 * 0 of 27 duplicates while the two sides summed to exactly the same 923.60.
 *
 * Matched on the three things that are actually the same: the label with that
 * date suffix taken off, the amount to the cent, and — when the label names a
 * date — the day it names.
 */
const LABEL_DATE = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

function costKey(item, date) {
  const label = String(item.label ?? "").replace(LABEL_DATE, "").trim().toLowerCase();
  return `${label}|${(Number(item.amount) || 0).toFixed(2)}|${date ?? ""}`;
}

/** Which of a trip's items the days already carry. */
function alreadyOnADay(items, onDays) {
  const index = new Set();
  for (const c of onDays) {
    index.add(costKey(c, c.date));
    index.add(costKey(c, null));
  }
  return items.filter((item) => {
    const named = LABEL_DATE.exec(String(item.label ?? ""))?.[1] ?? null;
    return index.has(costKey(item, named)) || index.has(costKey(item, null));
  });
}

/** Every v1 trip.md key this converter knows what to do with. Anything else is
 * reported rather than dropped in silence. */
const KNOWN_TRIP_KEYS = new Set(["id", "title", "start", "end", "visibility", "people", "teaser",
  "listed", "accent", "cover", "tagline", "translations", "test", "reminder", "reminderChannel",
  "rates", "tracks", "travellers", "status", "costsVisibility"]);

/** v2's reminder channels (`REMINDER_CHANNELS`, lib/tripWrite.ts upstream). */
const REMINDER_CHANNELS = ["mail", "whatsapp"];

/** What a figure document may carry besides its id and `person`
 * (schemas/figures.ts, strict) — the same list upstream's own migrator uses. */
export const FIGURE_KEYS = ["name", "hairStyle", "outfit", "build", "age", "skin", "hair", "eyes",
  "shirt", "pants", "pack", "headscarf", "accessories"];

function convertTrip(dir, id, days) {
  const tripRead = existsSync(join(dir, "trip.md")) ? parseFrontmatter(readFileSync(join(dir, "trip.md"), "utf8")) : null;
  if (!tripRead) return null;
  const data = tripRead.data;
  const trip = { id, title: data.title };
  const declined = {};

  if (data.start && data.end) trip.dates = { from: data.start, to: data.end };
  else warn(`${id}: no start/end — v2 requires dates.from and dates.to, and this one has none to carry`);

  for (const key of ["visibility", "people", "teaser", "listed", "accent", "cover",
    "tagline", "translations", "test"]) {
    if (data[key] !== undefined) trip[key] = data[key];
  }
  const intro = (tripRead.body ?? "").trim();
  if (intro) trip.intro = intro;

  // Reminder: v1's two scalars, `reminder: true` + `reminderChannel:`, are
  // one field in v2 — `reminder: {channel}`, where presence is the switch
  // (schemas/trip.ts, D18). A `true` with no channel beside it cannot be
  // carried: which channel somebody wanted nudging on is theirs to say.
  if (data.reminder === true) {
    if (REMINDER_CHANNELS.includes(data.reminderChannel)) {
      trip.reminder = { channel: data.reminderChannel };
    } else {
      warn(`${id}: reminder: true with ${data.reminderChannel === undefined ? "no reminderChannel" : `reminderChannel ${JSON.stringify(data.reminderChannel)}`} — v2 needs one of ${REMINDER_CHANNELS.join(", ")}, so the reminder is off until somebody picks one`);
    }
  } else if (data.reminderChannel !== undefined) {
    note(`${id}: dropped reminderChannel ${JSON.stringify(data.reminderChannel)} — the reminder itself was not on`);
  }

  // Rates: the names travel, the numbers do not. v1's number was units per 1
  // unit of the journal's base currency and v2's is units per 1 EUR — and
  // converting one into the other needs a rate nobody has, so the server is
  // asked to rate them from the ECB instead.
  if (data.rates && typeof data.rates === "object") {
    const currencies = Object.keys(data.rates).map((c) => c.toUpperCase());
    if (currencies.length) {
      trip.rates = { currencies };
      note(`${id}: kept the currencies ${currencies.join(", ")} and dropped the old numbers — v1 rated against the journal's base currency, v2 rates against the euro, and the server rates these from the ECB`);
    }
  }

  // costs.md and plan.md become sections of the one document. `costsVisibility`
  // lives inside the section now (`costs.visibility`) — and it is carried
  // even without a costs.md, because dropping it quietly publishes the money
  // of a trip whose owner said only guests may see it.
  const costs = {};
  if (data.costsVisibility !== undefined) costs.visibility = data.costsVisibility;
  const costsFile = join(dir, "costs.md");
  let items = [];
  if (existsSync(costsFile)) {
    const { data: costsData, body: costsBody } = parseFrontmatter(readFileSync(costsFile, "utf8"));
    if (costsData.budget) costs.budget = costsData.budget;
    if (Array.isArray(costsData.costs)) items = costsData.costs;
    const prose = (costsBody ?? "").trim();
    if (prose) costs.note = prose;
  }

  // B-7 — the one that loses money silently, and the reason this is
  // measured rather than assumed.
  //
  // In v2 a trip's `costs.items` is PREPARATION — what was paid before
  // leaving — and everything spent on the trip belongs to the day it was
  // spent on. v1 had no such split: one real folder's `costs.md` was
  // line-for-line the same 27 items its own days already carried, both
  // sides summing to exactly CHF 923.60 against a CHF 1000 budget, and
  // writing both publishes the trip at 1847.20 with no error anywhere.
  //
  // So an item the days already carry is **dropped from the trip**, and the
  // run says so. Nothing is lost by that: it is the same money, still on the
  // day it was spent, and the day is where v2 keeps it. What is kept is
  // every item that appears on no day — the flights, the hotels, the hire
  // car — which is exactly what preparation means.
  const onDays = daySpend(days);
  const duplicated = alreadyOnADay(items, onDays);
  const kept = items.filter((item) => !duplicated.includes(item));
  if (kept.length) costs.items = kept;
  if (duplicated.length) {
    warn(
      `${id}: ${duplicated.length} of ${items.length} items in costs.md are the same money the days ` +
      `already carry (${sum(duplicated).toFixed(2)}) — dropped from the trip, which in v2 holds ` +
      `preparation only. The days keep every one of them, so the trip now totals ` +
      `${(sum(kept) + sum(onDays)).toFixed(2)} rather than ${(sum(items) + sum(onDays)).toFixed(2)}. ` +
      (kept.length
        ? `${kept.length} item(s) appear on no day and were kept as preparation.`
        : `Nothing was left on the trip but its budget.`),
    );
  } else if (items.length && onDays.length) {
    note(`${id}: trip items ${sum(items).toFixed(2)}, day items ${sum(onDays).toFixed(2)}, none of them the same line twice — preparation plus on-trip spend, which is the ordinary shape`);
  }
  if (Object.keys(costs).length) trip.costs = costs;

  // `tracks:` is retired (schemas/trip.ts) — "what this trip keeps track of"
  // is the `declined` map now. Only `costs` has a trip-level decline to go
  // to; coordinates, photographs and weather are asked of each day, and the
  // trip's `declined` map refuses them, so they are reported, not written.
  for (const [field, on] of Object.entries(data.tracks ?? {})) {
    if (on !== false) continue;
    if (field === "costs") {
      if (trip.costs) warn(`${id}: tracks.costs is false but the trip carries a costs section — kept the section and wrote no decline; check which is true`);
      else declined.costs = "this trip does not track costs";
    } else {
      warn(`${id}: tracks.${field}: false has no trip-level home in v2 — each day declines ${RENAMED_DECLINE[field] ?? field} on its own, so nothing was written for it`);
    }
  }

  const planFile = join(dir, "plan.md");
  if (existsSync(planFile)) {
    const { data: planData, body: planBody } = parseFrontmatter(readFileSync(planFile, "utf8"));
    // plan.md's prose is `plan.body` in v2 (schemas/trip.ts; upstream's
    // migrator). A frontmatter `note:` from older folders is joined to it
    // rather than dropped, and the run says so.
    const body = [planData.note, (planBody ?? "").trim()]
      .filter((part) => typeof part === "string" && part.trim() !== "")
      .join("\n\n");
    if (planData.note) note(`${id}: plan.md's note: joined to its prose as plan.body — v2 has one body for a plan`);
    if (Array.isArray(planData.route) && planData.route.length) {
      // A v2 stop needs lat/lng. Where a v1 stop names only a place, the stop
      // is KEPT without coordinates — the same as upstream's own migrator,
      // which carries route through untouched — and the instance will refuse
      // the plan until somebody adds them. Never looked up or guessed here:
      // dropping the stop loses the owner's route, and a guessed position is
      // an invented one.
      const plan = { route: planData.route };
      if (body) plan.body = body;
      trip.plan = plan;
      const bare = planData.route.filter((stop) => typeof stop?.lat !== "number" || typeof stop?.lng !== "number");
      if (bare.length) {
        warn(`${id}: ${bare.length} of ${planData.route.length} plan stop(s) have no lat/lng (${bare.map((s) => s?.location ?? "?").join(", ")}) — kept as written; v2 needs coordinates on every stop, so add them before the plan is sent`);
      }
    } else if (body || planData.route !== undefined) {
      warn(`${id}: plan.md has no usable route${planData.route !== undefined ? ` (route: ${JSON.stringify(planData.route)})` : ""} — v2's plan needs at least one stop, so nothing was written for it${body ? `. Its prose was: ${JSON.stringify(body)}` : ""}`);
    }
  }

  // `travellers:` is retired. The figures themselves are a journal-wide
  // library now (`PUT /api/v2/{user}/figures/{id}`, at most ten), so the trip
  // only names which of them it uses — and this is what the caller has to
  // create before the trip is sent.
  if (Array.isArray(data.travellers) && data.travellers.length) {
    trip.figures = { mode: "custom", figures: [...new Set(data.travellers.map(figureId))] };
    note(`${id}: ${data.travellers.length} traveller(s) became figure ids — create each with PUT /api/v2/{user}/figures/{id} before sending the trip`);
  }

  if (data.status) note(`${id}: dropped status: ${data.status} — v2 works it out from the dates`);
  const leftover = Object.keys(data).filter((k) => !KNOWN_TRIP_KEYS.has(k));
  if (leftover.length) warn(`${id}: carried nothing for ${leftover.join(", ")} — no v2 field of that name`);
  if (Object.keys(declined).length) trip.declined = declined;
  return { trip, travellers: data.travellers ?? [] };
}

/** A v1 traveller as a v2 figure document: appearance keys only, and `for`
 * — the address it belonged to — as `person` (schemas/figures.ts is strict,
 * so anything else is reported rather than sent to be refused). */
export function figureFrom(traveller, where) {
  const doc = { id: figureId(traveller) };
  for (const key of FIGURE_KEYS) if (traveller[key] !== undefined) doc[key] = traveller[key];
  if (typeof traveller.for === "string") doc.person = traveller.for;
  const other = Object.keys(traveller).filter((k) => k !== "for" && !FIGURE_KEYS.includes(k));
  if (other.length) warn(`${where}: figure ${doc.id} carried nothing for ${other.join(", ")} — a figure has no field of that name`);
  return doc;
}

/** A figure's id, made from the address it belonged to: stable, lowercase,
 * and recognisable in the library afterwards. */
function figureId(traveller) {
  const base = String(traveller.for ?? traveller.name ?? "figure").split("@")[0];
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy one photograph under the name the instance stores it by. */
function copyMedia(from, toDir, storedName) {
  mkdirSync(toDir, { recursive: true });
  const to = join(toDir, storedName ?? basename(from));
  copyFileSync(from, to);
  return to;
}

/** The keys the instance's journal document knows (schemas/journal.ts,
 * strict). */
const JOURNAL_KEYS = new Set(["title", "owner", "locales", "baseCurrency", "displayCurrencies",
  "units", "visibility", "tagline", "figures", "declined"]);

/**
 * v1 journal settings the strict v2 journal document has no field for, each
 * mapped where v2 has a home and dropped with a line in the report where it
 * does not. A key this converter has never heard of is left in place and
 * reported: it may be a typo of a real one, and the instance naming it is
 * better than this guessing.
 */
function convertConfig(config) {
  if (config.defaultLocale !== undefined) {
    // v2's default language is the first entry of `locales`.
    const locales = Array.isArray(config.locales) ? config.locales.filter((l) => l !== config.defaultLocale) : [];
    const before = JSON.stringify(config.locales);
    config.locales = [config.defaultLocale, ...locales];
    if (before !== JSON.stringify(config.locales)) {
      note(`config.json: defaultLocale ${config.defaultLocale} became the first of locales (${config.locales.join(", ")}) — in v2 the first locale is the default`);
    } else {
      note("config.json: dropped defaultLocale — it was already the first of locales, which is how v2 says it");
    }
    delete config.defaultLocale;
  }
  if (config.startLocation !== undefined) {
    note(`config.json: dropped startLocation ${JSON.stringify(config.startLocation)} — v2 has no field for it (nothing rendered it)`);
    delete config.startLocation;
  }
  if (config.manualRates !== undefined) {
    note(`config.json: dropped manualRates ${JSON.stringify(config.manualRates)} — v2 keeps manual rates per trip (rates.manual) in units per 1 EUR, and a v1 number cannot be converted without a rate nobody has`);
    delete config.manualRates;
  }
  if (config.media !== undefined) {
    note("config.json: dropped media — upload limits are the instance's own (GET /api/v2/status), not the journal's");
    delete config.media;
  }
  const unknown = Object.keys(config).filter((k) => !JOURNAL_KEYS.has(k));
  if (unknown.length) {
    warn(`config.json: ${unknown.join(", ")} — no v2 journal field of that name; left in place, and the instance will refuse it until it is removed or corrected`);
  }
}

export function convertJournal(user, { into, from, force = false } = {}) {
  // `from` is for a caller that knows where the folder is — a test, or a run
  // pointed at somebody's Desktop. `CONTENT` is read once at import, so an
  // env var set after the first import would be ignored and the argument is
  // what makes that impossible to get wrong.
  notes.length = 0;
  warnings.length = 0;
  const source = join(from ?? CONTENT, user);
  const target = into ?? `${source}-v2`;
  if (!existsSync(source)) throw new Error(`No such journal: ${source}`);
  if (existsSync(target) && !force) throw new Error(`${target} already exists — pass --force to write into it anyway`);
  mkdirSync(target, { recursive: true });

  const configPath = join(source, "config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.features) {
      delete config.features;
      note("config.json: dropped features — in v2 a capability is the operator's fact, not the journal's");
    }
    if (config.travellers) {
      delete config.travellers;
      note("config.json: dropped travellers — figures are their own documents now, one per file under figures/");
    }
    convertConfig(config);
    writeJson(join(target, "config.json"), config);
  }

  const tripsDir = join(source, "trips");
  const tripIds = existsSync(tripsDir)
    ? readdirSync(tripsDir).filter((n) => !n.startsWith(".") && statSync(join(tripsDir, n)).isDirectory()).sort()
    : [];

  const figures = new Map();
  for (const id of tripIds) {
    const dir = join(tripsDir, id);
    const entriesDir = join(dir, "entries");
    const files = existsSync(entriesDir) ? readdirSync(entriesDir).filter((f) => f.endsWith(".md")).sort() : [];

    // Every photograph that moves records where it went, so the trip's own
    // `cover` — which names one of them by its old path — moves with it. A
    // cover left pointing at the v1 path is a trip whose picture is a 404,
    // and it is the kind of thing that shows up only when somebody opens the
    // page.
    const srcMap = new Map();
    const where = { sourceTripDir: dir, targetTripDir: join(target, "trips", id), srcMap };
    const days = files.map((file) => convertDay(file, readFileSync(join(entriesDir, file), "utf8"), id, where));
    for (const day of days) writeJson(join(target, "trips", id, "entries", `${day.slug}.json`), stripSlug(day));

    const converted = convertTrip(dir, id, days);
    if (converted) {
      if (converted.trip.cover) {
        const moved = srcMap.get(converted.trip.cover);
        if (moved) converted.trip.cover = moved;
        else warn(`${id}: cover ${converted.trip.cover} names no photograph any day carries — left as it was, and the trip will refuse it`);
      }
      writeJson(join(target, "trips", id, "trip.json"), converted.trip);
      for (const traveller of converted.travellers) {
        const figure = figureFrom(traveller, id);
        const seen = figures.get(figure.id);
        if (!seen) figures.set(figure.id, figure);
        else if (JSON.stringify(seen) !== JSON.stringify(figure)) {
          warn(`${id}: figure ${figure.id} is drawn differently on another trip — the first one was kept; one figure is one look in v2`);
        }
      }
    } else {
      warn(`${id}: no trip.md — nothing to convert for this trip`);
    }

    // Every photograph a day names has moved with it, above. What is left in
    // the old folders is what no day ever pointed at — an orphan folder, or a
    // photograph dropped during review — and it is reported rather than
    // copied: a file nothing refers to is not content, and silently carrying
    // it across would make the mirror disagree with the instance on the first
    // sync.
    for (const dirName of ["media", "originals"]) {
      const root = join(dir, dirName);
      if (!existsSync(root)) continue;
      const known = new Set(days.map((d) => d.slug.replace(/^\d{4}-\d{2}-\d{2}-/, "")));
      for (const folder of readdirSync(root).filter((n) => !n.startsWith("."))) {
        if (!known.has(folder)) warn(`${id}: ${dirName}/${folder}/ belongs to no day — nothing was copied from it`);
      }
    }
  }

  for (const figure of figures.values()) writeJson(join(target, "figures", `${figure.id}.json`), figure);
  if (figures.size > 10) warn(`${figures.size} figures — a journal holds at most ten, so some of these have to go`);

  return { source, target, notes, warnings, trips: tripIds.length, figures: figures.size };
}

/** The slug is the filename, and a second copy of it inside the file is a
 * second address for one fact to drift from the first — the instance's own
 * rule for its day documents. */
function stripSlug(day) {
  const { slug, ...rest } = day;
  return rest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const user = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--into");
  if (!user) {
    console.error("usage: node .claude/skills/shared/convert.mjs <user> [--from <dir>] [--into <dir>] [--force]");
    process.exit(2);
  }
  const result = convertJournal(user, { into: arg("into"), from: arg("from"), force: has("force") });
  console.log(`${result.source}\n  → ${result.target}`);
  console.log(`  ${result.trips} trip(s), ${result.figures} figure(s)\n`);
  for (const line of result.notes) console.log(`  note     ${line}`);
  for (const line of result.warnings) console.log(`  READ ME  ${line}`);
  console.log(
    `\nNothing was changed in ${result.source}. Read the lines above — the ones marked READ ME are ` +
    `decisions only you can make — then point the tools at the converted folder.`,
  );
}
