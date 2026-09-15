#!/usr/bin/env node
// A date range is not a trip. Two people in one household can be a thousand
// kilometres apart on the same day, and a relative's photographs of somewhere
// else land in the library under the same dates — so a selection made by date
// alone arrives with a Hungarian village inside an Italian weekend.
//
// This narrows what query.mjs found to what actually belongs to the trip:
//
//   1. Where were THIS TRIP'S people that day? Every place their own cameras
//      stood — not an average of them, and not the household's, because a
//      household is not one unit: while one of them was in Piedmont the other
//      was in Hungary, and letting her position anchor his trip pulls two
//      hundred photographs of a Hungarian village into an Italian weekend.
//   2. Keep a photograph taken within --km of that, whoever took it — a
//      friend's pictures of the same afternoon belong in the same day.
//   3. A photograph with no coordinates at all cannot be placed, so it is kept
//      only if a household camera took it. That leaves out the thousands of
//      sent and downloaded images a phone accumulates.
//   4. Then cap the day, favourites first, exactly as query.mjs's --top does.
//
//   node narrow.mjs --trip piemont-2025 --who severin [--km 100] [--top 15]
//                   [--home 47.05,8.31] [--home-km 5] [--keep-home]
//
// --who names the people whose cameras anchor this trip, comma-separated,
// matching the keys in export/household.json (or --people <file>). Omitted, every household member
// anchors it, which is right for a trip they took together and wrong for one
// they did not.
//
// Rewrites photos.json and uuids.txt in place, keeping the untouched original
// alongside as photos.all.json, so this can be re-run or reasoned about later.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, argv, arg, has, die } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const trip = arg("trip") ?? die("--trip <name> is required.");
const DIR = join(ROOT, "export", trip);
const file = join(DIR, "photos.json"), all = join(DIR, "photos.all.json");
if (!existsSync(file)) die(`No selection yet. Run query.mjs --trip ${trip} … first.`);

// `--people` names the file, as it does in find-trips/discover.mjs — one
// shape, one flag, and a test can hand over a fixture instead of the
// household's own.
const peopleFile = arg("people") ?? join(ROOT, "export", "household.json");
const household = JSON.parse(readFileSync(peopleFile, "utf8"));
const KM = Number(arg("km") ?? household.radiusKm ?? 100);
const TOP = Number(arg("top") ?? household.perDay ?? 15);

// What the file about to be overwritten said — B1770 needs to know whether a
// blur is being undone, and it can only be read before the write.
const previous = JSON.parse(readFileSync(file, "utf8"));

// Re-running must narrow the original selection, never a narrowed one.
if (!existsSync(all)) copyFileSync(file, all);
const data = JSON.parse(readFileSync(all, "utf8"));
const photos = data.photos;
if (!photos.length) die("Nothing in the selection to narrow.");

const WHO = (arg("who") ?? Object.keys(household.people).join(",")).split(",").map((w) => w.trim());
for (const w of WHO) if (!household.people[w]) die(`--who ${w} is not in ${peopleFile}`);
const rules = Object.entries(household.people).flatMap(([who, ds]) => ds.map((d) => ({ who, ...d })));
const ownerOf = (p) => rules.find((d) =>
  p.model === d.model && (!d.from || p.day >= d.from) && (!d.to || p.day < d.to))?.who ?? null;

const R = 6371, rad = (d) => (d * Math.PI) / 180;
const distKm = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Where the household was, day by day — as every place it stood, not one
// average of them. The average was the first thing tried and it is wrong on
// exactly the days that matter: on 31 December 2022 the household's own
// photographs are Baden at 08:10 and Gyál at 23:40, and the midpoint of those
// is the Baltic Sea. Every real photograph was then more than 100 km from the
// "anchor" and the whole day was thrown away. A day is a journey, not a point.
const anchors = {};
for (const p of photos) {
  if (!WHO.includes(ownerOf(p)) || p.lat == null || p.lng == null) continue;
  (anchors[p.day] ??= []).push({ lat: p.lat, lng: p.lng });
}
const nearAny = (day, p) => anchors[day].some((a) => distKm(a, p) <= KM);

/**
 * Home, on the first and last day — B1771.
 *
 * A trip's first and last day contain the journey, so one of the places its
 * people stood that day is their own address, and every photograph taken
 * there passes a filter that asks only "were you near yourself". That is how
 * a Swiss identity card, front and back with the MRZ readable, photographed
 * at home at 14:50, ended up inside a spa weekend in another country.
 *
 * The radius is a knob rather than a constant: "at home" is a different
 * distance in a village and on a city block. `--keep-home` is the way to say
 * the departure morning's photographs at the kitchen table really do belong.
 */
