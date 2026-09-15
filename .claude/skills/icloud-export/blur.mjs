#!/usr/bin/env node
// Some places should not be published to the metre. A phone records the
// coordinates of the door somebody slept behind, and a journal that draws
// fourteen pins across one village has published where that house is.
//
// This collapses every photograph taken inside a named zone onto one shared
// point — the zone's own coordinate, written to two decimal places, roughly a
// kilometre. The map then shows one pin on the place instead of a trail
// through it, and no photograph carries anything finer.
//
//   node blur.mjs --trip vemdalen-2024 [--zones export/zones.json] [--dry-run]
//
// Zones live in export/zones.json so they can be corrected without touching
// code. Run it AFTER narrow.mjs and BEFORE export/build — narrow.mjs rebuilds
// photos.json from photos.all.json, which would undo this.
//
// It rewrites photos.json only. photos.all.json keeps the true coordinates:
// this is about what gets published, not about destroying what was recorded.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const DIR = join(ROOT, "export", trip);
const file = join(DIR, "photos.json");
if (!existsSync(file)) die(`No selection for ${trip}. Run query.mjs first.`);

const zonesFile = arg("zones") ?? join(ROOT, "export", "zones.json");
if (!existsSync(zonesFile)) die(`No zones file at ${zonesFile}.`);
const zones = JSON.parse(readFileSync(zonesFile, "utf8"));

const R = 6371, rad = (d) => (d * Math.PI) / 180;
const distKm = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
// Two decimal places is about 1.1 km of latitude. Anything finer is a street.
const coarse = (n) => Math.round(n * 100) / 100;

const data = JSON.parse(readFileSync(file, "utf8"));
const hits = {};
let moved = 0, worst = 0;

for (const p of data.photos) {
  if (p.lat == null || p.lng == null) continue;
  const zone = zones.find((z) => distKm(z, p) <= (z.km ?? 50));
  if (!zone) continue;
  const was = { lat: p.lat, lng: p.lng };
  p.lat = coarse(zone.lat); p.lng = coarse(zone.lng);
  p.blurred = zone.name;
  const shift = distKm(was, p);
  worst = Math.max(worst, shift);
  (hits[zone.name] ??= { n: 0, days: new Set() });
  hits[zone.name].n++; hits[zone.name].days.add(p.day);
  moved++;
}

if (!moved) { console.log(`${trip}: nothing inside a zone — unchanged.`); process.exit(0) }

for (const [name, h] of Object.entries(hits)) {
  const z = zones.find((x) => x.name === name);
  console.log(`${trip}: ${h.n} photographs over ${h.days.size} day(s) pinned to ${name} ` +
    `(${coarse(z.lat)}, ${coarse(z.lng)})`);
}
console.log(`  furthest a photograph moved: ${worst.toFixed(1)} km`);
console.log(`  photos.all.json still holds the true coordinates — this changes what is published only.`);

if (has("dry-run")) { console.log("\n--dry-run: nothing written."); process.exit(0) }
// `blurZones` so narrow.mjs can re-apply exactly this blur (B1770) rather
// than whatever the default zone file happens to say later.
writeFileSync(file, JSON.stringify({ ...data, blurred: Object.keys(hits), blurZones: zonesFile }, null, 2));
console.log(`\nNext:  node build.mjs --trip ${trip} --user <you>`);
