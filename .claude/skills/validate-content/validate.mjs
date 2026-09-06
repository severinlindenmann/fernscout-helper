#!/usr/bin/env node
// Check a journal on disk against the instance that will receive it.
//
//   node validate.mjs                       every journal in content/
//   node validate.mjs --user severin        one of them
//   node validate.mjs --trip algarve-2026   one trip
//   node validate.mjs --json                for another program to read
//   node validate.mjs --offline             use the cached schema, no network
//
// Three severities, and the difference matters:
//
//   error  the instance will refuse this, or the site cannot read it.
//   warn   it will be accepted and is probably not what anybody meant.
//   tip    an option that exists and is not set. Never a defect.
//
// It reports. It changes nothing — not the files, not the instance. Half of
// what it finds is a question for a person ("no costs on seven days"), and an
// agent that quietly fixed those would be inventing what happened.
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { arg, has } from "../shared/lib.mjs";
import { COST_KEYS, GALLERY_KEYS, MODEL, crosscheck } from "../shared/model.mjs";
import { galleryFile, readJournal, usernames } from "../shared/journal.mjs";
import { deref, health, openapi, requestSchema } from "../shared/api.mjs";

const found = [];
const say = (severity, where, message, fix, key) => found.push({ severity, where, message, fix, key });

/**
 * Fields already reported as an error in a given file, so the tip for the same
 * field is not printed beside it. "costs is not set" under "the trip tracks
 * costs and this day says nothing about it" is the same sentence twice, and
 * the second one makes the first look like advice rather than a refusal.
 */
const errored = new Set();
const error = (w, m, f) => say("error", w, m, f);
const warn = (w, m, f) => say("warn", w, m, f);
const tip = (w, m, f, key) => say("tip", w, m, f, key);

/** The key somebody probably meant. Case and separators first, then one or
 * two edits — enough for `visibilty` and `transport_mode`, not enough to pair
 * `lat` with `lng`. */
function suggest(key, known) {
  const fold = (k) => k.toLowerCase().replace(/[_-]/g, "");
  const others = known.filter((k) => k !== key);
  const same = others.find((k) => fold(k) === fold(key));
  if (same) return same;
  const limit = key.length >= 6 ? 2 : 1;
  let best = null, bestDistance = limit + 1;
  for (const candidate of others) {
    const a = fold(key), b = fold(candidate);
    if (Math.abs(a.length - b.length) > limit) continue;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      for (let j = 1; j <= b.length; j += 1) {
        row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = row;
    }
    if (previous[b.length] < bestDistance) { best = candidate; bestDistance = previous[b.length]; }
  }
  return bestDistance <= limit ? best : null;
}

const typeOf = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

/**
 * What the instance says a field may be, merged over what this repository
 * knows about the file.
 *
 * The instance wins on type, enum and required, always — it is the thing that
 * will refuse the write, and a second opinion here is only ever a second
 * opinion that can be wrong. What this repository adds is the half a request
 * schema has no way to carry: what the field is FOR (the tip), and the rules
 * for the keys that never cross the API at all.
 */
let API = { trip: {}, day: {}, journal: {}, cost: {}, gallery: {} };
/** The whole published document, kept so a `$ref` inside a schema resolves. */
let DOC = null;

function ruleFor(scope, key, local = {}) {
  const published = API[scope]?.properties?.[key];
  if (!published) return local;
  return {
    ...local,
    type: published.type ?? local.type,
    enum: published.enum ?? local.enum,
    required: (API[scope]?.required ?? []).includes(key) || local.required,
    // The document's own wording is better than anything written here: it is
    // what the person who wrote the refusal chose to say.
    tip: local.tip ?? published.description,
    expected: local.expected,
  };
}

