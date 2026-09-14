// Reading a journal off disk, exactly as it is written.
//
// Nothing here judges or repairs. It parses, records where every value came
// from, and hands the whole thing over — `validate.mjs` says what is wrong
// with it and `publish.mjs` sends it. Two readers would have drifted; this is
// the one.
//
// **The folder holds the instance's own documents, since B1715.** It used to
// hold Markdown with frontmatter — `trip.md`, `costs.md`, `plan.md`,
// `entries/<slug>.md` — and the instance stored JSON, so these tools spent
// their lives translating between two shapes. That is what made a first sync
// plan `{pull: 778, push: 419}` with *zero* paths in common: every day would
// have been pulled as `.json` and pushed as `.md`, every photograph pulled
// under its content hash and pushed under its local number. One shape ends
// that by construction:
//
//   content/<user>/config.json
//   content/<user>/figures/<id>.json
//   content/<user>/trips/<trip>/trip.json            costs and plan are sections of it
//   content/<user>/trips/<trip>/entries/<YYYY-MM-DD-slug>.json
//   content/<user>/trips/<trip>/media/<day-slug>/<hash>.<ext>  + .meta.json sidecars
//   content/<user>/trips/<trip>/originals/<day-slug>/<name>    the print masters
//
// A folder written by the old tools is converted once — `node
// .claude/skills/shared/convert.mjs <user>` — rather than read by a second
// parser kept alive here forever. `frontmatter.mjs` survives for exactly that
// conversion, and for nothing else.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "./lib.mjs";

// `content/` is where a real person's journal lives, and it is gitignored —
// correctly, since it is somebody's photographs. `selftest.mjs` needs fixture
// journals that DO travel with the repository, so it points this at
// `.claude/skills/shared/fixtures/` instead by setting this one variable
// before it shells out to `validate.mjs`. Nothing else ever sets it, so a real
// run against `content/` is unaffected.
export const CONTENT = process.env.FERNSCOUT_CONTENT_DIR
  ? resolve(process.env.FERNSCOUT_CONTENT_DIR)
  : join(ROOT, "content");

export function usernames() {
  if (!existsSync(CONTENT)) return [];
  return readdirSync(CONTENT).filter(
    (name) => !name.startsWith(".") && statSync(join(CONTENT, name)).isDirectory(),
  );
}

/** A real journal on disk has both — a `config.json` and a `trips/`
 * directory. B1402: the marker two other checks already use (validate.mjs's
 * own "has no config.json" error, and its trip loop), pulled out once so the
 * "did you mean" heuristic below cannot drift from what "is a journal"
 * means anywhere else in these tools. `usernames()` itself stays as
 * permissive as before — a brand new journal with no trips/ yet is still a
 * real username — this is only for telling "CONTENT holds journals" apart
 * from "CONTENT holds nothing of the kind".
 */
export function isJournalShaped(dir) {
  return existsSync(join(dir, "config.json")) &&
    existsSync(join(dir, "trips")) && statSync(join(dir, "trips")).isDirectory();
}

/**
 * When nothing directly under CONTENT looks like a journal, the likely story
 * is almost always a path that is one level off, in one direction or the
 * other:
 *
 *   - too shallow — pointed at the folder *above* where the journals live,
 *     so what CONTENT actually holds is one directory (often "content"
 *     itself) that in turn holds the real usernames.
 *   - too deep (the mirror case, B1402) — pointed at one journal's own
 *     folder, so CONTENT itself is what looks like a journal.
 *
 * Named by finding an actual journal-shaped directory nearby rather than
 * guessed at from a hardcoded basename like "content" — a person's own
 * layout does not have to be called that for this to still work. `null`
 * when neither holds, which leaves the caller to say what it already says
 * today.
 */
export function suggestedContentDir() {
  if (isJournalShaped(CONTENT)) return dirname(CONTENT);
  for (const name of usernames()) {
    const at = join(CONTENT, name);
    const inside = existsSync(at) && readdirSync(at).some(
      (child) => !child.startsWith(".") && statSync(join(at, child)).isDirectory() && isJournalShaped(join(at, child)),
    );
    if (inside) return at;
  }
  return null;
}

