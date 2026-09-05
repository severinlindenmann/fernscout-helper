#!/usr/bin/env node
// Ask the Photos library what a selection contains, before exporting anything.
//
//   node query.mjs --trip algarve-2026 --from 2026-06-22 --to 2026-07-01 \
//                  [--album "Algarve"] [--favourites] [--top 15] [--videos]
//
// Writes export/<trip>/photos.json and export/<trip>/uuids.txt, and prints what
// the export will cost in photos, megabytes and minutes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, splitCsv, arg, has, die } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required, e.g. --trip algarve-2026");
const from = arg("from"), to = arg("to"), album = arg("album");
const top = arg("top") ? Number(arg("top")) : null;
if (!from && !album) die("Give a date range (--from / --to) or an --album.");

const FIELDS = {
  uuid: "{photo.uuid}", taken: "{photo.date}", fav: "{photo.favorite}",
  video: "{photo.ismovie}", screenshot: "{photo.screenshot}",
  score: "{photo.score.overall}", place: "{place.name}",
  name: "{photo.original_filename}", bytes: "{photo.original_filesize}",
  lat: "{photo.latitude}", lng: "{photo.longitude}",
};
const args = ["query"];
if (from) args.push("--from-date", from);
if (to) args.push("--to-date", `${to}T23:59:59`);
if (album) args.push("--album", album);
for (const [k, v] of Object.entries(FIELDS)) args.push("--field", k, v);

console.log("Reading the Photos library… (the first run takes a minute)");
const raw = execFileSync("osxphotos", args, { maxBuffer: 1 << 30, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const lines = raw.trim().split(/\r?\n/);
const head = splitCsv(lines[0]);
let rows = lines.slice(1).map((l) => Object.fromEntries(splitCsv(l).map((v, i) => [head[i], v])));

// osxphotos prints "_" for a false flag and for an empty place
const flag = (v) => v !== "_" && v !== "";
rows = rows.map((r) => ({
  uuid: r.uuid, name: r.name, taken: r.taken, day: r.taken.slice(0, 10), time: r.taken.slice(11, 16),
  place: flag(r.place) ? r.place : "", fav: flag(r.fav), video: flag(r.video),
  screenshot: flag(r.screenshot), score: Number(r.score) || 0, bytes: Number(r.bytes) || 0,
  lat: flag(r.lat) ? Number(r.lat) : null, lng: flag(r.lng) ? Number(r.lng) : null,
}));

if (!rows.length) die("Nothing found for that range or album. Check the dates, or the album name as it is spelled in Photos.");

let picked = rows.filter((r) => !r.screenshot && (has("videos") || !r.video));
if (has("favourites") || has("favorites")) picked = picked.filter((r) => r.fav);
if (top) {                                        // every favourite first, then the best-scoring rest
  const byDay = {};
  for (const r of picked) (byDay[r.day] ??= []).push(r);
  picked = Object.values(byDay).flatMap((day) => {
    const fav = day.filter((r) => r.fav);
    const rest = day.filter((r) => !r.fav).sort((a, b) => b.score - a.score);
    return [...fav, ...rest.slice(0, Math.max(0, top - fav.length))];
  });
}
picked.sort((a, b) => a.taken.localeCompare(b.taken));

const dir = join(ROOT, "export", trip);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "photos.json"), JSON.stringify({ trip, from, to, album, photos: picked }, null, 2));
writeFileSync(join(dir, "uuids.txt"), picked.map((r) => r.uuid).join("\n") + "\n");

const gb = picked.reduce((n, r) => n + r.bytes, 0) / 1e9;
const days = {};
for (const r of picked) (days[r.day] ??= []).push(r);
console.log(`\n${picked.length} photos over ${Object.keys(days).length} days` +
  (rows.length !== picked.length ? `  (${rows.length - picked.length} left out: screenshots, videos or not selected)` : ""));
for (const [d, list] of Object.entries(days).sort()) {
  const places = [...new Set(list.map((r) => r.place.split(",")[0]).filter(Boolean))].slice(0, 4);
  console.log(`  ${d}  ${String(list.length).padStart(4)} photos  ${list.filter((r) => r.fav).length ? "♥ " : "  "}${places.join(", ")}`);
}
console.log(`\nAbout ${gb.toFixed(1)} GB to download, roughly ${Math.max(1, Math.round(picked.length / 100))} minute(s).`);
console.log(`Anything not already on this Mac is fetched from iCloud, so it needs a connection.`);
console.log(`\nNext:  node export.mjs --trip ${trip}`);