/** One value against one key's rule. */
function checkValue(where, key, rule, value) {
  // `type` may be a list — the document writes `["array", "boolean"]` for a
  // field a day may either answer or decline.
  const types = rule.type === undefined ? null : [rule.type].flat();
  // JSON has one number type and JSON Schema has two. A width of 1600 read out
  // of a file is a `number`, and the document calls it an `integer`; treating
  // that as a mismatch made every photograph in a real journal an error.
  const actual = typeOf(value);
  const matches = types?.some(
    (type) => type === actual || (type === "integer" && Number.isInteger(value)),
  );
  if (types && !matches) {
    error(where, `${key} is ${typeOf(value)}, expected ${types.join(" or ")}`, rule.expected);
    return;
  }
  if (rule.enum && !rule.enum.includes(value)) {
    error(where, `${key} is ${JSON.stringify(value)}`, `one of ${rule.enum.join(", ")}`);
    return;
  }
  if (rule.pattern && typeof value === "string" && !rule.pattern.test(value)) {
    error(where, `${key} is ${JSON.stringify(value)}`, rule.expected);
  }
}

/** A whole frontmatter block against a MODEL file. */
function checkKeys(where, keys, data, { tips = true, scope = null } = {}) {
  const known = Object.keys(keys);
  for (const [key, local] of Object.entries(keys)) {
    if (local.apiOnly) continue;
    const rule = scope ? ruleFor(scope, key, local) : local;
    const value = data[key];
    if (value === undefined || value === null) {
      // `body: true` is the prose under the frontmatter, checked separately —
      // it is not a key anybody forgot to write. `noTip` is for the fields it
      // would be wrong to suggest: nobody should be nudged towards `test`.
      if (local.body || local.noTip) continue;
      if (rule.required) error(where, `${key} is missing`, rule.note ?? `required — ${rule.type}`);
      else if (rule.tip && tips) tip(where, `${key} is not set`, rule.tip, key);
      continue;
    }
    checkValue(where, key, rule, value);
    const published = scope ? API[scope]?.properties?.[key] : null;
    if (published?.items) checkList(`${where} ${key}`, published, value);
  }
  for (const key of Object.keys(data)) {
    if (known.includes(key)) continue;
    const near = suggest(key, known.filter((k) => !keys[k].apiOnly));
    error(where, `${key} is not a field`, near ? `did you mean ${near}?` : "nothing reads it — it will be dropped");
  }
}

/**
 * An object against a schema the instance published — used for the shapes that
 * live *inside* a field: a `people:` entry, a figure in `travellers:`, a cost
 * line, a gallery item, the `budget` block.
 *
 * These used to be unchecked or checked against a copy kept here, and the copy
 * was the thinner of the two: a `people:` entry with a name and no email
 * passed every check in this file and was refused by the instance, which is
 * the failure this whole pair exists to move earlier.
 */
function checkObject(where, schema, value) {
  const resolved = schema?.$ref ? deref(schema, DOC) : schema;
  if (!resolved?.properties) return;
  if (typeOf(value) !== "object") {
    error(where, `is ${typeOf(value)}`, "an object");
    return;
  }
  for (const key of resolved.required ?? []) {
    if (value[key] === undefined) error(`${where}.${key}`, "is missing", "required");
  }
  for (const [key, rule] of Object.entries(resolved.properties)) {
    if (value[key] === undefined) continue;
    checkValue(where, key, rule, value[key]);
  }
  if (resolved.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (key in resolved.properties) continue;
      const near = suggest(key, Object.keys(resolved.properties));
      error(`${where}.${key}`, "is not a field here", near ? `did you mean ${near}?` : "it will be refused");
    }
  }
}

/** Every item of a list the document describes, against the item's schema. */
function checkList(where, schema, value) {
  if (!Array.isArray(value)) return;
  const items = schema?.items;
  if (!items) return;
  value.forEach((item, index) => checkObject(`${where}[${index}]`, items, item));
}

/** Cost lines, wherever they appear. */
function checkCosts(where, list) {
  if (!Array.isArray(list)) return;
  list.forEach((line, index) => {
    const at = `${where} costs[${index}]`;
    if (typeOf(line) !== "object") { error(at, `is ${typeOf(line)}`, "a { label, amount } line"); return; }
    checkKeys(at, Object.fromEntries(COST_KEYS.map((k) => [k, {}])), line, { tips: false, scope: "cost" });
  });
}

