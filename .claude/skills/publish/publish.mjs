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
import { SITE, call, health, refusal, token } from "../shared/api.mjs";
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

/**
 * Fail here, with the instructions, rather than half-way through a journal.
 *
 * Unless a journal is being created: that path starts from an address and a
 * mailed code and ends holding a token of its own, so demanding one first
 * would be asking for the thing this run is about to produce.
 */
const creating = Boolean(arg("email"));
if (!creating) {
  try { token(); } catch (missing) { console.error(missing.message); process.exit(1); }
}

/** What this server will take in an upload — its answer, not a guess here. */
let LIMITS = {};
try { LIMITS = (await health()).doc?.media ?? {}; } catch { LIMITS = {}; }
const journal = readJournal(user);
console.log(`${SITE} · content/${user}${dry ? " · dry run, nothing is sent" : ""}\n`);

// ── 2. the journal itself ──────────────────────────────────────────────────
let status = process.env.FERNSCOUT_TOKEN
  ? await call("GET", `/api/v1/${user}/status`)
  : { ok: false, status: 404, body: null };

/**
 * The journal itself, when there is not one yet.
 *
 * This is the one step that cannot be silent, and the reason is not a design
 * choice here: a new journal is bound to an address somebody owns, and the
 * server mails a six-digit code to it. No script can read their mail.
 *
 * So it is two runs and exactly one question, which is as close to "just
 * publish" as the address check allows:
 *
 *   node publish.mjs --user u --email you@example.com     asks for the code
 *   node publish.mjs --user u --email you@example.com --code 123456
 *
 * Everything after that — the trip, the days, the photographs, the publishing
 * — happens in the same run without asking anything.
 */
if (status.status === 404 || status.status === 401) {
  const email = arg("email");
  const code = arg("code");
  if (!email) {
    console.error(
      `There is no journal called "${user}" on ${SITE} yet.\n\n` +
      "Creating one needs an address you own — a six-digit code goes to it, and no script\n" +
      "can read your mail. Run this again with the address:\n\n" +
      `  node publish.mjs --user ${user} --email <your address>\n\n` +
      "then once more with the code it sends you.",
    );
    process.exit(1);
  }
  if (!code) {
    // A dry run sends nothing, and that has to include this. It used to mail a
    // real six-digit code from a run whose whole promise is "nothing is sent"
    // — a person got a signup mail for a journal nobody had decided to create.
    if (dry) {
      console.log(
        `Would ask ${SITE} to mail a signup code to ${email}, and stop there.\n` +
        "A new journal is bound to an address somebody owns, so that step cannot be\n" +
        "rehearsed. Run without --dry-run when they are ready, then again with --code.",
      );
      process.exit(0);
    }
    const asked = await call("POST", "/api/auth/signup/request", {
      auth: false,
      body: { username: user, email },
    });
    if (!asked.ok) refuse(asked, "POST /api/auth/signup/request");
    console.log(
      `A six-digit code is on its way to ${email}. It works for 30 minutes.\n` +
      "When you have it, run:\n\n" +
      `  node publish.mjs --user ${user} --email ${email} --code <the six digits>\n`,
    );
    process.exit(0);
  }

  const verified = await call("POST", "/api/auth/signup/verify", {
    auth: false,
    body: { username: user, email, code },
  });
  if (!verified.ok) refuse(verified, "POST /api/auth/signup/verify");

  // config.json is the whole description of the journal, so the create call is
  // built from it rather than from anything asked for here.
  const c = journal.config ?? {};
  const made = await call("POST", "/api/v1/journals", {
    headers: { authorization: `Bearer ${verified.body.token}` },
    auth: false,
    body: {
      username: user,
      title: c.title ?? user,
      ...(c.tagline ? { tagline: c.tagline } : {}),
      ownerName: c.owner?.name ?? "",
      ownerNickname: c.owner?.nickname ?? c.owner?.name ?? "",
      visibility: c.visibility ?? "public",
      defaultLocale: c.defaultLocale ?? "en",
      locales: c.locales ?? [c.defaultLocale ?? "en"],
      ...(c.baseCurrency ? { baseCurrency: c.baseCurrency } : {}),
      ...(c.displayCurrencies ? { displayCurrencies: c.displayCurrencies } : {}),
      ...(c.units ? { units: c.units } : {}),
      ...(c.startLocation ? { startLocation: c.startLocation } : {}),
    },
  });
  if (!made.ok) refuse(made, "POST /api/v1/journals");
  note(`created the journal ${user}`);
  console.log(
    `\n  Give this to ${c.owner?.name ?? "them"}, now, in your reply — it signs them in once,\n` +
    `  for 15 minutes, so they can see their own drafts:\n\n      ${made.body.signIn}\n\n` +
    `  And this is the journal's agent token, good for seven days. Keep it out of any file\n` +
    `  in this repository:\n\n      export FERNSCOUT_TOKEN=${made.body.token}\n`,
  );
  process.env.FERNSCOUT_TOKEN = made.body.token;
  status = await call("GET", `/api/v1/${user}/status`);
}

if (!status.ok) refuse(status, `GET /api/v1/${user}/status`);
note(`journal ${user} exists — ${status.body?.trips?.length ?? "?"} trips already there`);

