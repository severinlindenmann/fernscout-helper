#!/usr/bin/env node
// The four things a conversion must not get wrong — B1715.
//
// Shape is the easy half and a person would notice it immediately. These are
// the content half: each one is a fact the owner recorded that a plausible,
// tidy-looking port would destroy silently, and each one is checked against a
// fixture journal that actually carries it.
//
//   node .claude/skills/shared/convert.test.mjs
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const HERE = new URL(".", import.meta.url).pathname;
process.env.FERNSCOUT_CONTENT_DIR = join(HERE, "fixtures");
const { convertJournal, WITHOUT, UNRECORDED } = await import("./convert.mjs");

const target = join(tmpdir(), `fernscout-convert-test-${process.pid}`);
rmSync(target, { recursive: true, force: true });
const result = convertJournal("perfekt", { into: target });

const read = (p) => JSON.parse(readFileSync(join(target, p), "utf8"));
const trip = read("trips/alpine-loop/trip.json");
const quiet = read("trips/alpine-loop/entries/2026-12-21-quiet.json");
const summit = read("trips/alpine-loop/entries/2026-12-22-summit.json");
const arrival = read("trips/alpine-loop/entries/2026-12-20-arrival.json");

// 1. `without:` and `unrecorded:` are different facts, and stay different.
//    "nothing was spent" and "money was spent and nobody wrote down what" are
//    two things the owner chose between; one sentence for both throws that
//    choice away, and nothing on the site could ever recover it.
check(
  "without: [photos] becomes a decline saying none were taken",
  /no photographs were taken/.test(quiet.declined?.media ?? ""),
  JSON.stringify(quiet.declined),
);
check(
  "and it is filed under v2's name for it (media, not photos)",
  quiet.declined?.photos === undefined && quiet.declined?.media !== undefined,
  JSON.stringify(quiet.declined),
);
check(
  "unrecorded: [costs] becomes a decline saying the money is unaccounted for",
  /nobody recorded/.test(summit.declined?.costs ?? ""),
  JSON.stringify(summit.declined),
);
// The distinction itself, on one field, which is the thing a tidy port
// destroys: "nothing was spent" and "money was spent and nobody wrote down
// what" are two facts, and the owner chose between them.
// In v2 "nothing was spent" is not a decline at all — it is the answer
// `costs: []` — so only the lost-figures sentence exists for costs, and the
// site cannot mistake a zero-spend day for one whose figures are gone.
check(
  "the two encodings do not collapse: only unrecorded declines costs",
  WITHOUT.costs === undefined && /nobody recorded/.test(UNRECORDED.costs),
  `${WITHOUT.costs} / ${UNRECORDED.costs}`,
);

// 2. The exchange rate convention flipped. v1's number was units per 1 unit of
//    the journal's base currency; v2's is units per 1 EUR. Carrying the old
//    number across publishes a wrong rate that nothing will catch.
check("the currency name survives", trip.rates?.currencies?.includes("EUR"), JSON.stringify(trip.rates));
check("the old rate number does not", trip.rates?.manual === undefined, JSON.stringify(trip.rates));

// 3. A photograph moves folder and name together, and the day's src moves with
//    it. Either half alone is a day pointing at a file that is not there.
const src = arrival.media?.[0]?.src ?? "";
check("the day's media src names the whole day slug", src.includes("/2026-12-20-arrival/"), src);
check("the file is named by its content hash", /\/[0-9a-f]{32}\.jpg$/.test(src), src);
check(
  "and the file is actually at that path",
  existsSync(join(target, "trips/alpine-loop/media/2026-12-20-arrival", src.split("/").pop())),
  src,
);
check("the trip's cover moved with it", trip.cover === src, trip.cover);

// 4. The trip's own shape: dates, not start/end; one document, not three.
check("start/end became dates", trip.dates?.from === "2026-12-20" && trip.dates?.to === "2026-12-22", JSON.stringify(trip.dates));
check("costs.md became a section of the trip", Array.isArray(trip.costs?.items), JSON.stringify(trip.costs));
check("plan.md became a section of the trip", Array.isArray(trip.plan?.route), JSON.stringify(trip.plan));
check("plan.md's prose is plan.body, the field the strict schema knows",
  trip.plan?.body === "The rough shape of it, before anyone has left." && trip.plan?.note === undefined,
  JSON.stringify(trip.plan));
