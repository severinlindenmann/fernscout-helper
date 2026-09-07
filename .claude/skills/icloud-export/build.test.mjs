#!/usr/bin/env node
// A real photograph through `build.mjs`, and a look at what came out. B645:
// the rotation itself (`bakeOrientation()`, build.mjs:46-68) was fixed and
// committed with nothing running it — validate-content's fixtures check
// journals, never photographs, so a phone held sideways published nine
// pictures lying on their side and nothing here noticed.
//
//   node .claude/skills/icloud-export/build.test.mjs
//
// Eight fixtures under shared/fixtures/orientation/, one per EXIF
// `Orientation` value (1 = already upright, the control). Each is a raw
// image with the pixels a phone actually wrote plus the tag saying how to
// turn them: an as-shot copy of one 300×400 portrait, tagged 2 through 8 —
// see the generation notes at the bottom of this file if they ever need to
// be regenerated. `build.mjs` is run for real, end to end, so this fails the
// moment `bakeOrientation()` — or the call to it — goes missing, not a
// reimplementation of what it does.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(ROOT, ".claude/skills/shared/fixtures/orientation");
const BUILD = join(HERE, "build.mjs");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// `bakeOrientation` swallows a missing `exiftool` with a bare `catch { return }`
// — safe, but silently back to the old, sideways behaviour. A selftest that
// quietly skips on the same absence is the same bug wearing a different hat.
for (const tool of ["exiftool", "sips"]) {
  try {
    execFileSync(tool, tool === "exiftool" ? ["-ver"] : ["--help"], { stdio: "ignore" });
  } catch {
    console.log(`✗ ${tool} is not installed — the orientation fixtures cannot be checked, and neither can a real export on this machine.`);
    process.exit(1);
  }
}

const TRIP = "b645-orientation-fixture";
const USER = "b645-fixture-user";
const EXPORT_DIR = join(ROOT, "export", TRIP);
const CONTENT_DIR = join(ROOT, "content", USER);

rmSync(EXPORT_DIR, { recursive: true, force: true });
rmSync(CONTENT_DIR, { recursive: true, force: true });
mkdirSync(join(EXPORT_DIR, "photos"), { recursive: true });

// Orientation 1 needs no turn at all — a fixture with nothing wrong is the
// control that proves the other seven are being changed for orientation and
// not by accident.
const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const photos = ORIENTATIONS.map((n, i) => {
  const file = `orientation-${n}.jpg`;
  copyFileSync(join(FIXTURES, file), join(EXPORT_DIR, "photos", file));
  return {
    name: file, day: "2025-01-01",
    // Sorted order in build.mjs is by `taken`, so this fixes which numbered
    // output file (01.jpg, 02.jpg, …) each orientation becomes.
    taken: `2025-01-01T10:${String(i + 1).padStart(2, "0")}:00`,
    time: `10:${String(i + 1).padStart(2, "0")}`,
    place: "Fixturetown", fav: false,
  };
});
writeFileSync(join(EXPORT_DIR, "photos.json"), JSON.stringify({ trip: TRIP, photos }, null, 2));
writeFileSync(join(EXPORT_DIR, "review.json"), JSON.stringify({ photos: {}, days: {} }, null, 2));

try {
  // `--max-edge` at the fixtures' own largest edge: sips's `-Z` box-fits an
  // image, scaling *up* as readily as down, and the resize is not what this
  // test is checking — a fixture scaled to 2000px either way is still
  // 300:400 portrait-or-landscape depending on orientation, and the point
  // here is that it must always come out portrait.
  execFileSync(process.execPath, [BUILD, "--trip", TRIP, "--user", USER, "--max-edge", "400"], { stdio: "pipe" });
} catch (failure) {
  console.log(`✗ build.mjs failed to run: ${failure.stderr?.toString() ?? failure.message}`);
  process.exit(1);
}

const mediaDir = join(CONTENT_DIR, "trips", TRIP, "media", "fixturetown");
const written = existsSync(mediaDir) ? readdirSync(mediaDir).sort() : [];
check(`build.mjs wrote all ${ORIENTATIONS.length} fixtures`, written.length === ORIENTATIONS.length,
  `found ${written.length}: ${written.join(", ")}`);

for (let i = 0; i < ORIENTATIONS.length; i++) {
  const n = ORIENTATIONS[i];
  const file = join(mediaDir, `${String(i + 1).padStart(2, "0")}.jpg`);
  if (!existsSync(file)) { check(`orientation ${n}: file exists`, false); continue; }

  const dim = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(dim.match(re)?.[1] ?? 0));
  // Every fixture is the same 3:4 portrait as shot — a phone held sideways
  // still means a portrait picture, and this is the check that failed
  // silently for nine of them: a portrait published as landscape.
  check(`orientation ${n}: displayed portrait (300×400), not ${w}×${h}`, w === 300 && h === 400);

  const orientation = execFileSync("exiftool", ["-Orientation", "-n", "-s3", file], { encoding: "utf8" }).trim();
  check(`orientation ${n}: no Orientation tag survives (a phone's GPS must not either)`, orientation === "");
}

rmSync(EXPORT_DIR, { recursive: true, force: true });
rmSync(CONTENT_DIR, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} orientation check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

// ── regenerating the fixtures ────────────────────────────────────────────
//
// Each is an as-shot copy of one 300×400 portrait, red with a blue top
// stripe (so a wrong rotation would be visible to a person, even though
// this test only checks dimensions and the tag). Orientation 1 is that
// image untouched; 2–8 are it pre-transformed by the *inverse* of Pillow's
// own `exif_transpose` table, then tagged with `exiftool -Orientation=N`,
// so that applying the real orientation semantics gets back to the
// original — exactly what `bakeOrientation()` is supposed to do:
//
//   python3 -c "
//   from PIL import Image
//   W, H = 300, 400
//   canonical = Image.new('RGB', (W, H), (255, 0, 0))
//   for y in range(H // 4):
//       for x in range(W):
//           canonical.putpixel((x, y), (0, 0, 255))
//   canonical.save('orientation-1.jpg', quality=90)
//   INVERSE = {
//       2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
//       4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
//       6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE,
//       8: Image.Transpose.ROTATE_270,
//   }
//   for n, inv in INVERSE.items():
//       canonical.transpose(inv).save(f'orientation-{n}.jpg', quality=90)
//   "
//   for n in 2 3 4 5 6 7 8; do exiftool -overwrite_original -Orientation=$n -n orientation-$n.jpg; done
