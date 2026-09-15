// The three faults this skill exists to not have. Each test is a day that a
// naive version got wrong on a real library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsFor, ownerOf, distKm } from "./discover.mjs";

const HOMES = [{ lat: 46.9480, lng: 7.4474 }, { lat: 47.3779, lng: 8.5403 }];
const OPTS = { homes: HOMES, radius: 100, minDays: 2, maxGap: 2 };
const row = (day, lat, lng, model = "Phone C", place = "") => ({ day, lat, lng, model, place });

test("a day is a journey, not a point: Baden in the morning and Gyál at night is away", () => {
  // The midpoint of these two is the Baltic Sea — further than 100 km from
  // both, which made the median version delete the day outright.
  const rows = [
    row("2022-12-31", 47.4748, 8.3052),   // Baden, home
    row("2022-12-31", 47.3855, 19.2307),  // Gyál, Hungary
    row("2023-01-01", 47.3855, 19.2307),
  ];
  const runs = runsFor(rows, OPTS);
  assert.equal(runs.length, 1, "the New Year's Eve run must survive");
  assert.equal(runs[0].from, "2022-12-31", "and must start on the 31st, not the 1st");
});

test("a day entirely at home is not a trip", () => {
  const rows = [row("2024-03-01", 47.39, 8.17), row("2024-03-02", 47.39, 8.17)];
  assert.equal(runsFor(rows, OPTS).length, 0);
});

test("a run shorter than --min-days is not a trip", () => {
  const rows = [row("2024-03-01", 39.4, 20.2)];
  assert.equal(runsFor(rows, OPTS).length, 0);
});

test("a day with no location does not end a run, but does not start one", () => {
  const rows = [
    row("2024-07-01", 39.4, 20.2),
    { day: "2024-07-02", lat: null, lng: null, model: "Phone C", place: "" },
    row("2024-07-03", 39.4, 20.2),
  ];
  const runs = runsFor(rows, OPTS);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].days, 3, "the unlocated day is carried, not dropped");
  assert.equal(runs[0].unlocated, 1);
});

test("a run never ends on a guess", () => {
  const rows = [
    row("2024-07-01", 39.4, 20.2), row("2024-07-02", 39.4, 20.2),
    { day: "2024-07-03", lat: null, lng: null, model: "Phone C", place: "" },
  ];
  assert.equal(runsFor(rows, OPTS)[0].to, "2024-07-02");
});

test("a phone belongs to one person for a stretch of time", () => {
  const rules = { severin: [
    { model: "Phone C", from: "2019-12-19", to: "2024-08-20" },
    { model: "Phone D", from: "2024-08-20" },
  ] };
  assert.equal(ownerOf({ day: "2021-05-01", model: "Phone C" }, rules), "severin");
  assert.equal(ownerOf({ day: "2025-05-01", model: "Phone C" }, rules), null,
    "after the handover the old phone is somebody else's");
  assert.equal(ownerOf({ day: "2025-05-01", model: "Phone D" }, rules), "severin");
  assert.equal(ownerOf({ day: "2025-05-01", model: "iPhone 13" }, rules), null);
});

test("two people apart on the same days are two trips, not one", () => {
  const rules = { severin: [{ model: "Phone D" }], wife: [{ model: "Phone E" }] };
  const rows = [
    row("2025-07-18", 45.06, 8.31, "Phone D"),  row("2025-07-19", 44.41, 8.93, "Phone D"),
    row("2025-07-18", 47.38, 19.23, "Phone E"), row("2025-07-19", 47.24, 20.68, "Phone E"),
  ];
  const his = runsFor(rows.filter((r) => ownerOf(r, { severin: rules.severin }) === "severin"), OPTS);
  const hers = runsFor(rows.filter((r) => ownerOf(r, { wife: rules.wife }) === "wife"), OPTS);
  assert.equal(his.length, 1); assert.equal(hers.length, 1);
  assert.ok(his[0].maxKm < 400, "his trip is Italy, ~300 km out");
  assert.ok(hers[0].maxKm > 700, "hers is Hungary, ~800 km out");
});

test("distance is great-circle, not flat", () => {
  assert.ok(Math.abs(distKm({ lat: 46.95, lng: 7.45 }, { lat: 46.95, lng: 7.45 })) < 0.001);
  const zurichToLondon = distKm({ lat: 47.37, lng: 8.54 }, { lat: 51.51, lng: -0.13 });
  assert.ok(zurichToLondon > 750 && zurichToLondon < 800, `got ${zurichToLondon}`);
});
