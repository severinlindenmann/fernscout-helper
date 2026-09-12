#!/usr/bin/env node
// The three-way compare, the exclusions and the deletion threshold — B491.
//
// These are the parts where a wrong answer costs somebody a day's writing, and
// they are all pure functions on purpose so a test needs no instance, no
// token and no network. What is deliberately not here is the network shape of
// `sync.mjs` itself; that is proved by driving it against a real instance, the
// way B1495's own server half was.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentHash, deletionRefusal, inSync, localManifest, plan, readBase, writeBase,
} from "../shared/syncManifest.mjs";
import { JOURNAL_NO_UPDATE_DOOR, JOURNAL_UPDATE_DOORS } from "../shared/journalFields.mjs";

let failures = 0;
const test = (what, fn) => {
  try { fn(); console.log(`  ✓ ${what}`); }
  catch (error) { failures += 1; console.log(`  ✗ ${what}\n      ${error.message}`); }
};

console.log("sync — what belongs in one");

test("the hash is the server's: SHA-256, hex, 32 characters", () => {
  // The one value both sides must agree on before any conversation is
  // possible. Pinned rather than described, so a change to either copy shows
  // up here rather than as a folder that silently never syncs.
  assert.equal(contentHash(Buffer.from("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e");
  assert.equal(contentHash(Buffer.from("hello")).length, 32);
});

test("gps/ is out, in any spelling", () => {
  assert.equal(inSync("gps/2026-06.jsonl"), false);
  assert.equal(inSync("GPS/2026-06.jsonl"), false);
  assert.equal(inSync("gps/exclude.json"), false);
});

test("originals/ and track.json are out, shouted or not", () => {
  // Both learned from the server's own security pass: on a case-insensitive
  // filesystem `ORIGINALS/01.jpg` resolves to the real folder, so a
  // case-sensitive rule excludes it from the listing and offers it anyway.
  assert.equal(inSync("trips/alps/originals/01.jpg"), false);
  assert.equal(inSync("trips/alps/ORIGINALS/01.jpg"), false);
  assert.equal(inSync("trips/alps/track.json"), false);
  assert.equal(inSync("trips/alps/TRACK.json"), false);
});

test("the content is in — config, trips, drafts, inbox", () => {
  assert.equal(inSync("config.json"), true);
  assert.equal(inSync("trips/alps/trip.md"), true);
  assert.equal(inSync("trips/alps/entries/2026-01-01-a-day.md"), true);
  assert.equal(inSync("trips/alps/costs.md"), true);
  assert.equal(inSync("trips/alps/media/a-day/01.jpg"), true);
  assert.equal(inSync("inbox/media/abc123.jpg"), true);
  assert.equal(inSync("inbox/media/abc123.jpg.meta.json"), true);
});

test("nothing climbs out, and no dotfile travels", () => {
  assert.equal(inSync("../../etc/passwd"), false);
  assert.equal(inSync("/etc/passwd"), false);
  assert.equal(inSync("trips/../../x"), false);
  assert.equal(inSync(".fernscout-sync.json"), false);
  assert.equal(inSync("trips/alps/.ingest.json"), false);
  assert.equal(inSync("trips/alps/media/.DS_Store"), false);
  assert.equal(inSync("postcards/x.pdf"), false);
  assert.equal(inSync("photobooks/x.pdf"), false);
});

console.log("sync — the three-way compare");

const at = (hash) => ({ size: 1, hash });
const only = (actions, name) => actions.filter((a) => a.action === name).map((a) => a.path);

test("agreement is silence", () => {
  const actions = plan({ base: { a: at("1") }, local: { a: at("1") }, remote: { a: at("1") } });
  assert.deepEqual(actions, []);
});

test("one side moved — that side wins, no question asked", () => {
  const changedHere = plan({ base: { a: at("1") }, local: { a: at("2") }, remote: { a: at("1") } });
  assert.deepEqual(only(changedHere, "push"), ["a"]);
  const changedThere = plan({ base: { a: at("1") }, local: { a: at("1") }, remote: { a: at("2") } });
  assert.deepEqual(only(changedThere, "pull"), ["a"]);
});

test("both sides moved — conflict, and nothing else", () => {
  const actions = plan({ base: { a: at("1") }, local: { a: at("2") }, remote: { a: at("3") } });
  assert.deepEqual(only(actions, "conflict"), ["a"]);
  assert.deepEqual(only(actions, "push"), []);
  assert.deepEqual(only(actions, "pull"), []);
});

test("both sides made the same edit — not a conflict", () => {
  // The row that makes the difference between a useful guard and one that
  // fires on an honest run. Same bytes on both sides is agreement, however
  // they got there.
  assert.deepEqual(plan({ base: { a: at("1") }, local: { a: at("2") }, remote: { a: at("2") } }), []);
});

test("a local-only file is a push, not a conflict", () => {
  // This one was a real bug in B1495's throwaway client: it compared local
  // against base without asking whether the remote had moved at all, so a
  // laptop's own new day came back as a conflict and the step looked green
  // while exercising nothing.
  const actions = plan({ base: {}, local: { a: at("1") }, remote: {} });
  assert.deepEqual(only(actions, "push"), ["a"]);
  assert.deepEqual(only(actions, "conflict"), []);
});

test("a file new on both sides, never synced, is a conflict", () => {
  const actions = plan({ base: {}, local: { a: at("1") }, remote: { a: at("2") } });
  assert.deepEqual(only(actions, "conflict"), ["a"]);
});

test("a deletion is only a deletion when the other side did not move", () => {
  const goneHere = plan({ base: { a: at("1") }, local: {}, remote: { a: at("1") } });
  assert.deepEqual(only(goneHere, "delete-remote"), ["a"]);
  const goneThere = plan({ base: { a: at("1") }, local: { a: at("1") }, remote: {} });
  assert.deepEqual(only(goneThere, "delete-local"), ["a"]);
  // Deleted here, edited there: that is a disagreement about whether the day
  // should exist, and it is nobody's to settle quietly.
  const both = plan({ base: { a: at("1") }, local: {}, remote: { a: at("2") } });
  assert.deepEqual(only(both, "conflict"), ["a"]);
  // Gone from both is gone. Nothing to do, and no complaint about it.
  assert.deepEqual(plan({ base: { a: at("1") }, local: {}, remote: {} }), []);
});

test("a no-base run treats every difference as a conflict rather than a guess", () => {
  // A truncated or missing `.fernscout-sync.json` reads as no base at all, so
  // the two sides differing is "written on both sides, never synced" — which
  // stops, and writes nothing. The safe direction.
  const actions = plan({ base: {}, local: { a: at("1"), b: at("9") }, remote: { a: at("2") } });
  assert.deepEqual(only(actions, "conflict"), ["a"]);
  assert.deepEqual(only(actions, "push"), ["b"]);
});

console.log("sync — the deletion threshold");

test("more than half of one side is refused, not confirmed", () => {
  const remote = { a: at("1"), b: at("1"), c: at("1"), d: at("1") };
  const three = ["a", "b", "c"].map((path) => ({ path, action: "delete-remote" }));
  assert.equal(deletionRefusal(three, { local: {}, remote })?.side, "the site");
  const two = ["a", "b"].map((path) => ({ path, action: "delete-remote" }));
  assert.equal(deletionRefusal(two, { local: {}, remote }), null, "half exactly is an edit, not an accident");
});

test("nothing to delete is never a refusal", () => {
  assert.equal(deletionRefusal([], { local: {}, remote: {} }), null);
  assert.equal(deletionRefusal([{ path: "a", action: "pull" }], { local: {}, remote: { a: at("1") } }), null);
});

console.log("sync — a real folder on disk");

const dir = mkdtempSync(join(tmpdir(), "fernscout-sync-"));
try {
  mkdirSync(join(dir, "trips/alps/entries"), { recursive: true });
  mkdirSync(join(dir, "trips/alps/originals"), { recursive: true });
  mkdirSync(join(dir, "gps"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
  writeFileSync(join(dir, "trips/alps/entries/2026-01-01-a.md"), "---\ntitle: A\n---\n");
  writeFileSync(join(dir, "trips/alps/track.json"), "[]");
  writeFileSync(join(dir, "trips/alps/originals/01.jpg"), "big");
  writeFileSync(join(dir, "gps/2026-06.jsonl"), "[1757000000,46.9,7.4]\n");

  test("the walk carries the content and none of the three exclusions", () => {
    const files = localManifest(dir);
    assert.deepEqual(Object.keys(files).sort(), ["config.json", "trips/alps/entries/2026-01-01-a.md"]);
  });

  test("no coordinate reaches a manifest, by walk and not by comment", () => {
    const rendered = JSON.stringify(localManifest(dir));
    assert.equal(rendered.includes("gps"), false);
    assert.equal(rendered.includes("46.9"), false);
  });

  test("the base manifest round-trips, and a truncated one reads as none", () => {
    writeBase(dir, { site: "https://x.test", user: "u", files: localManifest(dir), syncedAt: "2026-09-12T00:00:00Z" });
    const read = readBase(dir);
    assert.equal(read.fresh, false);
    assert.equal(read.user, "u");
    assert.equal(Object.keys(read.files).length, 2);
    writeFileSync(join(dir, ".fernscout-sync.json"), '{"files": {"a": ');
    assert.equal(readBase(dir).fresh, true, "half a file is no file, not a thrown syntax error");
  });

  test("the state file never lists itself", () => {
    writeBase(dir, { site: "https://x.test", user: "u", files: {}, syncedAt: "2026-09-12T00:00:00Z" });
    assert.equal(Object.keys(localManifest(dir)).includes(".fernscout-sync.json"), false);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("config.json — which keys have a door (B1504, B1569)");

test("every field the instance accepts is in the list, and the three refusals are not", () => {
  // The list publish.mjs sends. It fell two fields behind the instance once
  // already (`ownerTel`, `travellers`), which is what B1569 is.
  for (const key of ["title", "tagline", "visibility", "startLocation", "units", "locales",
                     "defaultLocale", "displayCurrencies", "manualRates", "ownerTel", "travellers"]) {
    assert.ok(JOURNAL_UPDATE_DOORS.includes(key), `${key} has a door and is missing from the list`);
  }
  for (const key of Object.keys(JOURNAL_NO_UPDATE_DOOR)) {
    assert.ok(!JOURNAL_UPDATE_DOORS.includes(key), `${key} is refused on purpose and must never be sent`);
  }
  assert.deepEqual(Object.keys(JOURNAL_NO_UPDATE_DOOR).sort(), ["baseCurrency", "media", "owner"]);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