const homes = [
  ...argv.flatMap((a, i) => (a === "--home" ? [argv[i + 1]] : [])).map((v) => {
    const [lat, lng] = String(v ?? "").split(/[,;\s]+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) die(`--home is not a "lat,lng" pair: ${v}`);
    return { lat, lng };
  }),
  ...(household.homes ?? []).map((h) => ({ lat: Number(h.lat), lng: Number(h.lng), km: h.km })),
];
const HOME_KM = Number(arg("home-km") ?? household.homeKm ?? 5);

const reasons = { kept: 0, elsewhere: 0, unplaceable: 0, noAnchor: 0, atHome: 0 };
const kept = photos.filter((p) => {
  if (p.lat != null && p.lng != null) {
    if (!anchors[p.day]) { reasons.noAnchor++; return !!ownerOf(p) }   // nothing to judge against
    if (nearAny(p.day, p)) { reasons.kept++; return true }
    reasons.elsewhere++; return false;
  }
  if (ownerOf(p)) { reasons.kept++; return true }
  reasons.unplaceable++; return false;
});

// The first and last day of what is left — the journey out and the journey
// home. Only those two: a photograph at home in the middle of a trip is
// somebody else's, and the place filter has already dealt with it.
const tripDays = [...new Set(kept.map((p) => p.day))].sort();
const edges = new Set([tripDays[0], tripDays[tripDays.length - 1]].filter(Boolean));
const atHome = (p) => p.lat != null && p.lng != null
  && homes.some((h) => distKm(h, p) <= (h.km ?? HOME_KM));
const homeHits = kept.filter((p) => edges.has(p.day) && atHome(p));
const afterHome = homes.length && !has("keep-home")
  ? kept.filter((p) => !(edges.has(p.day) && atHome(p)))
  : kept;
reasons.atHome = kept.length - afterHome.length;

// The cap, applied after narrowing and not before: taking the best fifteen of
// a day and then throwing most of them away for being in another country is
// how a day ends up with two photographs.
const byDay = {};
for (const p of afterHome) (byDay[p.day] ??= []).push(p);
const capped = Object.values(byDay).flatMap((day) => {
  const fav = day.filter((p) => p.fav);
  const rest = day.filter((p) => !p.fav).sort((a, b) => b.score - a.score);
  return [...fav, ...rest.slice(0, Math.max(0, TOP - fav.length))];
}).sort((a, b) => a.taken.localeCompare(b.taken));

const gb = capped.reduce((n, p) => n + (p.bytes || 0), 0) / 1e9;
console.log(`${trip} [${WHO.join(", ")}]: ${photos.length} in range → ${kept.length} belong here → ${capped.length} after ${TOP}/day`);
console.log(`  dropped: ${reasons.elsewhere} somewhere else that day, ` +
  `${reasons.unplaceable} with no location and no household camera`);
if (reasons.noAnchor) console.log(`  ${reasons.noAnchor} on days the household photographed nothing — kept only ours`);
if (!homes.length) {
  console.log(`  ! no home position known, so the first and last day were not checked for photographs taken at home.`);
  console.log(`    Give one: --home 47.05,8.31 (repeatable), or "homes": [{"lat":…,"lng":…}] in household.json.`);
} else if (homeHits.length) {
  const where = [...new Set(homeHits.map((p) => p.day))].sort().join(" and ");
  console.log(has("keep-home")
    ? `  ! ${homeHits.length} photograph(s) on ${where} were taken within ${HOME_KM} km of home and are KEPT (--keep-home)`
    : `  ${homeHits.length} photograph(s) on ${where} were taken within ${HOME_KM} km of home — left out of the trip`);
}
const days = Object.keys(byDay).sort();
console.log(`  ${days.length} days, ${gb.toFixed(2)} GB`);

if (has("dry-run")) { console.log("\n--dry-run: nothing written."); process.exit(0) }

writeFileSync(file, JSON.stringify({ ...data, narrowed: { km: KM, top: TOP }, photos: capped }, null, 2));
writeFileSync(join(DIR, "uuids.txt"), capped.map((p) => p.uuid).join("\n") + "\n");

// B1770: this rebuilds photos.json from photos.all.json, which still holds the
// true coordinates — so re-running it after a blur silently republished the
// coordinates of the house somebody slept in. The order was written in a
// comment at the top of blur.mjs and nowhere anybody would see it. Re-apply it
// instead of asking: the zone file is still on disk and the step is not
// optional.
if (previous?.blurred?.length) {
  console.log(`\nre-applying the blur this would otherwise have undone (${previous.blurred.join(", ")})`);
  execFileSync(process.execPath, [join(HERE, "blur.mjs"), "--trip", trip,
    ...(previous.blurZones ? ["--zones", previous.blurZones] : [])], { stdio: "inherit" });
}
console.log(`\nNext:  node export.mjs --trip ${trip}`);
