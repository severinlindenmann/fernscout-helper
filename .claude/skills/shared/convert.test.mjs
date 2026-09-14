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
check(
  "the two encodings do not collapse into one sentence",
  WITHOUT.costs !== UNRECORDED.costs && /nothing was spent/.test(WITHOUT.costs) && /nobody recorded/.test(UNRECORDED.costs),
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

rmSync(target, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
