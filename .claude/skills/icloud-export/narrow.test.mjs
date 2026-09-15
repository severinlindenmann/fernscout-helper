#!/usr/bin/env node
// B1771 and B1770 — the two ways narrowing a selection published something it
// should not have. The first and last day of a trip contain the journey, so
// one of the places its people stood is their own front door; and re-running
// this rebuilds photos.json from the copy that still holds the true
// coordinates, which silently undid a blur.
//
//   node .claude/skills/icloud-export/narrow.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NARROW = join(HERE, "narrow.mjs"), BLUR = join(HERE, "blur.mjs");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const TRIP = "b1771-home-on-the-edges";
const DIR = join(ROOT, "export", TRIP);
const HOME = { lat: 46.95, lng: 7.45 };          // Bern
const AWAY = { lat: 48.05, lng: 8.20 };          // ~110 km north, over a border
const PEOPLE = join(DIR, "household.json");
const ZONES = join(DIR, "zones.json");

const photo = (name, day, time, at, extra = {}) => ({
  uuid: name, name, day, time, taken: `${day}T${time}:00`, place: "",
  model: "Phone D", fav: false, score: 1, bytes: 1000, lat: at.lat, lng: at.lng, ...extra,
});

// Three days. The first and the last hold one photograph at home and one
// away; the middle day is away only.
const photos = [
  photo("out-home.jpg", "2025-06-01", "08:00", HOME),
  photo("out-away.jpg", "2025-06-01", "14:00", AWAY),
  photo("middle.jpg", "2025-06-02", "12:00", AWAY),
  photo("back-away.jpg", "2025-06-03", "10:00", AWAY),
  photo("back-home.jpg", "2025-06-03", "18:00", HOME),
];

function fixture() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "photos.json"), JSON.stringify({ trip: TRIP, photos }, null, 2));
  writeFileSync(PEOPLE, JSON.stringify({
    radiusKm: 150, perDay: 15, homes: [HOME],
    people: { severin: [{ model: "Phone D" }] },
  }, null, 2));
  writeFileSync(ZONES, JSON.stringify([
    { name: "Away-town", lat: AWAY.lat, lng: AWAY.lng, km: 50 },
  ], null, 2));
}

const run = (script, ...extra) => {
  const r = spawnSync(process.execPath, [script, "--trip", TRIP, ...extra], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const kept = () => JSON.parse(readFileSync(join(DIR, "photos.json"), "utf8"));

// ── B1771: home on the first and last day ─────────────────────────────────
{
  fixture();
  const { out } = run(NARROW, "--who", "severin", "--people", PEOPLE);
  const files = kept().photos.map((p) => p.file ?? p.name);
  check("B1771: a photograph taken at home on the first day is left out",
    !files.includes("out-home.jpg"), files.join(", "));
  check("B1771: and on the last day", !files.includes("back-home.jpg"), files.join(", "));
  check("B1771: the ones actually on the trip are kept",
    ["out-away.jpg", "middle.jpg", "back-away.jpg"].every((f) => files.includes(f)), files.join(", "));
  check("B1771: it says how many and on which days", /within 5 km of home/.test(out), out);
}

// ── B1771: --keep-home is how somebody says they meant it ─────────────────
{
  fixture();
  run(NARROW, "--who", "severin", "--people", PEOPLE, "--keep-home");
  const files = kept().photos.map((p) => p.file ?? p.name);
  check("B1771: --keep-home keeps them, and says so",
    files.includes("out-home.jpg") && files.includes("back-home.jpg"), files.join(", "));
}

// ── B1771: no home known is said out loud rather than passing silently ────
{
  fixture();
  writeFileSync(PEOPLE, JSON.stringify({ radiusKm: 150, people: { severin: [{ model: "Phone D" }] } }, null, 2));
  const { out } = run(NARROW, "--who", "severin", "--people", PEOPLE);
  check("B1771: with no home position, the run says the check did not happen",
    /no home position known/.test(out), out);
}

// ── B1770: narrowing again does not undo a blur ───────────────────────────
{
  fixture();
  run(NARROW, "--who", "severin", "--people", PEOPLE);
  run(BLUR, "--zones", ZONES);
  const blurred = kept();
  const coarse = blurred.photos.filter((p) => p.blurred).map((p) => p.lat);
  check("B1770: the blur pinned the away photographs to the zone", coarse.length >= 2, JSON.stringify(coarse));

  const { out } = run(NARROW, "--who", "severin", "--people", PEOPLE);
  const after = kept();
  check("B1770: narrowing again re-applies the blur rather than undoing it",
    after.photos.filter((p) => p.blurred).length === coarse.length, out);
  check("B1770: and the coordinates are still the zone's, not the originals",
    after.photos.every((p) => !p.blurred || p.lat === Math.round(AWAY.lat * 100) / 100),
    JSON.stringify(after.photos.map((p) => [p.name, p.lat])));
  check("B1770: photos.all.json still holds what was really recorded",
    JSON.parse(readFileSync(join(DIR, "photos.all.json"), "utf8")).photos.some((p) => p.lat === AWAY.lat));
}

rmSync(DIR, { recursive: true, force: true });
if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
