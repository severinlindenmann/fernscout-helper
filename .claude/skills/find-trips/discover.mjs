#!/usr/bin/env node
// Which weeks was somebody away, over years of photographs nobody indexed?
// Reads the Photos library's metadata only — no file is fetched from iCloud,
// nothing is written into the library, and it proposes rather than decides.
//
//   node discover.mjs --home 46.9480,7.4474 --home 47.3779,8.5403 [--years 10]
//                     [--who severin] [--people export/household.json]
//                     [--radius 100] [--min-days 2] [--gap 2] [--json]
//
// Three things this gets right that the obvious version does not, each of
// which cost a real journal a real day before it was fixed:
//
//  1. A DAY IS A JOURNEY, NOT A POINT. Anchoring a day to the *median* of its
//     photographs puts 31 December — Baden in the morning, Gyál at night —
//     in the middle of the Baltic Sea, further than any radius from every
//     photograph actually taken. The whole day then vanishes. A day is
//     compared against every place its owner stood, and is "away" if any of
//     them is far from home.
//
//  2. A LIBRARY IS NOT ONE PERSON. Two people in a household can be a
//     thousand kilometres apart on the same day, and a relative's pictures
//     land in the same library under the same dates. Detection runs per
//     person, from --people, so his three days in Piedmont and her seven in
//     Hungary come out as two trips rather than one impossible one.
//
//  3. A PHONE IS NOT ITS OWNER FOREVER. People replace phones and hand the
//     old one on, so a camera belongs to somebody for a stretch of time and
//     the rules carry `from`/`to`.
//
// What it cannot do is tell you whether a trip was yours. A week of somebody
// else's photographs in your library looks exactly like a week of yours. Ask.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, argv, splitCsv, arg, has, die } from "../shared/lib.mjs";

// Everything the command line supplies is read inside the CLI block at the
// bottom, so this file can be imported by a test without exiting.
function readOptions() {
  const homes = argv.flatMap((a, i) => (a === "--home" ? [argv[i + 1]] : [])).map((v, n) => {
    const [lat, lng] = String(v ?? "").split(/[,;\s]+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) die(`--home #${n + 1} is not a "lat,lng" pair: ${v}`);
    return { lat, lng };
  });
  if (!homes.length) die('At least one --home is required, e.g. --home 46.9480,7.4474 (Bern).');

  const radius = Number(arg("radius") ?? 100);
  const minDays = Number(arg("min-days") ?? 2);
  const maxGap = Number(arg("gap") ?? 2);
  const years = Number(arg("years") ?? 10);

  // Whose cameras are whose. Without this every photograph in the library votes,
  // including the neighbour's and the ones somebody sent by message.
  const peopleFile = arg("people") ?? join(ROOT, "export", "household.json");
  let people = null;
  if (existsSync(peopleFile)) people = JSON.parse(readFileSync(peopleFile, "utf8")).people ?? null;
  const who = arg("who") ? arg("who").split(",").map((s) => s.trim()) : (people ? Object.keys(people) : null);
  if (people) for (const w of who) if (!people[w]) die(`--who ${w} is not in ${peopleFile}`);

  const iso = (d) => d.toISOString().slice(0, 10);
  const to = arg("to") ?? iso(new Date(Date.now()));
  const from = arg("from") ?? iso(new Date(new Date(to).getTime() - years * 365.25 * 864e5));
  return { homes, radius, minDays, maxGap, years, people, who, from, to };
}

const R = 6371, rad = (d) => (d * Math.PI) / 180;
export const distKm = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const dayNo = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 864e5);

/** Who carried this camera on this day, or null for nobody in the household. */
export function ownerOf(photo, rules) {
  if (!rules) return null;
  for (const [name, devices] of Object.entries(rules))
    for (const d of devices)
      if (photo.model === d.model && (!d.from || photo.day >= d.from) && (!d.to || photo.day < d.to))
        return name;
  return null;
}

/**
 * Consecutive days spent further than `radius` from every home.
 * A day counts as away when ANY of its photographs is far — see note 1 above.
 */
