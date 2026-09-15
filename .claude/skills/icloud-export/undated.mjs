#!/usr/bin/env node
// Photographs a camera stamped wrongly, or did not stamp at all.
//
// A camera with a dead clock battery, or files whose EXIF was stripped in
// transfer, arrive in Photos with no date it can trust — so the library
// buckets the whole lot on one meaningless day. They are still a trip's
// photographs; they have simply lost the one field every other tool here
// sorts by.
//
// Two things survive that loss, and together they are enough:
//   · the camera's own sequence number in the filename — the ORDER is intact
//   · whatever the person marks in Photos — a favourite, an album
//
//   node undated.mjs --trip asia-2018-canon --on 2017-09-11 \
//                    --width 5202,3465 [--favourites] [--album Canon]
//
// Writes export/<trip>/photos.json and uuids.txt like query.mjs does, ordered
// by filename rather than by a timestamp nobody believes, so `export.mjs` and
// everything downstream work unchanged. The dates are filled in later, by a
// person, in assign.mjs — never guessed here.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, splitCsv, arg, has, die } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required, e.g. --trip asia-2018-canon");
const on = arg("on") ?? die('--on <YYYY-MM-DD> is required — the day the library wrongly stamped them.');
const widths = (arg("width") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const album = arg("album");

const FIELDS = {
  uuid: "{photo.uuid}", name: "{photo.original_filename}", bytes: "{photo.original_filesize}",
  fav: "{photo.favorite}", video: "{photo.ismovie}", screenshot: "{photo.screenshot}",
  width: "{photo.width}", height: "{photo.height}", albums: "{photo.albums}",
};
const args = ["query", "--from-date", on, "--to-date", `${on}T23:59:59`];
if (has("favourites") || has("favorites")) args.push("--favorite");
for (const [k, v] of Object.entries(FIELDS)) args.push("--field", k, v);

console.log(`Reading the Photos library for ${on}…`);
const raw = execFileSync("osxphotos", args,
  { maxBuffer: 1 << 30, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const lines = raw.replace(/\r/g, "").trim().split("\n");
const head = splitCsv(lines[0]);
const flag = (v) => v !== "_" && v !== "";

let rows = lines.slice(1).map((l) => Object.fromEntries(splitCsv(l).map((v, i) => [head[i], v])))
  .map((r) => ({
    uuid: r.uuid, name: r.name, bytes: Number(r.bytes) || 0,
    fav: flag(r.fav), video: flag(r.video), screenshot: flag(r.screenshot),
    width: Number(r.width) || 0, height: Number(r.height) || 0,
    albums: flag(r.albums) ? r.albums : "",
  }))
  .filter((r) => !r.screenshot && !r.video && r.width && r.height);

// One camera among many in the same bucket: 1,577 files on one day were an old
// archive dump AND 1,271 from a DSLR. Resolution told them apart when nothing
// else could, so it is a first-class filter here.
if (widths.length) rows = rows.filter((r) => widths.includes(String(r.width)) || widths.includes(String(r.height)));
if (album) rows = rows.filter((r) => r.albums.split(",").map((s) => s.trim()).includes(album));
if (!rows.length) die("Nothing matched. Check --on, --width and --album against the library.");

// The filename IS the timeline. Numeric collation so IMG_999 precedes IMG_1000.
rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const picked = rows.map((r, i) => ({ ...r, seq: i + 1, day: "", time: "", place: "", score: 0, taken: "" }));

const dir = join(ROOT, "export", trip);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "photos.json"),
  JSON.stringify({ trip, undated: true, stampedOn: on, photos: picked }, null, 2));
writeFileSync(join(dir, "uuids.txt"), picked.map((r) => r.uuid).join("\n") + "\n");

const gb = picked.reduce((n, r) => n + r.bytes, 0) / 1e9;
console.log(`\n${picked.length} photographs, ${gb.toFixed(1)} GB` +
  (picked.every((r) => r.fav) ? " (all favourites)" : `, ${picked.filter((r) => r.fav).length} favourites`));
console.log(`  ${picked[0].name} → ${picked.at(-1).name}, in filename order`);
console.log(`\nThese carry no trustworthy date. Nothing here guesses one.`);
console.log(`\nNext:  node export.mjs --trip ${trip}`);
console.log(`then:  node assign.mjs --trip ${trip} --into <the trip they belong to>`);
