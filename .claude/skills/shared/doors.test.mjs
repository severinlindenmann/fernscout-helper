#!/usr/bin/env node
// The drift guard itself — B1569. A guard nothing tests is decoration, and
// this one has two ways to be useless: staying quiet when a key really has
// fallen behind, and firing on a journal where nothing has.
import { strict as assert } from "node:assert";
import { unaccountedKeys } from "./doors.mjs";
import { JOURNAL_DEDICATED_DOORS, JOURNAL_NO_UPDATE_DOOR, JOURNAL_UPDATE_DOORS } from "./journalFields.mjs";
import { DAY_DEDICATED_DOORS, DAY_UPDATE_DOORS } from "./dayFields.mjs";

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

test("a day: the three B1578 names are exactly what is still unaccounted for", () => {
  // Pinned rather than left implicit. `timezone`, `weatherData` and
  // `visibility` are all in the instance's EDITABLE_DAY_FIELDS and none of
  // them has ever been sent — found by this guard's own first run. When
  // B1578 fixes them this test is what says so.
  const model = keys(...DAY_UPDATE_DOORS, ...Object.keys(DAY_DEDICATED_DOORS),
                     "timezone", "weatherData", "visibility");
  assert.deepEqual(
    unaccountedKeys(model, DAY_UPDATE_DOORS, DAY_DEDICATED_DOORS).sort(),
    ["timezone", "visibility", "weatherData"],
  );
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