check("route stops with no coordinates are kept, never given invented ones",
  trip.plan?.route?.length === 3 && trip.plan.route.every((s) => s.lat === undefined && s.lng === undefined),
  JSON.stringify(trip.plan?.route));
check("and the run says they need coordinates",
  result.warnings.some((w) => /plan stop\(s\) have no lat\/lng/.test(w)), result.warnings.join(" | "));
check("costsVisibility: guests survives as costs.visibility — the money stays with guests",
  trip.costs?.visibility === "guests" && trip.costsVisibility === undefined, JSON.stringify(trip.costs));
check("no costs.md or plan.md was written", !existsSync(join(target, "trips/alpine-loop/costs.md")));
check("status: upcoming is gone — the dates say it", trip.status === undefined, String(trip.status));

// Travellers became a journal-wide figure library the trip refers to.
check("the trip names figures rather than describing travellers", trip.figures?.mode === "custom", JSON.stringify(trip.figures));
check("travellers: is not on the trip any more", trip.travellers === undefined);
check(
  "each figure is its own document",
  readdirSync(join(target, "figures")).length === result.figures && result.figures > 0,
  String(result.figures),
);
{
  const figure = read(`figures/${trip.figures?.figures?.[0]}.json`);
  check("a figure names its person, not `for`",
    figure.person === "perfekt@example.com" && figure.for === undefined && figure.age === "adult",
    JSON.stringify(figure));
}

// The journal document is strict: v1 settings it has no field for go, and
// the run names each one.
{
  const config = read("config.json");
  check("startLocation, manualRates, defaultLocale and media are not in the v2 config",
    ["startLocation", "manualRates", "defaultLocale", "media", "features", "travellers"].every((k) => config[k] === undefined),
    Object.keys(config).join(", "));
  check("the default locale is still the first one", config.locales?.[0] === "de", JSON.stringify(config.locales));
  check("and each drop is in the report",
    ["startLocation", "manualRates", "defaultLocale", "media"].every((k) => result.notes.some((n) => n.includes(k))),
    result.notes.join(" | "));
}

// Nothing was touched in the folder it read.
check(
  "the original folder still has its Markdown",
  existsSync(join(HERE, "fixtures/perfekt/trips/alpine-loop/trip.md")),
);

