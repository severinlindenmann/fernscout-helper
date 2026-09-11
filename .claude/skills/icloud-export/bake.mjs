// The one place an original photograph ever becomes what gets served: resized,
// turned upright, stripped of metadata. `review.mjs`'s preview and
// `build.mjs`'s published copy both read the file this writes — nothing else
// runs `sips`/`exiftool` on somebody's photograph — so what a person approves
// on the review page is the picture that actually goes out. B646: before this,
// each ran its own resize (or none), and only `build.mjs` turned the pixels,
// so an original held sideways looked fine in review and wrong on the site.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The one size every derivative is built at — review page and published copy
 * alike, because B646 says there is exactly one derivative and the test above
 * this file checks it byte for byte.
 *
 * B1529: this was 2000, chosen to match what a Fernscout instance serves —
 * which sounds right and is exactly backwards. The instance makes its own
 * 2000px copy for the web and keeps what it is sent **untouched, as the print
 * master**; `skill/ingest-photos.md` says so and then says "send the largest
 * file you have". Baking to 2000 first saved nothing the server was not going
 * to do anyway, and quietly made every photobook print from a web-sized file:
 * about 170 dpi on an A4 plate, against the 300 the format is built for.
 *
 * 4000 clears the 2500×3500 a full-page plate wants at 300 dpi. It costs the
 * review page some disk and a slower first run — the honest price of one
 * derivative rather than two, and cheaper than a print nobody can redo.
 * `--max-edge` overrides it; the instance's ceiling is 8000px and 50 MB an
 * image, published in /api/health.
 */
export const DEFAULT_MAX_EDGE = 4000;

// EXIF Orientation, turned into real pixels. The eight values are the standard
// ones; sips rotates clockwise, and a flip has to come before the rotation.
const ORIENTATION = {
  2: { flip: "horizontal" },
  3: { rotate: 180 },
  4: { flip: "vertical" },
  5: { flip: "horizontal", rotate: 270 },
  6: { rotate: 90 },
  7: { flip: "horizontal", rotate: 90 },
  8: { rotate: 270 },
};

export function bakeOrientation(file) {
  let value;
  try {
    value = Number(execFileSync("exiftool", ["-Orientation", "-n", "-s3", file],
                                { encoding: "utf8" }).trim());
  } catch { return; }                      // no exiftool reading, no turn to make
  const turn = ORIENTATION[value];
  if (!turn) return;                       // 1, or nothing written at all
  if (turn.flip) execFileSync("sips", ["-f", turn.flip, file], { stdio: "ignore" });
  if (turn.rotate) execFileSync("sips", ["-r", String(turn.rotate), file], { stdio: "ignore" });
}

/** Cached per max-edge, since the derivative differs by size — see `ensureBaked`. */
export function bakedPath(dir, file, maxEdge = DEFAULT_MAX_EDGE) {
  return join(dir, "baked", String(maxEdge), file);
}

/**
 * The derivative for one photo, built once and reused. Rebuilt only when
 * missing or older than the original — a re-export replacing a file — so a
 * long review session does not repeat work on every restart.
 */
export function ensureBaked(dir, photosDir, file, maxEdge = DEFAULT_MAX_EDGE) {
  const dest = bakedPath(dir, file, maxEdge);
  const src = join(photosDir, file);
  if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  // `high` rather than sips' default: one flag, a few percent more bytes, and
  // it is the difference between a photograph that survives being looked at
  // full-screen and one that does not. The derivative is written once.
  execFileSync("sips", ["-Z", String(maxEdge), "-s", "formatOptions", "high", dest],
               { stdio: "ignore" });
  // A phone that was held sideways writes upright pixels plus an Orientation
  // tag saying how to turn them. Stripping the tag below would leave the
  // picture lying on its side for good, so the turn is baked into the pixels
  // first — a photograph nobody can read is not a photograph.
  bakeOrientation(dest);
  // Served pictures carry no metadata: a phone writes the coordinates of
  // somebody's front door into the file. They live in the frontmatter instead,
  // where they can be seen and deleted.
  execFileSync("exiftool", ["-all=", "-overwrite_original", dest], { stdio: "ignore" });
  return dest;
}
