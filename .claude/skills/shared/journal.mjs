// Reading a journal off disk, exactly as it is written.
//
// Nothing here judges or repairs. It parses, records where every value came
// from, and hands the whole thing over — `validate.mjs` says what is wrong
// with it and `publish.mjs` sends it. Two readers would have drifted; this is
// the one.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./lib.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

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

function readMarkdown(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const { data, body, problems } = parseFrontmatter(text);
  return { path, data, body: body.trim(), problems, text };
}

/** Every file of one journal, parsed. `trips[].entries[]` are in file order. */
export function readJournal(user) {
  const dir = join(CONTENT, user);
  if (!existsSync(dir)) throw new Error(`No such journal: content/${user}`);

  let config = null;
  let configProblem = null;
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (error) { configProblem = error.message; }
  }

  const tripsDir = join(dir, "trips");
  const trips = !existsSync(tripsDir) ? [] : readdirSync(tripsDir)
    .filter((name) => !name.startsWith(".") && statSync(join(tripsDir, name)).isDirectory())
    .sort()
    .map((id) => {
      const tripDir = join(tripsDir, id);
      const entriesDir = join(tripDir, "entries");
      const mediaDir = join(tripDir, "media");
      const entries = !existsSync(entriesDir) ? [] : readdirSync(entriesDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((file) => {
          const parsed = readMarkdown(join(entriesDir, file));
          // The filename is the day's identity: the date orders it and the
          // slug addresses it. A frontmatter date that disagrees is a real
          // problem, and the validator says so — this only records both.
          const match = file.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
          return { ...parsed, file, fileDate: match?.[1] ?? null, slug: match?.[2] ?? file.replace(/\.md$/, "") };
        });
      const mediaFolders = !existsSync(mediaDir) ? [] : readdirSync(mediaDir)
        .filter((name) => !name.startsWith(".") && statSync(join(mediaDir, name)).isDirectory());
      return {
        id,
        dir: tripDir,
        trip: readMarkdown(join(tripDir, "trip.md")),
        costs: readMarkdown(join(tripDir, "costs.md")),
        plan: readMarkdown(join(tripDir, "plan.md")),
        entries,
        mediaDir,
        mediaFolders,
      };
    });

  return { user, dir, config, configPath, configProblem, trips };
}

/**
 * The file a `gallery:` src points at.
 *
 * `src` is a URL as the site serves it — `/media/<trip>/<day>/01.jpg` — and on
 * disk that is `trips/<trip>/media/<day>/01.jpg`. Resolving it is the only way
 * to answer whether the photograph is actually there, which is the check a
 * server cannot make for a folder it has never seen.
 */
export function galleryFile(journal, trip, src) {
  if (typeof src !== "string") return null;
  const match = src.match(/^\/media\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return join(journal.dir, "trips", match[1], "media", match[2]);
}