// ── B-7, the one that loses money silently ────────────────────────────────
//
// Built here rather than taken from a fixture because the shape is specific
// and it is worth stating exactly: v1's costs.md held a trip's WHOLE spend and
// its days held their own besides, and a statement import wrote the trip's
// copy with the date in the label. Measured on a real journal: 27 items each
// side, both summing to 923.60, published as 1847.20 against a 1000 budget.
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const v1 = join(tmpdir(), `fernscout-convert-costs-${process.pid}`);
  const out = join(tmpdir(), `fernscout-convert-costs-out-${process.pid}`);
  rmSync(v1, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(v1, "doppelt", "trips", "budapest", "entries"), { recursive: true });
  writeFileSync(join(v1, "doppelt", "config.json"), JSON.stringify({ title: "Doppelt" }));
  writeFileSync(join(v1, "doppelt", "trips", "budapest", "trip.md"),
    '---\nid: budapest\ntitle: Budapest\nstart: 2026-07-13\nend: 2026-07-14\n---\nEin paar Tage.\n');
  writeFileSync(join(v1, "doppelt", "trips", "budapest", "costs.md"),
    '---\nbudget: { total: 1000, days: 2, currency: "CHF" }\ncosts:\n' +
    '  - { label: "BudapestGO (2026-07-13)", amount: 7.2, category: "transport", currency: "CHF" }\n' +
    '  - { label: "Tesco (2026-07-14)", amount: 38.67, category: "food", currency: "CHF" }\n' +
    '  - { label: "easyJet", amount: 177.14, category: "flights", currency: "CHF" }\n---\n');
  writeFileSync(join(v1, "doppelt", "trips", "budapest", "entries", "2026-07-13-erster-tag.md"),
    '---\ntitle: Erster Tag\ndate: 2026-07-13\ncosts:\n' +
    '  - { label: "BudapestGO", amount: 7.2, category: "transport", currency: "CHF" }\n---\nAngekommen.\n');
  writeFileSync(join(v1, "doppelt", "trips", "budapest", "entries", "2026-07-14-zweiter-tag.md"),
    '---\ntitle: Zweiter Tag\ndate: 2026-07-14\ncosts:\n' +
    '  - { label: "Tesco", amount: 38.67, category: "food", currency: "CHF" }\n---\nEingekauft.\n');

  const run = convertJournal("doppelt", { from: v1, into: out });
  const trip = JSON.parse(readFileSync(join(out, "trips/budapest/trip.json"), "utf8"));
  const dayTotal = ["2026-07-13-erster-tag", "2026-07-14-zweiter-tag"]
    .map((slug) => JSON.parse(readFileSync(join(out, `trips/budapest/entries/${slug}.json`), "utf8")))
    .flatMap((d) => d.costs ?? [])
    .reduce((n, c) => n + c.amount, 0);
  const tripTotal = (trip.costs?.items ?? []).reduce((n, c) => n + c.amount, 0);

  check(
    "an item the days already carry is dropped from the trip, date suffix and all",
    (trip.costs?.items ?? []).every((c) => !/BudapestGO|Tesco/.test(c.label)),
    JSON.stringify(trip.costs?.items),
  );
  check("the one that appears on no day is kept as preparation",
    tripTotal === 177.14, String(tripTotal));
  check("the days keep every item they had", Math.abs(dayTotal - 45.87) < 0.001, String(dayTotal));
  check("so the trip totals the money that was actually spent, once",
    Math.abs(tripTotal + dayTotal - 223.01) < 0.001, String(tripTotal + dayTotal));
  check("the budget survives", trip.costs?.budget?.total === 1000, JSON.stringify(trip.costs?.budget));
  check("and the run says out loud what it dropped",
    run.warnings.some((w) => /same money the days already carry/.test(w)), run.warnings.join(" | "));

  rmSync(v1, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}

