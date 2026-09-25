#!/usr/bin/env node
// One contact sheet per day, so an agent can look at a trip without opening
// two thousand files. It makes pictures and nothing else — it writes no words.
// The words are written by whoever reads the sheets, into review.json's
// `observed`, and `observed` is a memory-jogger for the person: it is never
// the journal's prose. See SKILL.md, "The one rule".
//
//   node describe.mjs --trip example-trip-2024 [--per-sheet 16] [--tile 400]
//
// Writes export/<trip>/sheets/<YYYY-MM-DD>[-2].jpg and sheets/index.json,
// which says which photograph is in which cell, reading left to right.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, die, has, stemOf } from "../shared/lib.mjs";
import { ensureBaked } from "./bake.mjs";
import { readFileSync } from "node:fs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const PER_SHEET = Number(arg("per-sheet") ?? 16);
const TILE = Number(arg("tile") ?? 400);

const DIR = join(ROOT, "export", trip);
const PHOTOS = join(DIR, "photos"), SHEETS = join(DIR, "sheets"), TMP = join(DIR, ".sheet-tmp");
if (!existsSync(PHOTOS)) die(`Nothing exported yet. Run export.mjs --trip ${trip} first.`);

for (const bin of ["sips", "ffmpeg"]) {
  try { execFileSync("which", [bin], { stdio: "ignore" }) }
  catch { die(`${bin} is missing. ffmpeg: brew install ffmpeg`) }
}

const meta = new Map();
for (const p of JSON.parse(readFileSync(join(DIR, "photos.json"), "utf8")).photos) meta.set(stemOf(p.name), p);

// Anything already turned off on the review page is not worth describing.
//
// B1767: this read was a bare try/catch, so "nothing has been reviewed yet"
// and "nothing was dropped" were the same answer and the run went ahead over
// every photograph in silence. Describing first and reviewing afterwards is
// the wrong order and it is not a matter of taste: whatever is written from
// these sheets outlives the review, so a photograph the person turns off for
// privacy keeps its sentence. In one run 51 of 147 days carried prose about
// removed photographs, one of them opening by describing the payment cards
// their owner had just turned off.
//
// The order is export → review → describe → build. `--before-review` says the
// other order is deliberate, for a trip nobody will hand to a person.
let review = null;
try { review = JSON.parse(readFileSync(join(DIR, "review.json"), "utf8")) } catch {}
if (!review || !Object.keys(review.photos ?? {}).length) {
  if (!has("before-review")) {
    die(`Nothing has been reviewed for ${trip} yet, and a sheet made now describes photographs\n` +
        `the person may be about to turn off — whatever is written from it keeps describing them.\n\n` +
        `  node review.mjs --trip ${trip}     then run this again\n\n` +
        `If you mean to describe before a review, pass --before-review and say so in what you write.`);
  }
  console.warn("  ! --before-review: nothing has been reviewed yet, so these sheets include everything.");
  console.warn("  ! Anything written from them has to be checked again after the review.");
}
const dropped = new Set(
  Object.entries(review?.photos ?? {}).filter(([, s]) => s.drop).map(([f]) => f),
);

const files = readdirSync(PHOTOS).filter((f) => /\.jpe?g$/i.test(f) && !dropped.has(f));
const photos = files.map((file) => ({ file, ...(meta.get(stemOf(file)) ?? {}) }))
  .filter((p) => p.day)
  .sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
if (!photos.length) die("No photographs with a date to make sheets from.");

const byDay = {};
for (const p of photos) (byDay[p.day] ??= []).push(p);

mkdirSync(SHEETS, { recursive: true });
const index = {};
let sheets = 0;

for (const [day, list] of Object.entries(byDay).sort()) {
  for (let part = 0; part * PER_SHEET < list.length; part++) {
    const chunk = list.slice(part * PER_SHEET, (part + 1) * PER_SHEET);
    const name = part === 0 ? day : `${day}-${part + 1}`;
    const out = join(SHEETS, `${name}.jpg`);

    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    // The baked derivative, so a phone held sideways is already upright here
    // rather than relying on an Orientation tag ffmpeg would ignore.
    // Every tile is padded to an exact square HERE, by sips, and not later by
    // ffmpeg. `sips -Z` keeps the aspect ratio, so a landscape photograph came
    // out 400x300 and a portrait one 300x400 — and ffmpeg's image-sequence
    // reader cannot change frame size mid-stream. It stopped at the first
    // photograph held the other way up, silently, and the day was described
    // from whatever happened to come before it. One day of twelve rendered one.
    //
    // ffmpeg also reads %04d.jpg as a sequence and stops at the first GAP, so
    // number only what actually converted, and say out loud what did not.
    const tiles = [], failed = [];
    for (const p of chunk) {
      try {
        const src = ensureBaked(DIR, PHOTOS, p.file);
        const out = join(TMP, String(tiles.length + 1).padStart(4, "0") + ".jpg");
        execFileSync("sips", ["-Z", String(TILE),
          "--padToHeightWidth", String(TILE), String(TILE), "--padColor", "1E293B",
          "-s", "format", "jpeg", "-s", "formatOptions", "70",
          src, "--out", out], { stdio: "ignore" });
        tiles.push(p);
      } catch { failed.push(p.file) }
    }
    if (failed.length) console.warn(`  ! ${name}: ${failed.length} could not be rendered — ${failed.join(", ")}`);
    if (!tiles.length) { console.warn(`  ! ${name}: no sheet, nothing rendered`); continue }

    const cols = Math.min(4, tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    execFileSync("ffmpeg", ["-y", "-i", join(TMP, "%04d.jpg"),
      "-filter_complex",
      `tile=${cols}x${rows}:padding=6:color=0x1e293b`,
      "-frames:v", "1", "-q:v", "4", out], { stdio: "ignore" });

    index[name] = {
      day, sheet: `${name}.jpg`, cols, rows,
      places: [...new Set(tiles.map((p) => (p.place || "").split(",")[0]).filter(Boolean))],
      cells: tiles.map((p, i) => ({ cell: i + 1, file: p.file, time: p.time, place: p.place, fav: !!p.fav })),
      ...(failed.length ? { notRendered: failed } : {}),
    };
    sheets++;
  }
}
rmSync(TMP, { recursive: true, force: true });
writeFileSync(join(SHEETS, "index.json"), JSON.stringify(index, null, 2));

console.log(`${sheets} sheet(s) for ${Object.keys(byDay).length} day(s) → export/${trip}/sheets/`);
for (const [name, s] of Object.entries(index))
  console.log(`  ${name}.jpg  ${String(s.cells.length).padStart(2)} photos  ${s.places.slice(0, 3).join(" · ")}`);
console.log(`\nThe sheets are pictures only. Nothing here writes a word about them.`);
