#!/usr/bin/env node
// Put what is in content/ onto the instance, creating whatever is missing.
//
//   node publish.mjs --user severin                 the whole journal
//   node publish.mjs --user severin --trip algarve-2026
//   node publish.mjs --user severin --dry-run       say what it would do
//   node publish.mjs --user severin --drafts        write the days, do not publish them
//
// It asks nothing. Everything it does is decided by comparing what is on disk
// with what the instance already has: a trip that is not there is created, a
// day that is not there is written, a day that is there is patched, and
// photographs that are not on the day yet are sent. Running it twice does the
// same work as running it once.
//
// **It refuses to start while `validate.mjs` reports an error.** Publishing
// content the instance will partly reject leaves a journal half-written, which
// is worse than not starting — and the errors are cheap to read first.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, has } from "../shared/lib.mjs";
import { SITE, call, refusal, token } from "../shared/api.mjs";
import { galleryFile, readJournal } from "../shared/journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const user = arg("user");
const only = arg("trip");
const dry = has("dry-run");
const draftsOnly = has("drafts");

if (!user) {
  console.error("Which journal? node publish.mjs --user <username>");
  process.exit(1);
}

const did = [];
const note = (line) => { did.push(line); console.log(line); };
const step = (what) => (dry ? `would ${what}` : what);

/** Stop on anything the instance refused. A half-written journal is the one
 * outcome worse than not starting. */
function refuse(result, what) {
  console.error(`\n✗ ${what}\n      ${refusal(result).replace(/\n/g, "\n")}`);
  console.error("\nNothing further was sent. Fix the above and run again — what already landed stays.");
  process.exit(1);
}

