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

test("track.json is out, shouted or not", () => {
  // Learned from the server's own security pass: on a case-insensitive
  // filesystem `TRACK.json` resolves to the real file, so a case-sensitive
  // rule excludes it from the listing and then offers it anyway.
  assert.equal(inSync("trips/alps/track.json"), false);
  assert.equal(inSync("trips/alps/TRACK.json"), false);
});

test("originals/ are IN, because the instance put them in (fernscout B1719)", () => {
  // They were out on both sides, on the reasoning that a print master is an
  // order of magnitude larger than what the site serves and belongs in a
  // filesystem backup — which is no reasoning at all for the owner of a
  // hosted journal, who has no filesystem to take one from.
  assert.equal(inSync("trips/alps/originals/2026-01-01-a-day/01.jpg"), true);
});

test("the content is in — config, trips, drafts, inbox", () => {
  assert.equal(inSync("config.json"), true);
  assert.equal(inSync("trips/alps/trip.json"), true);
  assert.equal(inSync("trips/alps/entries/2026-01-01-a-day.json"), true);
  assert.equal(inSync("trips/alps/media/2026-01-01-a-day/8b0cb97abe6c2f8be3e008296ad737d3.jpg"), true);
  assert.equal(inSync("trips/alps/media/2026-01-01-a-day/8b0cb97abe6c2f8be3e008296ad737d3.jpg.meta.json"), true);
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

test("a push the instance normalised is not a conflict on the next run", () => {
  // The one a real drive caught. The up leg goes through typed routes that
  // rewrite what they are given — frontmatter key order, a slug the instance
  // assigns — so a day that landed perfectly comes back with different bytes.
  // With one hash per base entry that is "both sides changed" forever, and
  // every successful push poisoned the file it pushed.
  const base = { a: { hash: "local-2", remote: "server-normalised-2" } };
  assert.deepEqual(plan({ base, local: { a: at("local-2") }, remote: { a: at("server-normalised-2") } }), []);
  // And a genuine edit on top of that still reads as a push, not a conflict.
  const after = plan({ base, local: { a: at("local-3") }, remote: { a: at("server-normalised-2") } });
  assert.deepEqual(only(after, "push"), ["a"]);
  assert.deepEqual(only(after, "conflict"), []);
});

test("an unpushed local edit is still a push on the next run, and the one after", () => {
  // The base is the last point the two sides *agreed*, not what they agree on
  // right now — and rebuilding it the second way is the obvious version and
  // is wrong. Caught on a real drive: edit a day locally, do not push it, and
  // the file drops out of the base, so the next run cannot tell "you changed
  // it" from "we differ" and calls a plain push a conflict.
  const base = { a: { hash: "1", remote: "1" } }, local = { a: at("2") }, remote = { a: at("1") };
  for (const _ of [1, 2, 3]) {
    const actions = plan({ base, local, remote });
    assert.deepEqual(only(actions, "push"), ["a"]);
    assert.deepEqual(only(actions, "conflict"), []);
  }
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
  writeFileSync(join(dir, "trips/alps/entries/2026-01-01-a.json"), "{}");
  writeFileSync(join(dir, "trips/alps/track.json"), "[]");
  writeFileSync(join(dir, "trips/alps/originals/01.jpg"), "big");
  writeFileSync(join(dir, "gps/2026-06.jsonl"), "[1757000000,46.9,7.4]\n");

  test("the walk carries the content, the masters, and none of the exclusions", () => {
    const files = localManifest(dir);
    assert.deepEqual(Object.keys(files).sort(), [
      "config.json",
      "trips/alps/entries/2026-01-01-a.json",
      "trips/alps/originals/01.jpg",
    ]);
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
    assert.equal(Object.keys(read.files).length, 3);
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

// The block that used to stand here checked `journalFields.mjs` — a
// hand-kept list of which keys of config.json have a door — against the
// instance. Both are gone: v2 generates its contract from the schemas its
// routes parse with, so a field that exists is in `/api/v2/openapi.json` by
// construction and there is no second list here to fall behind it. That was
// B1569's whole failure mode, and it is now structurally impossible rather
// than tested for.

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
