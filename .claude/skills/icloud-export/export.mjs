#!/usr/bin/env node
// Export the selection query.mjs worked out.
//
//   node export.mjs --trip example-trip-2024 [--videos]
//   node export.mjs --trip example-trip-2024 --check     only re-check what is there
//
// --exiftool is not optional: Photos keeps location in its own database, and
// without it the exported files carry no coordinates at all.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die, stemOf } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const dir = join(ROOT, "export", trip);
const uuids = join(dir, "uuids.txt");
if (!existsSync(uuids)) die(`No selection yet. Run query.mjs --trip ${trip} … first.`);

const out = join(dir, "photos");
mkdirSync(out, { recursive: true });
const count = readFileSync(uuids, "utf8").trim().split("\n").length;
// `--check` re-runs only the checks below on an export that already happened,
// which is also how they are tested without a Photos library.
const check = has("check");
if (!check) {
  console.log(`Exporting ${count} photos to ${out}`);
  console.log(`Anything only in iCloud is downloaded now — this is the slow part.\n`);

  execFileSync("osxphotos", [
    "export", out,
    "--uuid-from-file", uuids,
    "--download-missing", "--use-photokit",
    "--skip-original-if-edited",
    "--convert-to-jpeg", "--jpeg-quality", "1.0",
    "--exiftool",            // writes the GPS Photos keeps in its own database
    "--update",              // safe to run again; only fetches what is missing
  ], { stdio: "inherit" });
}

// Live Photos bring a .mov along that nobody asked for.
if (!has("videos")) {
  const movs = readdirSync(out).filter((f) => /\.mov$/i.test(f));
  movs.forEach((f) => rmSync(join(out, f)));
  if (movs.length) console.log(`\nRemoved ${movs.length} Live Photo movie(s).`);
}

/**
 * What actually landed — B1772.
 *
 * `--convert-to-jpeg` is asked for above and is not always honoured: 21 of 28
 * files in one trip came out as `.HEIC`. Everything downstream filters
 * `/\.jpe?g$/i`, so those photographs were **invisible** rather than broken —
 * `describe.mjs` built a three-photo sheet for a fifteen-photo day and
 * reported success. So convert what is left, and then compare what is on disk
 * with what was asked for instead of printing a number nobody reads against
 * anything.
 */
const strays = readdirSync(out).filter((f) => /\.(heic|heif|png|tiff?|webp)$/i.test(f));
let converted = 0;
for (const name of strays) {
  const from = join(out, name), to = join(out, name.replace(/\.[^.]+$/, ".jpg"));
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", from, "--out", to], { stdio: "ignore" });
    // sips drops most of what exiftool wrote, and the coordinates are the
    // whole reason --exiftool is not optional. Copy them across.
    try { execFileSync("exiftool", ["-TagsFromFile", from, "-all:all", "-overwrite_original", to], { stdio: "ignore" }) } catch {}
    rmSync(from);
    converted += 1;
  } catch {
    console.log(`  ! ${name} could not be converted to JPEG — nothing downstream will see it`);
  }
}
if (converted) console.log(`\nConverted ${converted} file(s) the export left in another format.`);

const files = readdirSync(out).filter((f) => /\.jpe?g$/i.test(f));
const onDisk = new Set(files.map(stemOf));
const wanted = JSON.parse(readFileSync(join(dir, "photos.json"), "utf8")).photos ?? [];
const missing = wanted.filter((p) => !onDisk.has(stemOf(p.name)));
console.log(`\n${files.length} photos in export/${trip}/photos/, ${wanted.length} asked for`);
if (missing.length) {
  console.error(`\n✗ ${missing.length} of them did not arrive:`);
  for (const p of missing.slice(0, 15)) console.error(`    ${p.day} ${p.name}`);
  if (missing.length > 15) console.error(`    … and ${missing.length - 15} more`);
  die("\nEvery later step reads only JPEGs, so a photograph that is not here is invisible rather than\n" +
      "missing — a day of fifteen becomes a sheet of three and nothing says so. Re-run this; if a file\n" +
      "keeps failing it is broken in the library itself (query.mjs names those).");
}
console.log(`Next:  node review.mjs --trip ${trip}`);