// ── 1. the content has to be right before any of it is sent ────────────────
if (!has("skip-validate")) {
  try {
    execFileSync(process.execPath, [join(HERE, "../validate-content/validate.mjs"), "--user", user], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error(
      "validate.mjs reports errors, so nothing was sent.\n" +
      `Run:  node .claude/skills/validate-content/validate.mjs --user ${user}\n` +
      "Fix what it marks ✗ and run this again. (--skip-validate overrides, and is almost never right.)",
    );
    process.exit(1);
  }
}

// Fail here, with the instructions, rather than half-way through a journal.
try { token(); } catch (missing) { console.error(missing.message); process.exit(1); }
const journal = readJournal(user);
console.log(`${SITE} · content/${user}${dry ? " · dry run, nothing is sent" : ""}\n`);

// ── 2. the journal itself ──────────────────────────────────────────────────
const status = await call("GET", `/api/v1/${user}/status`);
if (status.status === 404) {
  console.error(
    `There is no journal called "${user}" on ${SITE}, and creating one needs an address you own —\n` +
    "a six-digit code goes to it, and a script cannot read your mail. Two calls:\n\n" +
    `  curl -s -X POST ${SITE}/api/auth/signup/request -H 'content-type: application/json' \\\n` +
    `       -d '{"username":"${user}","email":"<your address>"}'\n` +
    `  curl -s -X POST ${SITE}/api/auth/signup/verify -H 'content-type: application/json' \\\n` +
    `       -d '{"username":"${user}","email":"<your address>","code":"123456"}'\n\n` +
    "then POST /api/v1/journals with the token that comes back, and run this again.",
  );
  process.exit(1);
}
if (!status.ok) refuse(status, `GET /api/v1/${user}/status`);
note(`journal ${user} exists — ${status.body?.trips?.length ?? "?"} trips already there`);

// ── 3. each trip ───────────────────────────────────────────────────────────
const remote = await call("GET", `/api/v1/${user}/trips`);
if (!remote.ok) refuse(remote, `GET /api/v1/${user}/trips`);
const existing = new Set((remote.body?.trips ?? []).map((t) => t.id));

for (const trip of journal.trips) {
  if (only && trip.id !== only) continue;
  const data = trip.trip?.data ?? {};
  console.log(`\n── ${trip.id}`);

  if (!existing.has(trip.id)) {
    // Everything trip.md carries, in one call. The body is the intro.
    const body = { id: trip.id, title: data.title, start: data.start, end: data.end };
    for (const key of ["tagline", "status", "accent", "visibility", "listed", "costsVisibility",
                       "test", "people", "travellers", "rates", "tracks", "translations"]) {
      if (data[key] !== undefined && data[key] !== null) body[key] = data[key];
    }
    if (trip.trip?.body) body.intro = trip.trip.body;
    note(`  ${step("create the trip")}`);
    if (!dry) {
      const made = await call("POST", `/api/v1/${user}/trips`, { body });
      if (!made.ok) refuse(made, `POST /api/v1/${user}/trips (${trip.id})`);
    }
  } else {
    note("  trip is already there");
    // The one-field doors, for a trip that existed before this run.
    if (data.visibility !== undefined || data.listed !== undefined) {
      const body = {};
      if (data.visibility !== undefined) body.visibility = data.visibility;
      if (data.listed !== undefined) body.listed = data.listed;
      note(`  ${step(`set visibility ${JSON.stringify(body)}`)}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/visibility`, { body });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/visibility`);
      }
    }
    if (data.rates && Object.keys(data.rates).length) {
      note(`  ${step("set the trip's rates")}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/rates`, { body: { rates: data.rates } });
        if (!patched.ok) refuse(patched, `PATCH …/${trip.id}/rates`);
      }
    }
  }

  // ── the budget and the costs paid before leaving ─────────────────────────
  if (trip.costs) {
    const body = {};
    if (trip.costs.data.budget) body.budget = trip.costs.data.budget;
    if (trip.costs.data.costs) body.costs = trip.costs.data.costs;
    if (trip.costs.body) body.body = trip.costs.body;
    note(`  ${step(`put costs.md — ${body.costs?.length ?? 0} lines${body.budget ? " and a budget" : ""}`)}`);
    if (!dry) {
      const put = await call("PUT", `/api/v1/${user}/trips/${trip.id}/costs`, { body });
      if (!put.ok) refuse(put, `PUT …/${trip.id}/costs`);
    }
  }

  // ── the days ─────────────────────────────────────────────────────────────
  for (const entry of trip.entries) {
    const slug = entry.slug;
    const there = await call("GET", `/api/v1/${user}/trips/${trip.id}/days/${slug}`);
    const body = { title: entry.data.title, date: entry.data.date ?? entry.fileDate, content: entry.body };
    for (const key of ["time", "location", "country", "countryCode", "lat", "lng", "tags", "costs",
                       "transportMode", "transportFrom", "transportTo", "travelScene", "test", "translations"]) {
      if (entry.data[key] !== undefined && entry.data[key] !== null) body[key] = entry.data[key];
    }
    // `without: [costs]` on disk is how a day says it deliberately has none.
    // Over the API that is the field set to false, not a list.
    for (const track of entry.data.without ?? []) body[track] = false;

    if (there.status === 404) {
      note(`  ${step(`write ${slug}`)}`);
      if (!dry) {
        const made = await call("POST", `/api/v1/${user}/trips/${trip.id}/days`, {
          body: { ...body, idempotency_key: `${trip.id}:${slug}` },
        });
        if (!made.ok) refuse(made, `POST …/days (${slug})`);
      }
    } else if (there.ok) {
      note(`  ${step(`update ${slug}`)}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/days/${slug}`, { body });
        if (!patched.ok) refuse(patched, `PATCH …/days/${slug}`);
      }
    } else refuse(there, `GET …/days/${slug}`);

    // ── the photographs ────────────────────────────────────────────────────
    // The instance's own gallery is the record of what has been sent, so a
    // second run uploads nothing rather than duplicating everything. No local
    // state file to go stale.
    const already = new Set(
      ((there.ok ? there.body?.entry?.gallery : null) ?? []).map((item) => basename(String(item.src ?? ""))),
    );
    const pending = (entry.data.gallery ?? [])
      .map((item) => ({ item, file: galleryFile(journal, trip, item.src) }))
      .filter(({ item, file }) => file && !already.has(basename(file)) && !String(item.src).startsWith("http"));

    if (pending.length) {
      // 64 MB is the whole-request ceiling; batch well under it.
      const LIMIT = 40 * 1024 * 1024;
      let batch = [], size = 0;
      const batches = [];
      for (const one of pending) {
        const bytes = statSync(one.file).size;
        if (batch.length && size + bytes > LIMIT) { batches.push(batch); batch = []; size = 0; }
        batch.push(one); size += bytes;
      }
      if (batch.length) batches.push(batch);

      note(`  ${step(`send ${pending.length} file${pending.length === 1 ? "" : "s"} for ${slug}`)}` +
           (batches.length > 1 ? ` in ${batches.length} batches` : ""));
      if (!dry) {
        for (const group of batches) {
          const form = new FormData();
          form.set("day", slug);
          for (const { item, file } of group) {
            form.append("files", new Blob([readFileSync(file)]), basename(file));
            form.append("captions", item.caption ?? "");
          }
          const sent = await call("POST", `/api/v1/${user}/trips/${trip.id}/media`, { body: form });
          if (!sent.ok) refuse(sent, `POST …/media (${slug})`);
        }
      }
    }

    // ── on the site ────────────────────────────────────────────────────────
    if (!draftsOnly) {
      note(`  ${step(`publish ${slug}`)}`);
      if (!dry) {
        const live = await call("POST", `/api/v1/${user}/trips/${trip.id}/days/${slug}/publish`);
        // Already published is not a failure — this run is meant to be repeatable.
        if (!live.ok && live.status !== 409) refuse(live, `POST …/days/${slug}/publish`);
      }
    }
  }
}

console.log(
  `\n${dry ? "Dry run — nothing was sent." : `Done. ${did.length} steps.`}` +
  (draftsOnly ? "\nThe days are drafts. Publish them with a run without --drafts." : "") +
  `\n${SITE}/${user}`,
);
