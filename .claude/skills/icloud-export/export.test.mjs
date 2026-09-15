#!/usr/bin/env node
// B1772: the export asks osxphotos for `--convert-to-jpeg` and used to trust
// it. 21 of 28 files in one trip landed as .HEIC, and since everything
// downstream filters /\.jpe?g$/i those photographs were invisible rather than
// broken — a fifteen-photograph day became a three-photograph sheet and the
// run said it had succeeded. `--check` is the same post-export pass on an
// export that already happened, which is what this drives.
//
//   node .claude/skills/icloud-export/export.test.mjs
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT = join(HERE, "export.mjs");
const FIXTURE = join(ROOT, ".claude/skills/shared/fixtures/orientation/orientation-1.jpg");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const TRIP = "b1772-what-landed";
const DIR = join(ROOT, "export", TRIP), PHOTOS = join(DIR, "photos");

function fixture(names) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(PHOTOS, { recursive: true });
  writeFileSync(join(DIR, "uuids.txt"), names.map((n, i) => `uuid-${i}`).join("\n") + "\n");
  writeFileSync(join(DIR, "photos.json"), JSON.stringify({ trip: TRIP, photos: names.map((name, i) => ({
    uuid: `uuid-${i}`, name, day: "2025-06-01", time: "09:00", taken: "2025-06-01T09:00:00",
  })) }, null, 2));
}
const run = () => {
  const r = spawnSync(process.execPath, [EXPORT, "--trip", TRIP, "--check"], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

// ── everything arrived, as JPEG ───────────────────────────────────────────
{
  fixture(["one.jpg", "two.jpg"]);
  copyFileSync(FIXTURE, join(PHOTOS, "one.jpg"));
  copyFileSync(FIXTURE, join(PHOTOS, "two.jpg"));
  const { code, out } = run();
  check("an export with everything in it passes", code === 0, out);
}

// ── one never arrived ─────────────────────────────────────────────────────
{
  fixture(["one.jpg", "two.jpg"]);
  copyFileSync(FIXTURE, join(PHOTOS, "one.jpg"));
  const { code, out } = run();
  check("a missing photograph fails the run and is named",
    code !== 0 && /two\.jpg/.test(out), out);
}

// ── one arrived in another format: converted, not left invisible ──────────
{
  fixture(["one.jpg", "two.heic"]);
  copyFileSync(FIXTURE, join(PHOTOS, "one.jpg"));
  // A real HEIC, made from the fixture, so sips has something to convert.
  try {
    execFileSync("sips", ["-s", "format", "heic", FIXTURE, "--out", join(PHOTOS, "two.heic")], { stdio: "ignore" });
  } catch {
    console.log("… sips cannot write HEIC here; skipping the conversion check");
  }
  if (existsSync(join(PHOTOS, "two.heic"))) {
    const { code, out } = run();
    check("a file the export left as HEIC is converted rather than ignored",
      code === 0 && existsSync(join(PHOTOS, "two.jpg")) && !existsSync(join(PHOTOS, "two.heic")), out);
  }
}

rmSync(DIR, { recursive: true, force: true });
if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