/**
 * One JSON document, with the parse failure kept rather than thrown.
 *
 * A file that will not parse is a real thing to report — half-written by a
 * killed run, hand-edited into garbage — and it must not take the rest of the
 * journal down with it. `document` is null exactly when `problem` is not.
 */
export function readDocument(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  try {
    return { path, document: JSON.parse(text), problem: null, text };
  } catch (error) {
    return { path, document: null, problem: error.message, text };
  }
}

/** Files that are documents rather than the directory's furniture. Sidecars
 * (`<name>.jpg.meta.json`) are the instance's own notes about a photograph,
 * not documents in their own right, and are read through `mediaSidecar`. */
function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith(".") && !f.includes(".meta."))
    .sort();
}

function directories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory());
}

/** Every file of one journal, parsed. `trips[].entries[]` are in file order,
 * which for a day is date order: the filename begins with its date. */
export function readJournal(user) {
  const dir = join(CONTENT, user);
  if (!existsSync(dir)) throw new Error(`No such journal: content/${user}`);

  const configPath = join(dir, "config.json");
  const configRead = readDocument(configPath);

  // The journal-wide figure library (at most ten) — v1 described who was on a
  // trip inline on the trip itself; v2 names figures created once for the
  // journal and referenced from a trip. One file per figure, named by its id.
  const figuresDir = join(dir, "figures");
  const figures = jsonFiles(figuresDir).map((file) => ({
    id: file.replace(/\.json$/, ""),
    ...readDocument(join(figuresDir, file)),
  }));

  const tripsDir = join(dir, "trips");
  const trips = directories(tripsDir).sort().map((id) => {
    const tripDir = join(tripsDir, id);
    const entriesDir = join(tripDir, "entries");
    const mediaDir = join(tripDir, "media");
    const originalsDir = join(tripDir, "originals");

    const entries = jsonFiles(entriesDir).map((file) => {
      const read = readDocument(join(entriesDir, file));
      // The filename is the day's identity, and in v2 it IS the slug:
      // `2026-08-26-hoi-an.json` is the day at `.../days/2026-08-26-hoi-an`.
      // The date is its first three segments, and a `date` inside the
      // document that disagrees is a real problem the validator reports —
      // this only records both.
      const slug = file.replace(/\.json$/, "");
      const match = slug.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      return { ...read, file, slug, fileDate: match?.[1] ?? null, bareSlug: match?.[2] ?? slug };
    });

    return {
      id,
      dir: tripDir,
      trip: readDocument(join(tripDir, "trip.json")),
      entries,
      mediaDir,
      mediaFolders: directories(mediaDir),
      originalsDir,
      originalFolders: directories(originalsDir),
    };
  });

  return {
    user,
    dir,
    config: configRead?.document ?? null,
    configPath,
    configProblem: configRead?.problem ?? null,
    figures,
    trips,
  };
}

/**
 * The file a day's media `src` points at.
 *
 * `src` is a URL as the site serves it —
 * `/media/<trip>/<day-slug>/<hash>.jpg` — and on disk that is
 * `trips/<trip>/media/<day-slug>/<hash>.jpg`. Resolving it is the only way to
 * answer whether the photograph is actually there, which is the check a server
 * cannot make for a folder it has never seen.
 */
export function mediaFile(journal, src) {
  if (typeof src !== "string") return null;
  const match = src.match(/^\/media\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return join(journal.dir, "trips", match[1], "media", match[2]);
}

/** The sidecar the instance writes beside a stored photograph — what the file
 * was called before it was renamed to its hash, its dimensions, its type. Read
 * when it is there and simply absent when it is not; nothing is inferred from
 * its absence. */
export function mediaSidecar(file) {
  const read = readDocument(`${file}.meta.json`);
  return read?.document ?? null;
}