/**
 * The journal's own settings, from config.json.
 *
 * Missed entirely until this was tested end to end: the folder is where a
 * person defines their journal, and the title, the languages and the
 * currencies in it were never sent anywhere. A trip would be created inside a
 * journal still called whatever the signup called it.
 *
 * Two calls, because the server refuses a body naming `features` alongside a
 * profile field — deliberately, so "turn mail off" cannot also rename the
 * journal by accident.
 */
if (journal.config) {
  const profile = {};
  for (const key of ["title", "tagline", "visibility", "startLocation", "units",
                     "locales", "defaultLocale", "displayCurrencies", "manualRates"]) {
    if (journal.config[key] !== undefined) profile[key] = journal.config[key];
  }
  if (Object.keys(profile).length) {
    note(`  ${step(`set the journal's own fields — ${Object.keys(profile).join(", ")}`)}`);
    if (!dry) {
      const patched = await call("PATCH", `/api/v1/${user}/config`, { body: profile });
      if (!patched.ok) refuse(patched, `PATCH /api/v1/${user}/config`);
    }
  }
  const features = Object.fromEntries(
    Object.entries(journal.config.features ?? {})
      .filter(([, value]) => value && typeof value.enabled === "boolean")
      .map(([name, value]) => [name, value.enabled]),
  );
  if (Object.keys(features).length) {
    note(`  ${step(`set features — ${Object.entries(features).map(([k, v]) => `${k}=${v}`).join(", ")}`)}`);
    if (!dry) {
      const patched = await call("PATCH", `/api/v1/${user}/config`, { body: { features } });
      // A capability this server cannot offer is refused, and that is a fact
      // about the server rather than a mistake in the folder: say it and go on.
      if (!patched.ok) {
        console.log(`      note: ${patched.body?.error ?? patched.status} — ${patched.body?.message ?? "features left as they were"}`);
      }
    }
  }
}

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
  //
  // **The slug is the server's to choose, not the filename's.** It is made
  // from the title, and a file called `2026-03-01-tag-eins.md` whose title is
  // "Abfahrt in Basel" becomes `abfahrt-in-basel`. Assuming otherwise sent the
  // photographs to a day that did not exist, and — worse, on a second run —
  // would have written every day again under the name it expected.
  //
  // So: find the day the instance already has by what identifies it to a
  // reader (its date and its title), and take the slug from the answer.
  const listed = await call("GET", `/api/v1/${user}/trips/${trip.id}/days`);
  if (!listed.ok) refuse(listed, `GET …/${trip.id}/days`);
  const already = new Map(
    (listed.body?.days ?? listed.body?.entries ?? []).map((d) => [`${d.date}|${d.title}`, d]),
  );

  for (const entry of trip.entries) {
    const date = entry.data.date ?? entry.fileDate;
    const body = { title: entry.data.title, date, content: entry.body };
    for (const key of ["time", "location", "country", "countryCode", "lat", "lng", "tags", "costs",
                       "transportMode", "transportFrom", "transportTo", "travelScene", "test", "translations"]) {
      if (entry.data[key] !== undefined && entry.data[key] !== null) body[key] = entry.data[key];
    }
    // `without: [costs]` on disk is how a day says it deliberately has none.
    // Over the API that is the field set to false, not a list.
    for (const track of entry.data.without ?? []) body[track] = false;

    const existing = already.get(`${date}|${entry.data.title}`);
    let slug = existing?.slug ?? null;

    if (!slug) {
      note(`  ${step(`write ${entry.file}`)}`);
      if (dry) slug = entry.slug;
      else {
        const made = await call("POST", `/api/v1/${user}/trips/${trip.id}/days`, {
          body: { ...body, idempotency_key: `${trip.id}:${entry.slug}` },
        });
        if (!made.ok) refuse(made, `POST …/days (${entry.file})`);
        slug = made.body.slug;
        note(`      → ${slug}`);
      }
    } else {
      note(`  ${step(`update ${slug}`)}`);
      if (!dry) {
        const patched = await call("PATCH", `/api/v1/${user}/trips/${trip.id}/days/${slug}`, { body });
        if (!patched.ok) refuse(patched, `PATCH …/days/${slug}`);
      }
    }

    // ── the photographs ────────────────────────────────────────────────────
    // The instance's own gallery is the record of what has been sent, so a
    // second run uploads nothing rather than duplicating everything. No local
    // state file to go stale.
    const there = dry ? { ok: false } : await call("GET", `/api/v1/${user}/trips/${trip.id}/days/${slug}`);
    const gallery = (there.ok ? (there.body?.entry?.gallery ?? there.body?.gallery) : null) ?? [];
    const already_uploaded = new Set(gallery.map((item) => basename(String(item.src ?? ""))));
    const pending = (entry.data.gallery ?? [])
      .map((item) => ({ item, file: galleryFile(journal, trip, item.src) }))
      .filter(({ item, file }) => file && !already_uploaded.has(basename(file)) && !String(item.src).startsWith("http"));

    if (pending.length) {
      // The instance's own whole-request ceiling, from /api/health, with a
      // little room left: this is the limit a batch of phone originals meets
      // first, and it was a guess in this file until the server published it.
      const LIMIT = Math.floor((LIMITS.requestMaxBytes ?? 64 * 1024 * 1024) * 0.6);
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
