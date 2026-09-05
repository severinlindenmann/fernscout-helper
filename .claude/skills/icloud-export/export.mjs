#!/usr/bin/env node
// Export the selection query.mjs worked out.
//
//   node export.mjs --trip algarve-2026 [--videos]
//
// --exiftool is not optional: Photos keeps location in its own database, and
// without it the exported files carry no coordinates at all.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, arg, has, die } from "../shared/lib.mjs";

const trip = arg("trip") ?? die("--trip <name> is required.");
const dir = join(ROOT, "export", trip);
const uuids = join(dir, "uuids.txt");
if (!existsSync(uuids)) die(`No selection yet. Run query.mjs --trip ${trip} … first.`);

const out = join(dir, "photos");
mkdirSync(out, { recursive: true });
const count = readFileSync(uuids, "utf8").trim().split("\n").length;
console.log(`Exporting ${count} photos to ${out}`);
console.log(`Anything only in iCloud is downloaded now — this is the slow part.\n`);

execFileSync("osxphotos", [
  "export", out,
  "--uuid-from-file", uuids,
  "--download-missing", "--use-photokit",
  "--skip-original-if-edited",
  "--convert-to-jpeg", "--jpeg-quality", "1.0",
  "--exiftool",              // writes the GPS Photos keeps in its own database
  "--update",                // safe to run again; only fetches what is missing
], { stdio: "inherit" });

// Live Photos bring a .mov along that nobody asked for.
if (!has("videos")) {
  const movs = readdirSync(out).filter((f) => /\.mov$/i.test(f));
  movs.forEach((f) => rmSync(join(out, f)));
  if (movs.length) console.log(`\nRemoved ${movs.length} Live Photo movie(s).`);
}

const files = readdirSync(out).filter((f) => /\.jpe?g$/i.test(f));
console.log(`\n${files.length} photos in export/${trip}/photos/`);
console.log(`Next:  node review.mjs --trip ${trip}`);
