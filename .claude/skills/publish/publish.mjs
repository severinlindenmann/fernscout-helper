#!/usr/bin/env node
// Put what is in content/ onto the instance, creating whatever is missing.
//
//   node publish.mjs --user severin                 the whole journal
//   node publish.mjs --user severin --trip algarve-2026
//   node publish.mjs --user severin --dry-run       say what it would do
//   node publish.mjs --user severin --drafts        write the days, do not publish them
//
// **This is a much smaller program than it was, and that is the point.** v1
// had a door per field — `PATCH .../visibility`, `.../rates`, `.../people`,
// `.../travellers`, `.../tracks`, `PUT .../costs` — so publishing meant
// knowing which of eleven calls wrote which key, and a key nobody had wired up
// was a key that silently never left the folder (B1518 and B1569 are two years
// of exactly that). v2 is document-oriented: the file on disk IS the body, the
// server owns the vocabulary, and this file's whole job is deciding **create
// or correct**, then sending the document it already has.
//
// It asks nothing. Everything it does is decided by comparing what is on disk
// with what the instance already has: a trip that is not there is created, a
// day that is not there is written, a day that is there is corrected, and
// photographs the day names but the instance does not hold are uploaded.
// Running it twice does the same work as running it once.
//
// **Three things it will not do, on purpose.**
//
// 1. **It never invents a decline.** Every optional section must be answered
//    or named in `declined` with a real reason, and that reason is the owner's
//    sentence, written in the folder. A `422 incomplete` is reported with the
//    server's own list of what is open — never papered over with a plausible
//    sentence, which would be a lie with an extra step.
// 2. **It never publishes without the word.** `--drafts` writes and stops;
//    without it, publishing is a separate call per day, and the person has to
//    have said so in this conversation. "It looks finished" is not consent.
// 3. **It sends no number it made up.** The per-day ceiling and the size
//    limits come from `/api/v2/status`; the 40 that used to be written into
//    this file twice was right only on the day somebody typed it.
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { call, limits, refusal, SITE } from "../shared/api.mjs";
import { readJournal, mediaFile } from "../shared/journal.mjs";
import { arg, die, has } from "../shared/lib.mjs";

const user = arg("user");
const onlyTrip = arg("trip");
const dry = has("dry-run");
const draftsOnly = has("drafts");

if (!user) die("usage: node publish.mjs --user <username> [--trip <id>] [--dry-run] [--drafts]");

const journal = readJournal(user);
const say = (line) => console.log(line);
let refused = 0;

/** A refusal, said once, with everything the server offered about how to fix
 * it. The old version printed `problems[]` and threw `missing[]` away, so a
 * real run came back as a bare "422 incomplete_day" with the answer sitting in
 * a body nobody rendered. */
function refuse(result, what) {
  refused += 1;
  say(`  ✗ ${what}\n      ${refusal(result).split("\n").join("\n      ")}`);
  return null;
}

/** What the instance already holds at one address, or null. A `GET` before
 * every write, because v2's `PUT` is create-only: writing over a document that
 * exists is a deliberate act that has to carry the ETag of the version it read
 * (`If-Match`), and a create that finds something there answers 409 rather
 * than overwriting it. */
async function fetchDoc(path) {
  const got = await call("GET", path);
  return got.ok ? { doc: got.body, etag: got.etag } : null;
}

/**
 * Create it, or correct it.
 *
 * One helper for trips and figures, because in v2 they are the same shape of
 * problem: a client-chosen id, a whole document on disk, and a server that
 * tells "new" from "replace" by whether the caller proved it had read what is
 * there.
 *
 * A correction is a `PATCH` rather than a `PUT`: the stored document carries
 * things the folder does not — a published `status`, the width and height the
 * server derived from the bytes at upload — and replacing it wholesale would
 * take those with it.
 */
async function send(path, document, what) {
  const existing = await fetchDoc(path);
  if (dry) {
    say(`  ${existing ? "would correct " : "would create  "} ${what}`);
    return existing?.doc ?? document;
  }
  const result = existing
    ? await call("PATCH", path, { body: document, ifMatch: existing.etag })
    : await call("PUT", path, { body: document });
  if (!result.ok) return refuse(result, what);
  say(`  ${existing ? "corrected    " : "created      "} ${what}`);
  return result.body;
}

/**
 * The photographs a day names that the instance does not hold yet.
 *
 * Matched by the stored name, which — since the folder became a mirror — is
 * the file's own content hash, so "already there" is a question about the
 * bytes rather than about a filename somebody could reuse. That is what B1529
 * was: the old route matched by basename, so a larger re-export of a
 * photograph already sent under the same name was silently skipped, and the
 * fix was 177 hand-driven deletes.
 */
function pendingMedia(day, remote) {
  const held = new Set((remote?.media ?? []).map((item) => item.src));
  return (day.media ?? []).filter((item) => !held.has(item.src));
}

