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
import { COST_KEYS, GALLERY_KEYS, MEDIA_FORMATS, MODEL, crosscheck } from "../shared/model.mjs";
import { galleryFile, readJournal, usernames } from "../shared/journal.mjs";
import { openapi } from "../shared/api.mjs";

const found = [];
const say = (severity, where, message, fix) => found.push({ severity, where, message, fix });
const error = (w, m, f) => say("error", w, m, f);
const warn = (w, m, f) => say("warn", w, m, f);
const tip = (w, m, f) => say("tip", w, m, f);

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

/** One value against one key's rule. */
function checkValue(where, key, rule, value) {
  if (rule.type && typeOf(value) !== rule.type) {
    error(where, `${key} is ${typeOf(value)}, expected ${rule.type}`, rule.expected);
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
function checkKeys(where, keys, data, { tips = true } = {}) {
  const known = Object.keys(keys);
  for (const [key, rule] of Object.entries(keys)) {
    if (rule.apiOnly) continue;
    const value = data[key];
    if (value === undefined || value === null) {
      if (rule.required && !rule.body) error(where, `${key} is missing`, rule.note ?? `required — ${rule.type}`);
      else if (rule.tip && tips) tip(where, `${key} is not set`, rule.tip);
      continue;
    }
    checkValue(where, key, rule, value);
  }
  for (const key of Object.keys(data)) {
    if (known.includes(key)) continue;
    const near = suggest(key, known.filter((k) => !keys[k].apiOnly));
    error(where, `${key} is not a field`, near ? `did you mean ${near}?` : "nothing reads it — it will be dropped");
  }
}

/** Cost lines, wherever they appear. */
function checkCosts(where, list) {
  if (!Array.isArray(list)) return;
  list.forEach((line, index) => {
    const at = `${where} costs[${index}]`;
    if (typeOf(line) !== "object") { error(at, `is ${typeOf(line)}`, "a { label, amount } line"); return; }
    checkKeys(at, COST_KEYS, line, { tips: false });
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
    checkKeys(where, MODEL["config.json"].keys, journal.config);
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
    checkKeys(tripWhere, MODEL["trip.md"].keys, trip.trip.data);

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
    if (!trip.plan && data.status === "upcoming") {
      tip(`content/${user}/trips/${trip.id}/`, "has no plan.md", MODEL["plan.md"].tip);
    }

    const slugs = new Map();
    let daysWithCosts = 0;
    const covered = new Set();

    for (const entry of trip.entries) {
      const entryWhere = `content/${user}/trips/${trip.id}/entries/${entry.file}`;
      for (const p of entry.problems) error(entryWhere, `line ${p.line}: ${p.why}`, p.text);

      checkKeys(entryWhere, MODEL["entries/YYYY-MM-DD-slug.md"].keys, entry.data);
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

      if (locales.length > 1 && !entry.data.translations) {
        warn(entryWhere, `the journal is written in ${locales.join(", ")} and this day has no translations`, "send them, or write the journal in one language");
      }

      const gallery = entry.data.gallery;
      if (!gallery || (Array.isArray(gallery) && gallery.length === 0)) {
        tip(entryWhere, "has no photographs", "POST them to …/trips/<trip>/media with this day's slug");
      } else if (Array.isArray(gallery)) {
        gallery.forEach((item, index) => {
          const at = `${entryWhere} gallery[${index}]`;
          if (typeOf(item) !== "object") { error(at, `is ${typeOf(item)}`, "a { src, type } item"); return; }
          checkKeys(at, GALLERY_KEYS, item, { tips: false });
          const file = galleryFile(journal, trip, item.src);
          if (!file) error(at, `src ${JSON.stringify(item.src)} is not a /media/<trip>/<day>/<file> path`);
          else if (!existsSync(file)) error(at, `${item.src} is not on disk`, `looked for ${file.replace(journal.dir, `content/${user}`)}`);
          else {
            const extension = basename(file).split(".").pop().toLowerCase();
            const allowed = MEDIA_FORMATS[item.type] ?? [];
            if (allowed.length && !allowed.includes(extension)) {
              error(at, `.${extension} is not a ${item.type} format this instance takes`, `one of ${allowed.join(", ")}`);
            }
            if (statSync(file).size === 0) error(at, `${item.src} is an empty file`);
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

try {
  const { doc, from, site } = await openapi({ offline: has("offline"), refresh: has("refresh") });
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