function daysBetween(start, end) {
  const out = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function checkJournal(user, only) {
  const journal = readJournal(user);
  const where = `content/${user}/config.json`;

  if (journal.configProblem) error(where, "is not valid JSON", journal.configProblem);
  else if (!journal.config) error(`content/${user}`, "has no config.json", "the journal's title, owner and languages live there");
  else {
    checkKeys(where, MODEL["config.json"].keys, journal.config, { scope: "journal" });
    const features = journal.config.features ?? {};
    const off = Object.entries(features).filter(([, v]) => v && v.enabled === false).map(([k]) => k);
    if (off.length) tip(where, `features off: ${off.join(", ")}`, "each can be switched on with PATCH /api/v1/{user}/config");
  }

  const locales = journal.config?.locales ?? [];

  for (const trip of journal.trips) {
    if (only && trip.id !== only) continue;
    const tripWhere = `content/${user}/trips/${trip.id}/trip.md`;

    if (!trip.trip) { error(tripWhere, "is missing", "a trip without trip.md is not a trip"); continue; }
    for (const p of trip.trip.problems) error(tripWhere, `line ${p.line}: ${p.why}`, p.text);
    checkKeys(tripWhere, MODEL["trip.md"].keys, trip.trip.data, { scope: "trip" });

    const data = trip.trip.data;
    if (data.id && data.id !== trip.id) error(tripWhere, `id is ${JSON.stringify(data.id)} but the folder is ${trip.id}`, "they must match");
    if (data.start && data.end && Date.parse(data.end) < Date.parse(data.start)) {
      error(tripWhere, "end is before start");
    }
    if (!trip.trip.body) tip(tripWhere, "has no intro prose", "the paragraphs under the frontmatter open the trip");
    if (data.visibility === undefined) tip(tripWhere, "visibility is not set", "absent reads as private — nobody but you and the people on it");

    if (!trip.costs) tip(`content/${user}/trips/${trip.id}/`, "has no costs.md", MODEL["costs.md"].tip);
    else {
      const costsWhere = `content/${user}/trips/${trip.id}/costs.md`;
      for (const p of trip.costs.problems) error(costsWhere, `line ${p.line}: ${p.why}`, p.text);
      checkKeys(costsWhere, MODEL["costs.md"].keys, trip.costs.data);
      checkCosts(costsWhere, trip.costs.data.costs);
      const budget = trip.costs.data.budget;
      if (budget && typeOf(budget) === "object") {
        for (const key of ["total", "days", "currency"]) {
          if (budget[key] === undefined) error(costsWhere, `budget.${key} is missing`, "a budget needs all three");
        }
      }
    }
    if (!trip.plan) {
      if (data.status === "upcoming") {
        tip(`content/${user}/trips/${trip.id}/`, "has no plan.md", MODEL["plan.md"].tip);
      }
    } else {
      const planWhere = `content/${user}/trips/${trip.id}/plan.md`;
      for (const p of trip.plan.problems) error(planWhere, `line ${p.line}: ${p.why}`, p.text);
      checkKeys(planWhere, MODEL["plan.md"].keys, trip.plan.data);
    }

    const slugs = new Map();
    let daysWithCosts = 0;
    const covered = new Set();
    // Absent means every track on, which is the instance's default and the one
    // an owner should not have to find.
    const tracks = { costs: true, coordinates: true, photos: true, ...(data.tracks ?? {}) };

    for (const entry of trip.entries) {
      const entryWhere = `content/${user}/trips/${trip.id}/entries/${entry.file}`;
      for (const p of entry.problems) error(entryWhere, `line ${p.line}: ${p.why}`, p.text);

      // Three things this day should not be nudged about, because the answer
      // is already settled and asking again is how an agent ends up inventing
      // a value to make a list go quiet:
      //
      //   - the day said `without: [costs]` — it has answered;
      //   - the trip does not track it at all;
      //   - the journal has one language, so there is nothing to translate.
      for (const declinedTrack of [
        ...[entry.data.without ?? []].flat(),
        ...[entry.data.unrecorded ?? []].flat(),
      ]) {
        errored.add(`${entryWhere}|${declinedTrack === "coordinates" ? "lat" : declinedTrack}`);
      }
      for (const [track, on] of Object.entries(tracks)) {
        if (on === false) errored.add(`${entryWhere}|${track === "coordinates" ? "lat" : track}`);
      }
      if (locales.length < 2) errored.add(`${entryWhere}|translations`);
      checkKeys(entryWhere, MODEL["entries/YYYY-MM-DD-slug.md"].keys, entry.data, { scope: "day" });
      if (!entry.body) error(entryWhere, "has no prose", "the body under the frontmatter is the day itself");

      if (!entry.fileDate) error(entryWhere, "is not named YYYY-MM-DD-slug.md", "the date orders it and the slug addresses it");
      else if (entry.data.date && entry.data.date !== entry.fileDate) {
        error(entryWhere, `date is ${entry.data.date} but the filename says ${entry.fileDate}`, "they must agree");
      }
      if (slugs.has(entry.slug)) error(entryWhere, `two files share the slug ${entry.slug}`, `the other is ${slugs.get(entry.slug)}`);
      slugs.set(entry.slug, entry.file);

      const date = entry.data.date ?? entry.fileDate;
      if (date) {
        covered.add(date);
        if (data.start && data.end && (date < data.start || date > data.end)) {
          error(entryWhere, `date ${date} is outside the trip (${data.start} … ${data.end})`, "widen the trip, or move the day");
        }
      }

      if (Array.isArray(entry.data.costs) && entry.data.costs.length) daysWithCosts += 1;
      checkCosts(entryWhere, entry.data.costs);

      // The trip's own contract — `tracks:` on trip.md, absent meaning all of
      // them on. The instance answers 422 `incomplete_day` for a day that says
      // nothing about something the trip keeps track of, and names both how to
      // send it and how to decline it. Checked here so that is found before a
      // publish run rather than in the middle of one.
      // Both answers settle the row. `unrecorded` is B560's third one — *there
      // was some of this and nobody has it* — and a day carrying it has
      // answered the trip just as surely as one that declined.
      const declined = new Set([
        ...[entry.data.without ?? []].flat(),
        ...[entry.data.unrecorded ?? []].flat(),
      ]);
      for (const [track, answered] of [
        ["costs", Array.isArray(entry.data.costs) && entry.data.costs.length > 0],
        ["coordinates", entry.data.lat !== undefined && entry.data.lng !== undefined],
        ["photos", Array.isArray(entry.data.gallery) && entry.data.gallery.length > 0],
      ]) {
        if (tracks[track] === false || answered || declined.has(track)) continue;
        errored.add(`${entryWhere}|${track === "coordinates" ? "lat" : track}`);
        error(entryWhere, `the trip tracks ${track} and this day says nothing about it`,
          `Ask the person what this day had. If it had some, send it. If it genuinely had ` +
          `none, \`"${track}": false\` on the write says so, and is written into the day as ` +
          `\`without: [${track}]\`. A trip-level costs.md is NOT an answer for a day — the ` +
          `budget is what was paid before leaving, not what this day cost. Never send false ` +
          `to make this line go away.`);
      }

      // An error and not a warning: the instance refuses this day outright
      // (400 invalid_entry). The boundary between the two marks is exactly
      // "will this be refused", and this one used to sit on the wrong side —
      // a publish run got fourteen days in before finding out.
      if (locales.length > 1 && !entry.data.translations) {
        errored.add(`${entryWhere}|translations`);
        error(entryWhere,
          `the journal declares ${locales.join(", ")} and this day has no translations`,
          "send them — or, if the journal is really written in one language, that is the " +
          "journal's to fix: narrow locales in config.json");
      }

      const gallery = entry.data.gallery;
      if ((!gallery || (Array.isArray(gallery) && gallery.length === 0)) && tracks.photos !== false) {
        tip(entryWhere, "has no photographs", "POST them to …/trips/<trip>/media with this day's slug");
      } else if (Array.isArray(gallery)) {
        gallery.forEach((item, index) => {
          const at = `${entryWhere} gallery[${index}]`;
          if (typeOf(item) !== "object") { error(at, `is ${typeOf(item)}`, "a { src, type } item"); return; }
          checkKeys(at, Object.fromEntries(GALLERY_KEYS.map((k) => [k, {}])), item, {
            tips: false,
            scope: "gallery",
          });
          const file = galleryFile(journal, trip, item.src);
          if (!file) error(at, `src ${JSON.stringify(item.src)} is not a /media/<trip>/<day>/<file> path`);
          else if (!existsSync(file)) error(at, `${item.src} is not on disk`, `looked for ${file.replace(journal.dir, `content/${user}`)}`);
          else {
            const extension = basename(file).split(".").pop().toLowerCase();
            // The instance's own list, from /api/health. `.jpg` is the trap:
            // it is the commonest extension there is and the server names the
            // format `jpeg`, so the two have to be reconciled here rather than
            // by keeping a second list.
            const allowed = (LIMITS[item.type === "video" ? "videoFormats" : "imageFormats"] ?? []).map(
              (format) => (format === "jpeg" ? ["jpeg", "jpg"] : [format]),
            ).flat();
            if (allowed.length && !allowed.includes(extension)) {
              error(at, `.${extension} is not a ${item.type} format this instance takes`, `one of ${allowed.join(", ")}`);
            }
            const bytes = statSync(file).size;
            const ceiling = item.type === "video" ? LIMITS.videoMaxBytes : LIMITS.imageMaxBytes;
            if (bytes === 0) error(at, `${item.src} is an empty file`);
            else if (ceiling && bytes > ceiling) {
              error(at, `${item.src} is ${Math.round(bytes / 1024 / 1024)} MB`,
                `this instance takes at most ${Math.round(ceiling / 1024 / 1024)} MB per file`);
            }
          }
          if (item.type === "image" && (!item.width || !item.height)) {
            warn(at, "has no width and height", "the page reserves no space for it, so the layout jumps as it loads");
          }
        });
      }
    }

    if (trip.costs?.data?.budget && daysWithCosts === 0 && trip.entries.length > 0) {
      warn(`content/${user}/trips/${trip.id}/`, `a budget is set and none of the ${trip.entries.length} days records any spending`,
        "either the days really cost nothing — say so with costs: false — or the day-level costs never left this machine");
    }
    if (data.start && data.end) {
      const missing = daysBetween(data.start, data.end).filter((d) => !covered.has(d));
      if (missing.length) {
        const shown = missing.slice(0, 6).join(", ") + (missing.length > 6 ? `, … (${missing.length} in all)` : "");
        tip(`content/${user}/trips/${trip.id}/`, `${missing.length} date${missing.length === 1 ? " in the trip has" : "s in the trip have"} no day`, shown);
      }
    }
    for (const folder of trip.mediaFolders) {
      if (!slugs.has(folder)) {
        warn(`content/${user}/trips/${trip.id}/media/${folder}/`, "belongs to no day", "the photographs are there and nothing shows them");
      }
    }
  }
}

// ── run ────────────────────────────────────────────────────────────────────
const only = arg("trip");
const users = arg("user") ? [arg("user")] : usernames();
if (users.length === 0) {
  console.error("Nothing in content/ to check. A journal lives at content/<username>/.");
  process.exit(1);
}

let LIMITS = {};

try {
  const { doc, from, site } = await openapi({ offline: has("offline"), refresh: has("refresh") });

  // Everything the instance is willing to say about itself, read once. From
  // here on this script has no opinion of its own about what a field may be.
  DOC = doc;
  API = {
    trip: requestSchema(doc, "/api/v1/{user}/trips", "post") ?? {},
    day: requestSchema(doc, "/api/v1/{user}/trips/{trip}/days", "post") ?? {},
    journal: {
      properties: {
        ...(requestSchema(doc, "/api/v1/journals", "post")?.properties ?? {}),
        ...(requestSchema(doc, "/api/v1/{user}/config", "patch")?.properties ?? {}),
      },
    },
    cost: deref({ $ref: "#/components/schemas/Cost" }, doc) ?? {},
    gallery: deref({ $ref: "#/components/schemas/GalleryItem" }, doc) ?? {},
  };

  try {
    const reported = await health({ offline: has("offline"), refresh: has("refresh") });
    LIMITS = reported.doc?.media ?? {};
    // `api.mjs` already refetches a cache with no `media` block on any normal
    // (online) run, so this only fires with `--offline` or when the network
    // is down and the fetch fell back to that same stale copy — the cases
    // where a fresh document genuinely could not be had. Said in the same
    // place as the schema-unavailable notice below, for the same reason: a
    // check that did not run must look different from one that ran and found
    // nothing.
    if (!reported.doc?.media) {
      warn("(health)", `no media block in the ${reported.from} /api/health document`,
        "the photograph format and size checks did not run — retry online, or with --refresh");
    }
    const off = Object.entries(reported.doc?.capabilities ?? {})
      .filter(([, state]) => !state.enabled)
      .map(([name, state]) => `${name} (${state.reason ?? "off"})`);
    if (off.length && !has("json")) {
      console.log(`This server cannot offer: ${off.join(", ")}\n`);
    }
  } catch (failure) {
    warn("(health)", failure.message,
      "the upload formats and size limits were not checked — /api/health is where they live");
  }

  if (!has("json")) console.log(`Checked against ${site} — schema from ${from}\n`);
  for (const drift of crosscheck(doc)) {
    const unknownHere = drift.why.startsWith("the instance accepts");
    say(unknownHere ? "tip" : "warn", drift.where, `${drift.key}: ${drift.why}`,
      unknownHere
        ? "an option these tools do not know about yet"
        : "either this instance is older than these tools, or the key is file-only");
  }
} catch (failure) {
  warn("(schema)", failure.message, "checked the file format only; the instance's own rules were not consulted");
}

for (const user of users) {
  try { checkJournal(user, only); }
  catch (failure) { error(`content/${user}`, failure.message); }
}

// A field that produced an error does not also get a tip: "costs is not set"
// printed under "the trip tracks costs and this day says nothing about it" is
// the same sentence twice, and the second makes the first read as advice.
for (let i = found.length - 1; i >= 0; i -= 1) {
  const item = found[i];
  if (item.severity === "tip" && item.key && errored.has(`${item.where}|${item.key}`)) {
    found.splice(i, 1);
  }
}

const counts = { error: 0, warn: 0, tip: 0 };
for (const item of found) counts[item.severity] += 1;

if (has("json")) {
  console.log(JSON.stringify({ counts, found }, null, 2));
} else {
  const MARK = { error: "✗", warn: "!", tip: "·" };

  // The same tip on fourteen days is one thing to know, not fourteen lines to
  // scroll past. Anything said three or more times is said once, with a count
  // and where to look; --all prints every occurrence.
  const groups = new Map();
  for (const item of found) {
    const key = `${item.severity}||${item.message}||${item.fix ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const repeated = has("all") ? new Set() : new Set([...groups].filter(([, v]) => v.length >= 3).map(([k]) => k));

  for (const severity of ["error", "warn", "tip"]) {
    const collapsed = [...groups].filter(([k]) => repeated.has(k) && k.startsWith(`${severity}||`));
    if (collapsed.length) console.log(`\n${severity === "tip" ? "Options not set" : severity === "warn" ? "Worth a look" : "Errors"}, across several files`);
    for (const [, items] of collapsed) {
      const where = items.slice(0, 3).map((i) => i.where.split("/").pop()).join(", ");
      console.log(`  ${MARK[severity]} ${items[0].message} — ${items.length} files (${where}${items.length > 3 ? ", …" : ""})`);
      if (items[0].fix) console.log(`      ${items[0].fix}`);
    }
  }

  let last = null;
  for (const severity of ["error", "warn", "tip"]) {
    for (const item of found) {
      if (item.severity !== severity) continue;
      if (repeated.has(`${item.severity}||${item.message}||${item.fix ?? ""}`)) continue;
      if (item.where !== last) { console.log(`\n${item.where}`); last = item.where; }
      console.log(`  ${MARK[severity]} ${item.message}${item.fix ? `\n      ${item.fix}` : ""}`);
    }
  }
  console.log(
    `\n${counts.error} error${counts.error === 1 ? "" : "s"}, ` +
    `${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.tip} tip${counts.tip === 1 ? "" : "s"}.`,
  );
  if (counts.error) console.log("Publishing is refused while there are errors.");
}

process.exit(counts.error ? 1 : 0);
