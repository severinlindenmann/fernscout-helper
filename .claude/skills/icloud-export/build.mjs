#!/usr/bin/env node
// Turn the reviewed photos into a Fernscout content folder: one entry per day,
// a sized gallery, the captions the person wrote. It does NOT write the prose —
// that is the agent's job, from notes.md, and from nothing else.
//
//   node build.mjs --trip algarve-2026 --user severin
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, die, has, stemOf } from "../shared/lib.mjs";
import { ensureBaked, DEFAULT_MAX_EDGE } from "./bake.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const user = arg("user") ?? die("--user <name> is required — the folder your journal lives in.");
const MAX_EDGE = Number(arg("max-edge") ?? DEFAULT_MAX_EDGE);

const DIR = join(ROOT, "export", trip);
const photosDir = join(DIR, "photos");
const review = existsSync(join(DIR, "review.json"))
  ? JSON.parse(readFileSync(join(DIR, "review.json"), "utf8")) : { photos: {}, days: {} };
// B1767: the sheets, and so everything written from them, can predate the
// review that turned photographs off. Nothing can tell which sentence
// described which frame — so this says so rather than guessing, and says it
// where somebody is about to write the prose.
const reviewFile = join(DIR, "review.json"), sheetIndex = join(DIR, "sheets", "index.json");
if (existsSync(sheetIndex) && existsSync(reviewFile)
    && statSync(sheetIndex).mtimeMs < statSync(reviewFile).mtimeMs) {
  const turnedOff = Object.values(review.photos ?? {}).filter((s) => s.drop).length;
  console.log(`  ⚠ the contact sheets were made before the review, which turned ${turnedOff} photograph(s) off.`);
  console.log(`    Anything already written from those sheets may describe a photograph that is no longer here.`);
}

const meta = new Map();
for (const p of JSON.parse(readFileSync(join(DIR, "photos.json"), "utf8")).photos) meta.set(stemOf(p.name), p);

const kept = readdirSync(photosDir)
  .filter((f) => /\.jpe?g$/i.test(f) && !review.photos?.[f]?.drop)
  .map((file) => ({ file, ...(meta.get(stemOf(file)) ?? {}), note: (review.photos?.[file]?.note ?? "").trim() }))
  .filter((p) => p.day)
  .sort((a, b) => a.taken.localeCompare(b.taken));
if (!kept.length) die("Nothing kept. Open the review page and keep at least one photo.");

const slug = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  .replace(/^(.{1,40})(-.*)?$/s, "$1").replace(/-$/, "");   // whole words, up to 40 chars

const byDay = {};
for (const p of kept) (byDay[p.day] ??= []).push(p);

const TRIP = join(ROOT, "content", user, "trips", trip);

// B1768: this used to add rather than replace. `mkdirSync` a folder that is
// already there and write one file per day into it, and a trip rebuilt after
// anything changed the slug scheme keeps both sets — every one of 18 rebuilt
// trips came out with exactly double the entries, old title-slug files beside
// fresh location-slug ones. Each file is individually valid, so a validation
// pass calls it "28 entries, 0 issues" and only a rename collision gives it
// away. `originals/` is never touched: a print master is not a derivative.
const occupied = ["entries", "media"].filter((d) => {
  try { return readdirSync(join(TRIP, d)).length > 0 } catch { return false }
});
if (occupied.length && !has("force")) {
  die(`content/${user}/trips/${trip}/ already holds ${occupied.join(" and ")}.\n` +
      "Building on top of it leaves the old files beside the new ones, and both look valid.\n" +
      "Pass --force to replace them (originals/ is left alone), or build into a different trip name.");
}
for (const d of occupied) rmSync(join(TRIP, d), { recursive: true, force: true });
mkdirSync(join(TRIP, "entries"), { recursive: true });

const notes = [`# ${trip} — what the author said`, "",
  "Everything below is the person's own words. Write the entries from this and",
  "from nothing else: no weather nobody mentioned, no meals nobody ate.", ""];
