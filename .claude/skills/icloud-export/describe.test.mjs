#!/usr/bin/env node
// B1767: the order is export → review → describe → build, and describing
// first is the one order that cannot be undone. Whatever is written from a
// contact sheet outlives the review that turned a photograph off, so a frame
// removed for privacy keeps its sentence. This checks the guard, and that
// `--before-review` still lets somebody mean it.
//
//   node .claude/skills/icloud-export/describe.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIBE = join(HERE, "describe.mjs");
const FIXTURE = join(ROOT, ".claude/skills/shared/fixtures/orientation/orientation-1.jpg");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const TRIP = "b1767-describe-order";
const DIR = join(ROOT, "export", TRIP);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "photos"), { recursive: true });
copyFileSync(FIXTURE, join(DIR, "photos", "one.jpg"));
writeFileSync(join(DIR, "photos.json"), JSON.stringify({ trip: TRIP, photos: [
  { name: "one.jpg", day: "2025-11-16", taken: "2025-11-16T09:00:00", time: "09:00", place: "Basel", fav: false },
] }, null, 2));

const run = (...extra) => {
  // Both streams, because the warning this checks for is a warning.
  const r = spawnSync(process.execPath, [DESCRIBE, "--trip", TRIP, ...extra], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

// ── no review at all ──────────────────────────────────────────────────────
{
  const { code, out } = run();
  check("refuses when nothing has been reviewed, and names the review command",
    code !== 0 && /review\.mjs --trip/.test(out), out);
  check("wrote no sheets", !existsSync(join(DIR, "sheets", "index.json")));
}

// ── a review.json that exists but holds no decisions is the same thing ────
{
  writeFileSync(join(DIR, "review.json"), JSON.stringify({ photos: {}, days: {} }, null, 2));
  const { code } = run();
  check("an empty review.json is not a review", code !== 0);
}

// ── --before-review says the order is deliberate ──────────────────────────
{
  const { code, out } = run("--before-review");
  check("--before-review runs, and says out loud that nothing was reviewed",
    code === 0 && /before-review/.test(out), out);
  check("it made the sheet", existsSync(join(DIR, "sheets", "index.json")));
}

// ── a real review is what the ordinary run wants ──────────────────────────
{
  writeFileSync(join(DIR, "review.json"), JSON.stringify({
    photos: { "one.jpg": { drop: false, note: "", visibility: "" } }, days: {},
  }, null, 2));
  const { code } = run();
  check("a review with decisions in it runs without the flag", code === 0);
}

rmSync(DIR, { recursive: true, force: true });
if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
