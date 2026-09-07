#!/usr/bin/env node
// B646: the review page has to preview the picture that actually gets
// published, not the original. `review.mjs` builds that derivative with
// `ensureBaked()` (shared/bake.mjs) before it ever serves a thumbnail or a
// `/full/` request; `build.mjs` copies the very same file into `content/`.
// Spinning up `review.mjs`'s real HTTP server here would also open a real
// browser tab (`execFileSync("open", …)` on listen) — not something a
// selftest should do on every run — so this checks the two halves that
// matter without that: the shared derivative itself is correct (using the
// exact function review.mjs calls), and that `review.mjs`'s source still
// serves both `/img/` and `/full/` from it rather than from the original.
//
//   node .claude/skills/icloud-export/review.test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";
import { ensureBaked } from "./bake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// ── the source still wires both endpoints through the shared derivative ────
const reviewSrc = readFileSync(join(HERE, "review.mjs"), "utf8");
check("review.mjs bakes photos before serving them (ensureBaked is called)",
  /ensureBaked\(/.test(reviewSrc));
check("review.mjs's /full/ is read from the baked derivative, not the original PHOTOS dir",
  /url\.startsWith\("\/full\/"\)[\s\S]{0,300}baked\.get/.test(reviewSrc));
check("review.mjs's thumbnails are made from the baked derivative, not the original PHOTOS dir",
  /sips.*-Z.*500[\s\S]{0,40}baked\.get|baked\.get[\s\S]{0,120}--out.*THUMBS|files\.map\(\(f\) => baked\.get\(f\)\)/.test(reviewSrc));

// ── the derivative itself: sideways in, upright out, same file build.mjs uses ─
const TRIP = "b646-preview-fixture";
const USER = "b646-fixture-user";
const EXPORT_DIR = join(ROOT, "export", TRIP);
const CONTENT_DIR = join(ROOT, "content", USER);
rmSync(EXPORT_DIR, { recursive: true, force: true });
rmSync(CONTENT_DIR, { recursive: true, force: true });
mkdirSync(join(EXPORT_DIR, "photos"), { recursive: true });

const FIXTURE = join(ROOT, ".claude/skills/shared/fixtures/orientation/orientation-6.jpg"); // a 90°-sideways original
const file = "sideways.jpg";
copyFileSync(FIXTURE, join(EXPORT_DIR, "photos", file));
writeFileSync(join(EXPORT_DIR, "photos.json"), JSON.stringify({
  trip: TRIP, photos: [{ name: file, day: "2025-01-01", taken: "2025-01-01T10:00:00", time: "10:00", place: "Fixturetown", fav: false }],
}, null, 2));
writeFileSync(join(EXPORT_DIR, "review.json"), JSON.stringify({ photos: {}, days: {} }, null, 2));

// The exact call review.mjs makes on startup, at the exact default size build.mjs uses.
const bakedFromReview = ensureBaked(EXPORT_DIR, join(EXPORT_DIR, "photos"), file);
const dim = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", bakedFromReview], { encoding: "utf8" });
const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((re) => Number(dim.match(re)?.[1] ?? 0));
check("the derivative review.mjs would preview is upright (portrait, not landscape)", w < h, `${w}×${h}`);

execFileSync(process.execPath, [join(HERE, "build.mjs"), "--trip", TRIP, "--user", USER], { stdio: "pipe" });
const publishedDirs = execFileSync("find", [join(CONTENT_DIR, "trips", TRIP, "media"), "-name", "*.jpg"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
check("build.mjs published exactly one photo", publishedDirs.length === 1, publishedDirs.join(", "));
if (publishedDirs.length === 1) {
  const published = readFileSync(publishedDirs[0]);
  const baked = readFileSync(bakedFromReview);
  check("the published photo is byte-for-byte what the review page already baked (one derivative, not two)",
    Buffer.compare(published, baked) === 0);
}

rmSync(EXPORT_DIR, { recursive: true, force: true });
rmSync(CONTENT_DIR, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} preview check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
