#!/usr/bin/env node
// A folder written by the old tools, converted once into the shape the
// instance actually stores — B1715.
//
//   node .claude/skills/shared/convert.mjs <user> [--into <dir>] [--force]
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
//    spent and nobody wrote down what". Both become `declined`, and a port
//    that maps them to one sentence destroys a fact the owner recorded
//    deliberately. Two sentences, kept apart.
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
 * kept apart deliberately — see the header. */
export const WITHOUT = {
  costs: "nothing was spent on this day",
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
    "visibility", "travelScene", "test", "costs"]) carry(key);

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
  // the lookup again. Anybody else's reading travels whole.
  if (data.weatherData && typeof data.weatherData === "object") {
    const source = String(data.weatherData.source ?? "").toLowerCase();
    if (source === "open-meteo") {
      day.weather = true;
      note(`${tripId}/${slug}: the archive's own reading cannot be re-sent — the day asks for it again (weather: true)`);
    } else {
      day.weather = data.weatherData;
    }
  } else if (data.weather === true) {
    day.weather = true;
  }

  declineFrom(data.without, WITHOUT, declined, "this day has none of it");
  declineFrom(data.unrecorded, UNRECORDED, declined, "nobody wrote this down");
  if (data.coordinates === false) declined.coordinates = WITHOUT.coordinates;
  if (data.photos === false) declined.media = WITHOUT.media;
  if (data.costs === false) { delete day.costs; declined.costs = WITHOUT.costs; }
  if (data.costs === "unknown") { delete day.costs; declined.costs = UNRECORDED.costs; }
  if (Object.keys(declined).length) day.declined = declined;

  for (const key of ["cover", "slug", "gallery", "lat", "lng", "weatherData", "weather",
    "without", "unrecorded", "photos", "status"]) delete data[key];
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
  return days.flatMap((d) => (Array.isArray(d.costs) ? d.costs : []));
}

function sum(items) {
  return items.reduce((n, item) => n + (Number(item.amount) || 0), 0);
}

function convertTrip(dir, id, days) {
  const tripRead = existsSync(join(dir, "trip.md")) ? parseFrontmatter(readFileSync(join(dir, "trip.md"), "utf8")) : null;
  if (!tripRead) return null;
  const data = tripRead.data;
  const trip = { id, title: data.title };
  const declined = {};

  if (data.start && data.end) trip.dates = { from: data.start, to: data.end };
  else warn(`${id}: no start/end — v2 requires dates.from and dates.to, and this one has none to carry`);

  for (const key of ["visibility", "people", "teaser", "listed", "accent", "cover",
    "tagline", "translations", "test", "reminder"]) {
    if (data[key] !== undefined) trip[key] = data[key];
  }
  const intro = (tripRead.body ?? "").trim();
  if (intro) trip.intro = intro;

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

  // `tracks: {costs: false}` was v1's way of saying a trip does not follow
  // something. That is a decline now, and it needs a sentence.
  for (const [field, on] of Object.entries(data.tracks ?? {})) {
    if (on === false) declined[RENAMED_DECLINE[field] ?? field] = `this trip does not track ${field}`;
  }

  // costs.md and plan.md become sections of the one document.
  const costsFile = join(dir, "costs.md");
  if (existsSync(costsFile)) {
    const { data: costsData } = parseFrontmatter(readFileSync(costsFile, "utf8"));
    const costs = {};
    if (costsData.budget) costs.budget = costsData.budget;
    if (Array.isArray(costsData.costs) && costsData.costs.length) costs.items = costsData.costs;
    if (Object.keys(costs).length) trip.costs = costs;

    // B-7, and the reason this is a report rather than a rule. In v2 a trip's
    // items are what was spent BEFORE leaving; everything spent on the trip
    // belongs to its days. Both shapes exist in real folders written by these
    // tools, so the only honest thing to do is measure and say.
    const onDays = daySpend(days);
    const items = costs.items ?? [];
    if (items.length && onDays.length) {
      const same = items.length === onDays.length && Math.abs(sum(items) - sum(onDays)) < 0.01;
      if (same) {
        warn(
          `${id}: costs.md holds ${items.length} items totalling ${sum(items).toFixed(2)}, and the days hold ` +
          `${onDays.length} totalling ${sum(onDays).toFixed(2)} — these look like the same spend written twice. ` +
          `In v2 a trip's items are PREPARATION only, so sending both reports the trip at double. ` +
          `Decide which is true for this trip and delete the other; nothing here guesses.`,
        );
      } else {
        note(`${id}: trip items ${sum(items).toFixed(2)}, day items ${sum(onDays).toFixed(2)} — read as preparation plus on-trip spend, which is the ordinary shape`);
      }
    }
  }

  const planFile = join(dir, "plan.md");
  if (existsSync(planFile)) {
    const { data: planData } = parseFrontmatter(readFileSync(planFile, "utf8"));
    const plan = {};
    if (Array.isArray(planData.route) && planData.route.length) plan.route = planData.route;
    if (planData.note) plan.note = planData.note;
    if (Object.keys(plan).length) trip.plan = plan;
  }

  // `travellers:` is retired. The figures themselves are a journal-wide
  // library now (`PUT /api/v2/{user}/figures/{id}`, at most ten), so the trip
  // only names which of them it uses — and this is what the caller has to
  // create before the trip is sent.
  if (Array.isArray(data.travellers) && data.travellers.length) {
    trip.figures = { mode: "custom", figures: data.travellers.map(figureId) };
    note(`${id}: ${data.travellers.length} traveller(s) became figure ids — create each with PUT /api/v2/{user}/figures/{id} before sending the trip`);
  }

  if (data.status) note(`${id}: dropped status: ${data.status} — v2 works it out from the dates`);
  if (Object.keys(declined).length) trip.declined = declined;
  return { trip, travellers: data.travellers ?? [] };
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

export function convertJournal(user, { into, force = false } = {}) {
  const source = join(CONTENT, user);
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
        const fid = figureId(traveller);
        if (!figures.has(fid)) figures.set(fid, { id: fid, ...traveller });
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
    console.error("usage: node .claude/skills/shared/convert.mjs <user> [--into <dir>] [--force]");
    process.exit(2);
  }
  const result = convertJournal(user, { into: arg("into"), force: has("force") });
  console.log(`${result.source}\n  → ${result.target}`);
  console.log(`  ${result.trips} trip(s), ${result.figures} figure(s)\n`);
  for (const line of result.notes) console.log(`  note     ${line}`);
  for (const line of result.warnings) console.log(`  READ ME  ${line}`);
  console.log(
    `\nNothing was changed in ${result.source}. Read the lines above — the ones marked READ ME are ` +
    `decisions only you can make — then point the tools at the converted folder.`,
  );
}