let written = 0, copied = 0;
const usedSlugs = new Set();


for (const [day, list] of Object.entries(byDay).sort()) {
  const places = list.map((p) => (p.place || "").split(",")[0]).filter(Boolean);
  const place = places.sort((a, b) =>
    places.filter((x) => x === b).length - places.filter((x) => x === a).length)[0] ?? "";
  // B1539: the slug is the day's whole identity — its URL, the name of its
  // media folder, and what the reader matches `media/<slug>/` back to a day
  // by. Slugged from the place alone it is not unique, and a trip that stays
  // put breaks it twice over: ten days on the same island all resolved to
  // `media/phuket-island/` and overwrote one another's photographs, and the
  // instance refuses the second day to claim the slug outright. Number the
  // repeats. The date cannot do this job — it would leave the folder no
  // longer equal to the slug, and every day's pictures belonging to no day.
  const base = slug(place) || "day";
  let daySlug = base, n = 1;
  while (usedSlugs.has(daySlug)) daySlug = `${base}-${++n}`;
  usedSlugs.add(daySlug);
  // The folder is named by the day's WHOLE slug — `2026-08-26-phuket-island`
  // — because that is what the instance calls it, and this folder is a mirror
  // of the instance since B1715. v1 filed them under the bare slug and the two
  // sides then disagreed about every path.
  const fullSlug = `${day}-${daySlug}`;
  const mediaDir = join(TRIP, "media", fullSlug);
  mkdirSync(mediaDir, { recursive: true });

  const gallery = list.map((p, i) => {
    const name = String(i + 1).padStart(2, "0") + ".jpg";
    const dest = join(mediaDir, name);
    // The same derivative `review.mjs` already built (or builds now, if this
    // is run before a review) — resized, turned upright, stripped — so the
    // picture a person approved is the one published. B646.
    copyFileSync(ensureBaked(DIR, photosDir, p.file, MAX_EDGE), dest);
    const dim = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", dest], { encoding: "utf8" });
    const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(dim.match(re)?.[1] ?? 0));
    copied++;
    return { src: `/media/${trip}/${fullSlug}/${name}`, w, h, caption: p.note,
             visibility: review.photos?.[p.file]?.visibility || "" };
  });

  const withGps = list.find((p) => p.lat);
  // The day's `time:` orders it against any other entry on the same date, so
  // it has to be a real moment from the trip — B649: `list[0]` was whichever
  // file sorted first, screenshots included, and a train-timetable screenshot
  // taken at 06:44 while planning once became the whole day's timestamp. A
  // photo with GPS is a photo actually taken on the trip; when none of them
  // have it (a day of screenshots alone, or an export with no --exiftool),
  // fall back to the first file rather than leaving `time:` empty.
  const first = withGps ?? list[0];
  // B650: `place` above is the day's most-common location name; `withGps` is
  // the one photo `lat`/`lng` actually come from. They can name different
  // towns — a whole afternoon's drive apart — and only a person can say which
  // one is right, so this only prints the disagreement rather than picking.
  // B1540: Photos already knows the country — `place` is the whole string,
  // "Zurich Airport, Rümlang, Canton of Zürich, Switzerland", and only its
  // first component was ever read. The last one is the country, except over
  // water, where Photos names the sea instead and there is no country to have.
  // Taking the day's most common answer rather than the first photo's is the
  // same rule `place` above already uses.
  const countries = list.map((p) => (p.place || "").split(",").map((s) => s.trim()).pop())
    .filter((c) => c && !/\b(Sea|Ocean|Bay|Gulf|Strait)\b/.test(c));
  const country = countries.sort((a, b) =>
    countries.filter((x) => x === b).length - countries.filter((x) => x === a).length)[0] ?? "";

  const gpsPlace = (withGps?.place || "").split(",")[0];
  if (gpsPlace && place && gpsPlace !== place) {
    console.log(`  ⚠ ${day}: location: "${place}" but the coordinates come from a photo placed in "${gpsPlace}"`);
  }
  // The day, as the document the instance stores — B1715. `title` and
  // `content` are deliberately empty: they are the two things only the person
  // can supply, and a build that filled them with something plausible would be
  // the one thing this repository never does.
  //
  // Everything this cannot know is DECLINED rather than omitted, because v2
  // asks about every optional section and an omission is a refusal
  // (`422 incomplete`) rather than a blank. Each sentence below says what is
  // actually true of a day built from photographs — not a reason invented to
  // get past the check.
  const declined = {
    costs: "no spending was recorded while these photographs were taken",

    timezone: "no timezone was established for this day",
    transportMode: "no transport leg was recorded for this day",
    tags: "no tags were applied to this day",
    translations: "no translation was written for this day",
    visibility: "this day is as open as the trip it belongs to",
    weather: "no weather reading was taken; ask the server for one by sending weather: true",
  };
  // B1769: `time` was declined unconditionally while `time:` was also set, and
  // the instance refuses a section that is "there and consciously absent at
  // once" — 145 of 196 entries in one run. Nothing local said so: the folder
  // is written happily and the refusal only arrives on the wire.
  if (!first.time) declined.time = "the time of day was not recorded beyond the photographs' own";
  if (!place) declined.location = "no place name came with these photographs";
  if (!country) declined.country = "no country came with these photographs";
  declined.countryCode = "no country code is written here — a wrong flag is worse than no flag";
  if (!withGps) declined.coordinates = "none of these photographs carried a position";
  if (!gallery.length) declined.media = "no photographs were kept for this day";

  const document = {
    title: "",
    date: day,
    content: "",
    ...(first.time ? { time: first.time } : {}),
    ...(place ? { location: place } : {}),
    // The name as Photos gives it, which is the Mac's own language — the
    // journal may be written in another one. No `countryCode`: mapping a name
    // to ISO 3166 is a table this repository would have to keep, and a wrong
    // flag is worse than no flag.
    ...(country ? { country } : {}),
    ...(withGps ? { coordinates: { lat: withGps.lat, lng: withGps.lng } } : {}),
    ...(gallery.length
      ? {
          media: gallery.map((g) => ({
            src: g.src,
            ...(g.caption ? { caption: g.caption } : {}),
            // Only ever written for a picture the person held back on the
            // review page. An absent value is what "everyone the trip lets in"
            // looks like, and the label can only narrow that — never widen it.
            ...(g.visibility ? { visibility: g.visibility } : {}),
          })),
        }
      : {}),
    declined,
    status: "draft",
  };
  // The rule the last one broke, checked once for every field rather than
  // remembered for each: a key cannot be both answered and declined.
  const both = Object.keys(declined).filter((key) => document[key] !== undefined);
  if (both.length) die(`${fullSlug}: ${both.join(", ")} would be both set and declined — that is refused on the wire.`);

  writeFileSync(join(TRIP, "entries", `${fullSlug}.json`), `${JSON.stringify(document, null, 2)}\n`);
  written++;

  notes.push(`## ${day} — ${place || "no place"}  (${list.length} photos)`);
  if (review.days?.[day]?.trim()) notes.push("", "The day, in the author's words:", "",
    "> " + review.days[day].trim().replace(/\n/g, "\n> "), "");
  const withNotes = list.filter((p) => p.note);
  if (withNotes.length) {
    notes.push("Photo notes:");
    for (const p of withNotes) notes.push(`- ${p.time} ${(p.place || "").split(",")[0]}: ${p.note}`);
  }
  if (!review.days?.[day]?.trim() && !withNotes.length)
    notes.push("", "**Nothing was written about this day.** Ask before writing anything.");
  notes.push("");
}

writeFileSync(join(DIR, "notes.md"), notes.join("\n"));
console.log(`${written} entries, ${copied} photos → content/${user}/trips/${trip}/`);
console.log(`The author's words → export/${trip}/notes.md`);
console.log("Every day is a draft, and every title and every paragraph is still empty.");
console.log("Each one declines what a photograph cannot say — read those sentences before publishing.");