// ── the rest of v1's encodings, one synthetic folder ─────────────────────
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const v1 = join(tmpdir(), `fernscout-convert-v1-${process.pid}`);
  const out = join(tmpdir(), `fernscout-convert-v1-out-${process.pid}`);
  rmSync(v1, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  const trips = join(v1, "alex", "trips");
  const day = (trip, slug, fm, body = "Written.") => {
    mkdirSync(join(trips, trip, "entries"), { recursive: true });
    writeFileSync(join(trips, trip, "entries", `${slug}.md`), `---\n${fm}\n---\n${body}\n`);
  };
  mkdirSync(join(trips, "example-trip-2024"), { recursive: true });
  writeFileSync(join(v1, "alex", "config.json"), JSON.stringify({
    title: "Alex", locales: ["en", "de"], defaultLocale: "de", sparkle: true,
    owner: { name: "Alex", nickname: "Alex", email: "alex@example.com" },
  }));
  writeFileSync(join(trips, "example-trip-2024", "trip.md"),
    "---\nid: example-trip-2024\ntitle: Example\nstart: 2024-05-01\nend: 2024-05-03\n" +
    "reminder: true\nreminderChannel: whatsapp\ncostsVisibility: guests\n" +
    "tracks:\n  coordinates: false\n  photos: false\n" +
    "travellers:\n  - for: alex@example.com\n    hair: brown\n    colourway: loud\n---\n");
  writeFileSync(join(trips, "example-trip-2024", "costs.md"),
    "---\nbudget: { total: 500, currency: EUR }\n---\nThe budget was a guess made in March.\n");
  day("example-trip-2024", "2024-05-01-zero", "title: Zero\ndate: 2024-05-01\nwithout:\n  - costs");
  day("example-trip-2024", "2024-05-02-false", "title: False\ndate: 2024-05-02\ncosts: false");
  day("example-trip-2024", "2024-05-03-lost", 'title: Lost\ndate: 2024-05-03\ncosts: "unknown"\n' +
    "translations:\n  de:\n    title: Verloren\n  fr:\n    content: Perdu, sans titre.");

  mkdirSync(join(trips, "no-channel"), { recursive: true });
  writeFileSync(join(trips, "no-channel", "trip.md"),
    "---\nid: no-channel\ntitle: No channel\nstart: 2024-06-01\nend: 2024-06-01\nreminder: true\n" +
    "tracks:\n  costs: false\n---\n");

  const run = convertJournal("alex", { from: v1, into: out });
  const get = (p) => JSON.parse(readFileSync(join(out, p), "utf8"));
  const t = get("trips/example-trip-2024/trip.json");
  const zero = get("trips/example-trip-2024/entries/2024-05-01-zero.json");
  const no = get("trips/example-trip-2024/entries/2024-05-02-false.json");
  const lost = get("trips/example-trip-2024/entries/2024-05-03-lost.json");
  const bare = get("trips/no-channel/trip.json");
  const config = get("config.json");

  check("without: [costs] is the answer costs: [], not a decline",
    Array.isArray(zero.costs) && zero.costs.length === 0 && zero.declined?.costs === undefined, JSON.stringify(zero));
  check("costs: false is the same answer",
    Array.isArray(no.costs) && no.costs.length === 0 && no.declined?.costs === undefined, JSON.stringify(no));
  check('costs: "unknown" declines costs, with the lost-figures sentence',
    lost.costs === undefined && lost.declined?.costs === UNRECORDED.costs, JSON.stringify(lost));

  check("reminder: true + reminderChannel becomes reminder: {channel}",
    JSON.stringify(t.reminder) === '{"channel":"whatsapp"}' && t.reminderChannel === undefined, JSON.stringify(t.reminder));
  check("reminder: true with no channel is not guessed — left off, and reported",
    bare.reminder === undefined && run.warnings.some((w) => /no-channel: reminder: true with no reminderChannel/.test(w)),
    JSON.stringify(bare.reminder));

  check("costs.md's prose is costs.note", t.costs?.note === "The budget was a guess made in March.", JSON.stringify(t.costs));
  check("costsVisibility is costs.visibility", t.costs?.visibility === "guests", JSON.stringify(t.costs));

  check("tracks: {coordinates|photos: false} writes no trip-level decline v2 would refuse",
    t.declined?.coordinates === undefined && t.declined?.media === undefined && t.declined?.photos === undefined,
    JSON.stringify(t.declined));
  check("and says so", run.warnings.some((w) => /tracks\.coordinates: false has no trip-level home/.test(w)), run.warnings.join(" | "));
  check("tracks: {costs: false} is the trip's costs decline",
    typeof bare.declined?.costs === "string" && bare.declined.costs.length >= 10, JSON.stringify(bare.declined));

  check("a translation with only a title is dropped, its title quoted in the report",
    lost.translations?.de === undefined && run.warnings.some((w) => /translations\.de .*"Verloren"/.test(w)),
    JSON.stringify(lost.translations));
  check("a translation with prose and no title is kept — the title is never copied in",
    lost.translations?.fr?.content === "Perdu, sans titre." && lost.translations.fr.title === undefined,
    JSON.stringify(lost.translations));

  const fig = get("figures/alex.json");
  check("a figure keeps its appearance, gains person, loses what the strict schema does not know",
    fig.hair === "brown" && fig.person === "alex@example.com" && fig.for === undefined && fig.colourway === undefined,
    JSON.stringify(fig));

  check("defaultLocale becomes the first locale", JSON.stringify(config.locales) === '["de","en"]' && config.defaultLocale === undefined,
    JSON.stringify(config));
  check("an unknown journal key is left for the instance to name, and reported",
    config.sparkle === true && run.warnings.some((w) => /sparkle/.test(w)), JSON.stringify(config));

  rmSync(v1, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}

rmSync(target, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
