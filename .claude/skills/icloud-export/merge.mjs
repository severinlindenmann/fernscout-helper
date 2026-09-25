#!/usr/bin/env node
// Add assigned photographs to days that already exist.
//
//   node merge.mjs --trip second-trip-2023 --into example-trip-2024 --user alex [--dry-run]
//
// Reads export/<trip>/assign.json — what a person decided in assign.mjs — and
// appends those photographs to the days they named, baked and stripped the
// same way build.mjs does, because a photograph that reaches the journal by a
// second road must still be the same picture the first road would have made.
//
// It writes no prose and no titles. Somebody else's camera does not change
// what happened on a day: the words already there were written from the
// author's own account and stay exactly as they are.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, arg, has, die } from "../shared/lib.mjs";
import { contentHash } from "../shared/syncManifest.mjs";
import { ensureBaked } from "./bake.mjs";

const trip = arg("trip") ?? die("--trip <exported folder> is required.");
const into = arg("into") ?? die("--into <trip in content/> is required.");
const user = arg("user") ?? die("--user <name> is required — the folder your journal lives in.");
// The instance's own ceiling on items in one day. 40 is the default an
// instance ships with, kept as a fallback because this script works offline;
// the real value is the instance's to say, at /api/v2/status `limits.itemsPerDay`
// — pass it with --max-per-day when an instance publishes another one.
const PER_DAY = Number(arg("max-per-day") ?? 40);

const DIR = join(ROOT, "export", trip), PHOTOS = join(DIR, "photos");
const TRIPDIR = join(ROOT, "content", user, "trips", into);
const assignFile = join(DIR, "assign.json");
if (!existsSync(assignFile)) die(`No assign.json in export/${trip}. Run assign.mjs first.`);
const assign = JSON.parse(readFileSync(assignFile, "utf8"));

const bySlug = {};
for (const [file, slug] of Object.entries(assign)) if (slug) (bySlug[slug] ??= []).push(file);
if (!Object.keys(bySlug).length) die("Nothing has been assigned to a day yet.");

let added = 0, skipped = 0, refusedFull = 0;
for (const [slug, list] of Object.entries(bySlug)) {
  const entryPath = join(TRIPDIR, "entries", `${slug}.json`);
  if (!existsSync(entryPath)) { console.log(`  ✗ no day ${slug} in ${into} — skipped ${list.length}`); continue }
  const entry = JSON.parse(readFileSync(entryPath, "utf8"));
  entry.media ??= [];
  const mediaDir = join(TRIPDIR, "media", slug);
  mkdirSync(mediaDir, { recursive: true });

  // Sort by filename: the camera's order is the only timeline these have.
  list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const room = PER_DAY - entry.media.length;
  const take = list.slice(0, Math.max(0, room));
  if (take.length < list.length) refusedFull += list.length - take.length;

  for (const file of take) {
    const baked = ensureBaked(DIR, PHOTOS, file);
    // Name by content, as the instance does — SHA-256, hex, cut to 32
    // (fernscout lib/ingest/hash.ts `contentHash`) — so re-running cannot
    // duplicate, and the name here is the name the instance would give it.
    const hash = contentHash(readFileSync(baked));
    const name = `${hash}.jpg`;
    const src = `/media/${into}/${slug}/${name}`;
    if (entry.media.some((m) => m.src === src)) { skipped++; continue }
    if (!has("dry-run")) copyFileSync(baked, join(mediaDir, name));
    entry.media.push({ src });
    added++;
  }
  // `??= []` above, and nothing came: leave the day as it was. A day that now
  // holds photographs no longer declines them — the instance refuses a section
  // that is there and declined at once (B1769's rule).
  if (!entry.media.length) delete entry.media;
  else if (entry.declined && "media" in entry.declined) {
    delete entry.declined.media;
    if (!Object.keys(entry.declined).length) delete entry.declined;
  }
  if (!has("dry-run")) writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n");
  console.log(`  ${slug}: ${entry.media?.length ?? 0} photographs (${take.length} added)`);
}

console.log(`\n${added} added, ${skipped} already there` +
  (refusedFull ? `, ${refusedFull} left out — the day was at the ${PER_DAY}-photograph ceiling` : ""));
if (has("dry-run")) console.log("--dry-run: nothing written.");
else console.log(`\nNext:  node ../validate-content/validate.mjs --user ${user} --trip ${into}`);