async function uploadMedia(tripId, daySlug, item, maxBytes) {
  const file = mediaFile(journal, item.src);
  if (!file || !existsSync(file)) {
    say(`  ✗ ${item.src} is named by the day and is not on disk`);
    refused += 1;
    return;
  }
  const bytes = statSync(file).size;
  if (maxBytes && bytes > maxBytes) {
    say(`  ✗ ${basename(file)} is ${bytes} bytes and this server takes ${maxBytes}`);
    refused += 1;
    return;
  }
  if (dry) { say(`  would upload   ${item.src}`); return; }

  // `intent.day` attaches the photograph to the day *and* clears a
  // `declined.media` on it in the same call, so no follow-up correction is
  // needed — one of the few places v2 does more than it was asked and is right
  // to. The caption is asked-or-declined like everything else: a photograph
  // published without one says so rather than being given words nobody wrote.
  const form = new FormData();
  form.set("file", new Blob([readFileSync(file)]), basename(file));
  form.set("intent", JSON.stringify({
    kind: "photo",
    trip: tripId,
    day: daySlug,
    ...(item.caption
      ? { caption: item.caption }
      : { declined: { caption: "this photograph was published without a caption" } }),
  }));
  const result = await call("POST", `/api/v2/${user}/media`, { body: form });
  if (!result.ok) { refuse(result, `upload ${item.src}`); return; }
  say(`  uploaded       ${item.src}`);
}

// ── the journal itself ─────────────────────────────────────────────────────
say(`${SITE}  ←  content/${user}`);
if (dry) say("(dry run — nothing is written)");

const { limits: serverLimits } = await limits().catch(() => ({ limits: {} }));
const perDay = serverLimits.itemsPerDay;
const maxImageBytes = serverLimits.imageMaxBytes;
if (perDay) say(`this server takes ${perDay} photographs per day`);

const existingJournal = await fetchDoc(`/api/v2/${user}`);
if (!existingJournal) {
  die(
    `\nNo journal called "${user}" on ${SITE}, and this tool does not create one: ` +
    "POST /api/v2/journals spends a signup token, which is a person's decision and an " +
    "email address they own. Make it first, then run this again.",
  );
}

// ── the figure library ─────────────────────────────────────────────────────
// Journal-wide since v2 (at most ten), and referenced by a trip rather than
// described inside it. They go first: a trip naming a figure that does not
// exist yet is refused.
if (journal.figures.length) say("\nfigures");
for (const figure of journal.figures) {
  if (!figure.document) { say(`  ✗ figures/${figure.id}.json: ${figure.problem}`); refused += 1; continue; }
  await send(`/api/v2/${user}/figures/${figure.id}`, figure.document, `figure ${figure.id}`);
}

// ── the trips ──────────────────────────────────────────────────────────────
for (const trip of journal.trips) {
  if (onlyTrip && trip.id !== onlyTrip) continue;
  say(`\n${trip.id}`);
  if (!trip.trip) { say("  ✗ no trip.json — nothing to send"); refused += 1; continue; }
  if (!trip.trip.document) { say(`  ✗ trip.json: ${trip.trip.problem}`); refused += 1; continue; }

  const tripPath = `/api/v2/${user}/trips/${trip.id}`;
  if (!await send(tripPath, trip.trip.document, `trip ${trip.id}`)) continue;

  for (const entry of trip.entries) {
    if (!entry.document) { say(`  ✗ ${entry.file}: ${entry.problem}`); refused += 1; continue; }
    const dayPath = `${tripPath}/days/${entry.slug}`;
    const remote = await fetchDoc(dayPath);
    // The slug is the filename on disk and the address on the wire; the
    // document itself never carries a second copy of it.
    const day = { ...entry.document, slug: entry.slug };

    if (dry) {
      say(`  ${remote ? "would correct " : "would create  "} day ${entry.slug}`);
    } else {
      const result = remote
        ? await call("PATCH", dayPath, { body: day, ifMatch: remote.etag })
        : await call("PUT", dayPath, { body: day });
      if (!result.ok) { refuse(result, `day ${entry.slug}`); continue; }
      say(`  ${remote ? "corrected    " : "created      "} day ${entry.slug}`);
    }

    const pending = pendingMedia(entry.document, remote?.doc);
    if (perDay && (remote?.doc?.media?.length ?? 0) + pending.length > perDay) {
      say(`  ✗ day ${entry.slug} would hold more than this server's ${perDay} photographs — none were uploaded for it`);
      refused += 1;
      continue;
    }
    for (const item of pending) await uploadMedia(trip.id, entry.slug, item, maxImageBytes);

    // Publishing is the separate call it has always been, and the person has
    // already said the word for this whole run (the skill's own procedure; see
    // AGENTS.md). A day the instance already has on the site is left alone
    // rather than published twice.
    if (draftsOnly || remote?.doc?.status === "published") continue;
    if (dry) { say(`  would publish  day ${entry.slug}`); continue; }
    const published = await call("POST", `${dayPath}/publish`, { body: {} });
    if (!published.ok) { refuse(published, `publish ${entry.slug}`); continue; }
    say(`  published      day ${entry.slug}`);
  }
}

say("");
if (refused) {
  say(
    `${refused} thing(s) were refused. Nothing was invented to get past a refusal — ` +
    "read what the server said above and fix the folder.",
  );
  process.exit(1);
}
say(dry ? "That is the plan. Nothing was written." : "Done.");
