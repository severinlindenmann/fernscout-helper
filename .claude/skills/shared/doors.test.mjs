#!/usr/bin/env node
// The drift guard itself — B1569. A guard nothing tests is decoration, and
// this one has two ways to be useless: staying quiet when a key really has
// fallen behind, and firing on a journal where nothing has.
import { strict as assert } from "node:assert";
import { unaccountedKeys } from "./doors.mjs";
import { JOURNAL_DEDICATED_DOORS, JOURNAL_NO_UPDATE_DOOR, JOURNAL_UPDATE_DOORS } from "./journalFields.mjs";
import { DAY_DEDICATED_DOORS, DAY_UPDATE_DOORS, FALLBACK_RESERVED_WEATHER_SOURCES, isServerWeather } from "./dayFields.mjs";

let failures = 0;
const test = (what, fn) => {
  try { fn(); console.log(`  ✓ ${what}`); }
  catch (error) { failures += 1; console.log(`  ✗ ${what}\n      ${error.message}`); }
};

const keys = (...names) => Object.fromEntries(names.map((n) => [n, {}]));

console.log("the drift guard");

test("a key the instance grew and nothing here accounts for is named", () => {
  assert.deepEqual(unaccountedKeys(keys("title", "newThing"), ["title"], {}), ["newThing"]);
});

test("a key this repository sends is not named", () => {
  assert.deepEqual(unaccountedKeys(keys("title"), ["title"], {}), []);
});

test("a key that travels another way is not named — that is what `accounted` is for", () => {
  assert.deepEqual(unaccountedKeys(keys("gallery"), [], { gallery: "sent as files" }), []);
});

test("an apiOnly key is never named, however it is listed", () => {
  // These never appear in a file, so nothing on disk could have failed to be
  // sent. Before this the guard warned about `username`, `ownerName`,
  // `coordinates`, `photos`, `dryRun` and `idempotency_key` on a perfectly
  // healthy journal — six false alarms in its first run.
  const model = { coordinates: { apiOnly: true }, photos: { apiOnly: true } };
  assert.deepEqual(unaccountedKeys(model, [], {}), []);
});

test("an empty or missing model says nothing rather than throwing", () => {
  assert.deepEqual(unaccountedKeys(undefined, [], {}), []);
  assert.deepEqual(unaccountedKeys({}, [], {}), []);
});

console.log("the lists it is asked about");

test("config.json: every key is accounted for, so the guard is quiet today", () => {
  // The state B1504 and B1569 left it in. If this fails, the instance has
  // grown a config.json key and `journalFields.mjs` has not been told which
  // of the three it is.
  const model = keys("title", "tagline", "visibility", "startLocation", "units", "locales",
                     "defaultLocale", "displayCurrencies", "manualRates", "travellers",
                     "owner", "baseCurrency", "media", "features");
  assert.deepEqual(
    unaccountedKeys(model, JOURNAL_UPDATE_DOORS, { ...JOURNAL_NO_UPDATE_DOOR, ...JOURNAL_DEDICATED_DOORS }),
    [],
  );
});

test("a day: nothing the instance knows is unaccounted for any more — B1578", () => {
  // This test used to pin three keys as *missing*: `timezone`, `weatherData`
  // and `visibility` were all in the instance's EDITABLE_DAY_FIELDS and none
  // had ever been sent, found by this guard's own first run. B1578 added them,
  // and this is the assertion turning over to say so.
  const model = keys(...DAY_UPDATE_DOORS, ...Object.keys(DAY_DEDICATED_DOORS),
                     "timezone", "weatherData", "visibility");
  assert.deepEqual(unaccountedKeys(model, DAY_UPDATE_DOORS, DAY_DEDICATED_DOORS), []);
});

test("the three B1578 added are sent, not merely accounted for", () => {
  // A key moved into DAY_DEDICATED_DOORS would satisfy the test above while
  // still never travelling, which is the shape of a fix that quiets a guard
  // without fixing anything. These three have to be on the wire.
  for (const key of ["timezone", "visibility", "weatherData"]) {
    assert.ok(DAY_UPDATE_DOORS.includes(key), `${key} must be sent, not explained away`);
  }
});

console.log("the server's own weather readings");

const reading = (source) => ({ tempMax: 14, source, recordedAt: "2026-06-24T17:00:00Z" });

test("a reserved source is recognised from what the instance published", () => {
  // The list is read from /api/health now (B1580), not remembered here.
  assert.equal(isServerWeather(reading("open-meteo"), ["open-meteo"]), true);
  assert.equal(isServerWeather(reading("weatherstack"), ["open-meteo", "weatherstack"]), true);
});

test("a source the instance did not reserve is a person's own reading", () => {
  assert.equal(isServerWeather(reading("the Kestrel on my handlebars"), ["open-meteo"]), false);
  // The guard-that-fires-on-an-honest-run case: this is the sanctioned route
  // for somebody's own instrument, and skipping one would silently drop it.
  assert.equal(isServerWeather(reading("my balcony thermometer"), ["open-meteo"]), false);
});

test("case and surrounding space do not let a reserved name through", () => {
  assert.equal(isServerWeather(reading("  Open-Meteo "), ["open-meteo"]), true);
});

test("an instance that publishes nothing falls back rather than waving it through", () => {
  // An older instance, or one that could not be reached. Guessing "nothing is
  // reserved" would send the server's own reading straight back at it and
  // fail the run on every day the archive ever answered for.
  assert.equal(isServerWeather(reading("open-meteo"), []), true);
  assert.equal(isServerWeather(reading("open-meteo"), undefined), true);
  assert.deepEqual(FALLBACK_RESERVED_WEATHER_SOURCES, ["open-meteo"]);
});

test("a day with no reading at all is not mistaken for one", () => {
  assert.equal(isServerWeather(undefined, ["open-meteo"]), false);
  assert.equal(isServerWeather({}, ["open-meteo"]), false);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
