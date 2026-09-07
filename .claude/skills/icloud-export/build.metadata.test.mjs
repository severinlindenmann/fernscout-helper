#!/usr/bin/env node
// B649 and B650 — the two facts a day's frontmatter states as certain
// (`time:`, and the pairing of `location:` with `lat`/`lng`) can each be
// wrong in a way `validate-content` cannot see, because both are about
// *which* photo build.mjs trusts rather than about the shape of a file.
//
//   node .claude/skills/icloud-export/build.metadata.test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "build.mjs");
const FIXTURE = join(ROOT, ".claude/skills/shared/fixtures/orientation/orientation-1.jpg");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

function buildTrip(trip, user, photos) {
  const EXPORT_DIR = join(ROOT, "export", trip);
  const CONTENT_DIR = join(ROOT, "content", user);
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  rmSync(CONTENT_DIR, { recursive: true, force: true });
  mkdirSync(join(EXPORT_DIR, "photos"), { recursive: true });
  for (const p of photos) copyFileSync(FIXTURE, join(EXPORT_DIR, "photos", p.name));
  writeFileSync(join(EXPORT_DIR, "photos.json"), JSON.stringify({ trip, photos }, null, 2));
  writeFileSync(join(EXPORT_DIR, "review.json"), JSON.stringify({ photos: {}, days: {} }, null, 2));
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [BUILD, "--trip", trip, "--user", user], { encoding: "utf8" });
  } catch (failure) {
    stdout = (failure.stdout ?? "") + (failure.stderr ?? "");
  }
  const entriesDir = join(CONTENT_DIR, "trips", trip, "entries");
  const entry = readdirSync(entriesDir)[0];
  const text = readFileSync(join(entriesDir, entry), "utf8");
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  rmSync(CONTENT_DIR, { recursive: true, force: true });
  return { stdout, text };
}

// ── B649: the day's time comes from a real photo, not whichever file sorts
//    first — a screenshot taken while planning, hours before anything else ──
{
  const { text } = buildTrip("b649-screenshot-first", "b649-user", [
    { name: "a-screenshot.jpg", day: "2025-11-14", taken: "2025-11-14T06:44:00", time: "06:44", place: "", fav: false },
    { name: "b-real-photo.jpg", day: "2025-11-14", taken: "2025-11-14T14:25:00", time: "14:25", place: "Basel", fav: false, lat: 47.5, lng: 7.6 },
  ]);
  check("B649: time: comes from the first photo that has GPS, not the first file",
    /time: "14:25"/.test(text), text);
}

// ── B649: a day of screenshots alone still gets a sensible time ────────────
{
  const { text } = buildTrip("b649-no-gps-at-all", "b649-user2", [
    { name: "only-screenshot.jpg", day: "2025-11-15", taken: "2025-11-15T09:00:00", time: "09:00", place: "", fav: false },
  ]);
  check("B649: a day with no GPS anywhere falls back to the first file's time rather than crashing",
    /time: "09:00"/.test(text), text);
}

// ── B650: location: and the GPS photo's own place can name different towns ─
{
  const { stdout } = buildTrip("b650-mismatch", "b650-user", [
    { name: "speyer-1.jpg", day: "2025-11-15", taken: "2025-11-15T09:00:00", time: "09:00", place: "Speyer, Germany", fav: false },
    { name: "speyer-2.jpg", day: "2025-11-15", taken: "2025-11-15T09:05:00", time: "09:05", place: "Speyer, Germany", fav: false },
    { name: "merzhausen.jpg", day: "2025-11-15", taken: "2025-11-15T09:10:00", time: "09:10", place: "Merzhausen, Germany", fav: false, lat: 47.9, lng: 7.8 },
  ]);
  check("B650: a day whose location: and coordinates disagree prints a line naming both",
    /Speyer.*Merzhausen|Merzhausen.*Speyer/.test(stdout), stdout);
}

// ── B650: the ordinary day — everything agrees — prints nothing ────────────
{
  const { stdout } = buildTrip("b650-agree", "b650-user2", [
    { name: "basel-1.jpg", day: "2025-11-16", taken: "2025-11-16T09:00:00", time: "09:00", place: "Basel, Switzerland", fav: false, lat: 47.5, lng: 7.6 },
  ]);
  check("B650: a day where location: and coordinates agree prints no warning",
    !/⚠/.test(stdout), stdout);
}

if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
