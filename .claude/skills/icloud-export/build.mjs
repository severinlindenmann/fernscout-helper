#!/usr/bin/env node
// Turn the reviewed photos into a Fernscout content folder: one entry per day,
// a sized gallery, the captions the person wrote. It does NOT write the prose —
// that is the agent's job, from notes.md, and from nothing else.
//
//   node build.mjs --trip algarve-2026 --user severin
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, die, stemOf } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const user = arg("user") ?? die("--user <name> is required — the folder your journal lives in.");
const MAX_EDGE = Number(arg("max-edge") ?? 2000);

const DIR = join(ROOT, "export", trip);
const photosDir = join(DIR, "photos");
const review = existsSync(join(DIR, "review.json"))
  ? JSON.parse(readFileSync(join(DIR, "review.json"), "utf8")) : { photos: {}, days: {} };
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
mkdirSync(join(TRIP, "entries"), { recursive: true });

const notes = [`# ${trip} — what the author said`, "",
  "Everything below is the person's own words. Write the entries from this and",
  "from nothing else: no weather nobody mentioned, no meals nobody ate.", ""];
let written = 0, copied = 0;

for (const [day, list] of Object.entries(byDay).sort()) {
  const places = list.map((p) => (p.place || "").split(",")[0]).filter(Boolean);
  const place = places.sort((a, b) =>
    places.filter((x) => x === b).length - places.filter((x) => x === a).length)[0] ?? "";
  const daySlug = slug(place) || "day";
  const mediaDir = join(TRIP, "media", daySlug);
  mkdirSync(mediaDir, { recursive: true });

  const gallery = list.map((p, i) => {
    const name = String(i + 1).padStart(2, "0") + ".jpg";
    const dest = join(mediaDir, name);
    copyFileSync(join(photosDir, p.file), dest);
    execFileSync("sips", ["-Z", String(MAX_EDGE), dest], { stdio: "ignore" });
    // Served pictures carry no metadata: a phone writes the coordinates of
    // somebody's front door into the file. They live in the frontmatter instead,
    // where they can be seen and deleted.
    execFileSync("exiftool", ["-all=", "-overwrite_original", dest], { stdio: "ignore" });
    const dim = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", dest], { encoding: "utf8" });
    const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(dim.match(re)?.[1] ?? 0));
    copied++;
    return { src: `/media/${trip}/${daySlug}/${name}`, w, h, caption: p.note,
             visibility: review.photos?.[p.file]?.visibility || "" };
  });

  const first = list[0], withGps = list.find((p) => p.lat);
  const lines = [
    "---",
    `title: ""                     # the agent writes this`,
    `date: "${day}"`,
    `time: "${first.time}"`,
    place ? `location: "${place}"` : `location: ""`,
    ...(withGps ? [`lat: ${withGps.lat}`, `lng: ${withGps.lng}`] : []),
    "gallery:",
    ...gallery.flatMap((g) => [
      `  - src: "${g.src}"`,
      ...(g.caption ? [`    caption: ${JSON.stringify(g.caption)}`] : []),
      // Only ever written for a picture the person held back on the review
      // page. An absent line is what "everyone the trip lets in" looks like,
      // and the label can only narrow that — never widen it.
      ...(g.visibility ? [`    visibility: ${JSON.stringify(g.visibility)}`] : []),
      `    type: "image"`, `    width: ${g.w}`, `    height: ${g.h}`,
    ]),
    "status: draft",
    "---", "",
    "_The agent writes the day here, from notes.md._", "",
  ];
  writeFileSync(join(TRIP, "entries", `${day}-${daySlug}.md`), lines.join("\n"));
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
console.log(`Every entry is a draft, and every title and every paragraph is still empty.`);
