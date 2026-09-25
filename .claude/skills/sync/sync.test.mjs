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
  contentHash, deletionRefusal, inSync, localManifest, plan, readBase, servedDerivative, writeBase,
} from "../shared/syncManifest.mjs";
import { sameAsWritten } from "../shared/api.mjs";

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

test("the figure library is in — fernscout B1776", () => {
  // Journal content the instance holds and the folder could not mirror: they
  // travelled in neither direction, so a hosted owner had no copy of their own
  // figures and restoring one was a hand job.
  assert.equal(inSync("figures/walker-1.json"), true);
  assert.equal(inSync("FIGURES/walker-1.JSON"), true);
  // The folder holds documents and nothing else — no preview, no stray image.
  assert.equal(inSync("figures/walker-1.png"), false);
  assert.equal(inSync("figures"), false);
  assert.equal(inSync("figures/nested/walker-1.json"), false);
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

// ── what the site makes and this side cannot — B1789 ───────────────────────
test("a served photograph is the site's own work; a master and a sidecar are not", () => {
  // The bytes under media/ are derived from an upload. Nothing here can make
  // them or send them, and what a folder holds at that path after a publish is
  // the original the upload staged — so the two sides differ for ever unless
  // the site's copy wins.
  assert.equal(servedDerivative("trips/budapest-2023/media/2023-07-08-morgen/b12e.jpg"), true);
  assert.equal(servedDerivative("trips/budapest-2023/media/2023-07-08-morgen/b12e.mp4"), true);
  // The sidecar beside it is a document, and is compared as one.
  assert.equal(servedDerivative("trips/budapest-2023/media/2023-07-08-morgen/b12e.jpg.meta.json"), false);
  // A print master is not derived from anything: two sides differing there is
  // a real difference and nobody should overwrite it quietly.
  assert.equal(servedDerivative("trips/budapest-2023/originals/2023-07-08-morgen/b12e.jpg"), false);
  // Not a photograph on a day at all.
  assert.equal(servedDerivative("trips/budapest-2023/entries/2023-07-08-morgen.json"), false);
  assert.equal(servedDerivative("inbox/2023-07/b12e.jpg"), false);
  assert.equal(servedDerivative("trips/budapest-2023/b12e.jpg"), false);
});

test("a photograph uploaded without a day is the site's own work too", () => {
  // The instance files a day-less upload straight under media/ — four
  // segments, not five. Missing it here is B1789 again: a "local change"
  // every run that no action clears.
  assert.equal(servedDerivative("trips/budapest-2023/media/b12e.jpg"), true);
  assert.equal(servedDerivative("trips/budapest-2023/media/b12e.mp4"), true);
  assert.equal(servedDerivative("trips/budapest-2023/media/b12e-poster.jpg"), true);
  assert.equal(servedDerivative("trips/budapest-2023/media/b12e.jpg.meta.json"), false);
  assert.equal(servedDerivative("trips/budapest-2023/originals/b12e.jpg"), false);
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

console.log("sync — one fact, two spellings");

// ── the one field the two sides spell differently — B1787 ──────────────────
//
// A day written `weather: true` comes back carrying a reading sourced
// `open-meteo`, which no caller may send. So a folder and the site hold two
// spellings of one fact, `plan()` rightly calls that a local change, and the
// push that follows changes nothing on the site — which `landed()` then reads
// as a push that did not land, so the baseline is never written and the next
// run plans it again. 139 files on one real journal, every run, for ever.
//
// This is the question that breaks the loop: would sending this say anything
// the site does not already say?
test("the ask and the answer it produced are the same document", () => {
  const sources = ["open-meteo"];
  const here = { title: "Hoi An", weather: true };
  const site = { title: "Hoi An", weather: { source: "open-meteo", tempC: 31.2, summary: "clear" } };
  assert.equal(sameAsWritten(here, site, sources), true);
  assert.equal(sameAsWritten(site, here, sources), true);
});

test("the site's own draft-or-published is the site's to say", () => {
  // `status: "draft"` is the only value a caller may write; publishing is its
  // own call. So a folder that says draft where the site says published is not
  // holding an edit — it is holding a field it cannot send.
  assert.equal(sameAsWritten(
    { title: "Davos", status: "draft", weather: true },
    { title: "Davos", status: "published", weather: { source: "open-meteo", tempMax: 0.4 } },
    ["open-meteo"],
  ), true);
});

test("a re-ordered key is not an edit", () => {
  // The typed routes normalise what they are given, so the site's copy of a
  // day this folder wrote is not byte-identical to what was sent.
  assert.equal(
    sameAsWritten({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }, ["open-meteo"]),
    true,
  );
});

test("anything else that differs is still a push", () => {
  const sources = ["open-meteo"];
  // The title moved. Same weather, different day.
  assert.equal(sameAsWritten(
    { title: "Hoi An, again", weather: true },
    { title: "Hoi An", weather: { source: "open-meteo", tempC: 31.2 } },
    sources,
  ), false);
  // Somebody's own instrument is not the server's, and travels whole — two
  // different readings are two different documents.
  assert.equal(sameAsWritten(
    { weather: { source: "my-station", tempC: 31.2 } },
    { weather: { source: "my-station", tempC: 18.0 } },
    sources,
  ), false);
  // A reading the server did not make cannot be folded into the ask.
  assert.equal(sameAsWritten(
    { weather: true },
    { weather: { source: "my-station", tempC: 31.2 } },
    sources,
  ), false);
  // Photographs are a sequence; a different sequence is a different day.
  assert.equal(sameAsWritten({ media: [{ src: "a" }, { src: "b" }] }, { media: [{ src: "b" }, { src: "a" }] }, sources), false);
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