export function runsFor(rows, { homes, radius, minDays, maxGap }) {
  const days = new Map();
  for (const r of rows) {
    const d = days.get(r.day) ?? { day: r.day, photos: 0, points: [], places: new Map() };
    d.photos++;
    if (r.lat !== null && r.lng !== null) d.points.push({ lat: r.lat, lng: r.lng });
    if (r.place) d.places.set(r.place, (d.places.get(r.place) ?? 0) + 1);
    days.set(r.day, d);
  }
  for (const d of days.values()) {
    if (!d.points.length) { d.state = "unknown"; continue }
    d.km = Math.max(...d.points.map((p) => Math.min(...homes.map((h) => distKm(h, p)))));
    d.state = d.km > radius ? "away" : "home";
  }
  const sorted = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const out = []; let run = null;
  const close = () => {
    if (!run) return;
    while (run.days.length && run.days.at(-1).state !== "away") run.days.pop();
    if (run.days.length) out.push(run);
    run = null;
  };
  for (const d of sorted) {
    if (run) {
      const gap = dayNo(d.day) - dayNo(run.days.at(-1).day) - 1;
      if (d.state === "home" || gap > maxGap) close();
    }
    if (d.state === "away") (run ??= { days: [] }).days.push(d);
    else if (run && d.state === "unknown") {
      if (run.days.filter((x) => x.state !== "away").length >= maxGap) close(); else run.days.push(d);
    }
  }
  close();
  return out.filter((r) => r.days.length >= minDays).map((r) => {
    const places = new Map();
    for (const d of r.days) for (const [p, n] of d.places) places.set(p, (places.get(p) ?? 0) + n);
    const away = r.days.filter((d) => d.state === "away");
    return {
      from: r.days[0].day, to: r.days.at(-1).day, days: r.days.length,
      photos: r.days.reduce((n, d) => n + d.photos, 0),
      unlocated: r.days.filter((d) => d.state === "unknown").length,
      maxKm: Math.round(Math.max(...away.map((d) => d.km))),
      places: [...places.entries()].sort((a, b) => b[1] - a[1])
        .flatMap(([p]) => p.split(",").map((s) => s.trim()))
        .filter((p, i, all) => p && all.indexOf(p) === i).slice(0, 5),
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { homes, radius, minDays, maxGap, people, who, from, to } = readOptions();
  const FIELDS = {
    taken: "{photo.date}", video: "{photo.ismovie}", screenshot: "{photo.screenshot}",
    place: "{place.name}", lat: "{photo.latitude}", lng: "{photo.longitude}",
    model: "{photo.exif_info.camera_model}",
  };
  const args = ["query", "--from-date", from, "--to-date", `${to}T23:59:59`];
  for (const [k, v] of Object.entries(FIELDS)) args.push("--field", k, v);

  console.log(`Reading the Photos library from ${from} to ${to}… (metadata only, nothing is downloaded)`);
  const raw = execFileSync("osxphotos", args,
    { maxBuffer: 1 << 30, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = raw.replace(/\r/g, "").trim().split("\n");
  const head = splitCsv(lines[0]);
  const flag = (v) => v !== "_" && v !== "";
  const rows = lines.slice(1)
    .map((l) => Object.fromEntries(splitCsv(l).map((v, i) => [head[i], v])))
    .map((r) => ({
      day: r.taken.slice(0, 10), model: flag(r.model) ? r.model : "",
      screenshot: flag(r.screenshot),
      place: flag(r.place) ? r.place : "",
      lat: flag(r.lat) ? Number(r.lat) : null, lng: flag(r.lng) ? Number(r.lng) : null,
    }))
    .filter((r) => !r.screenshot && /^\d{4}-\d{2}-\d{2}$/.test(r.day));

  if (!rows.length) die(
    "No photographs found in that range.\n" +
    "If the library is not empty, the terminal probably lacks Full Disk Access\n" +
    "(System Settings → Privacy & Security).");

  const opts = { homes, radius, minDays, maxGap };
  const result = {};
  if (people) for (const w of who) result[w] = runsFor(rows.filter((r) => ownerOf(r, { [w]: people[w] }) === w), opts);
  else result.everyone = runsFor(rows, opts);

  const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
  const names = Object.keys(result);
  const merged = [];
  const claimed = new Set();
  for (const name of names) for (const t of result[name]) {
    const key = name + t.from;
    if (claimed.has(key)) continue;
    const alsoThere = names.filter((n) => n !== name)
      .flatMap((n) => result[n].filter((o) => overlaps(t, o) && o.places.some((p) => t.places.includes(p)))
        .map((o) => (claimed.add(n + o.from), n)));
    claimed.add(key);
    merged.push({ ...t, who: [name, ...alsoThere] });
  }
  merged.sort((a, b) => a.from.localeCompare(b.from));

  mkdirSync(join(ROOT, "export"), { recursive: true });
  const file = join(ROOT, "export", "discovered.json");
  writeFileSync(file, JSON.stringify({ from, to, homes, radius, minDays, trips: merged }, null, 2));

  if (has("json")) { console.log(JSON.stringify(merged, null, 2)); process.exit(0) }

  console.log(`\n${rows.length} photographs. Away means further than ${radius} km from ` +
    homes.map((h) => `${h.lat},${h.lng}`).join(" and ") + ".\n");
  if (!merged.length) console.log(`No run of ${minDays}+ away days found. Try a smaller --radius.`);
  for (const t of merged) {
    const nights = t.days - 1;
    console.log(`  ${t.from} → ${t.to}  ${String(t.days).padStart(2)}d ${String(t.photos).padStart(5)}p ` +
      `${String(t.maxKm).padStart(5)}km  [${t.who.join(", ")}]  ${t.places.slice(0, 3).join(" · ")}` +
      (t.unlocated ? `  (${t.unlocated} day(s) with no location)` : ""));
  }
  console.log(`\n${merged.length} candidate trip(s) → ${file.replace(ROOT + "/", "")}`);
  console.log(`These are candidates, not facts. A week of somebody else's photographs in`);
  console.log(`your library looks exactly like a week of yours — check the dates against`);
  console.log(`what you remember before exporting anything.`);
}
