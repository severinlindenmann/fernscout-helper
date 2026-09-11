#!/usr/bin/env node
// Do these tools still agree with the instance?
//
//   node .claude/skills/shared/selftest.mjs
//   FERNSCOUT_URL=http://127.0.0.1:3311 node .claude/skills/shared/selftest.mjs
//
// Runs the three test journals under `.claude/skills/shared/fixtures/`
// through `validate-content` and checks each one says what it is supposed to
// say. It is a regression test for the *tools*, not for anybody's journal.
//
// It exists because of a drift that happened exactly once and would have
// happened again. The server gained a third answer for a day whose costs
// nobody recorded — `unrecorded: [costs]` beside `without: [costs]` — and
// these tools did not know the key. A journal carrying it was reported as
// having two errors, both of them wrong: *unrecorded is not a field*, and
// *the trip tracks costs and this day says nothing about it*. The validator
// was working correctly; it simply had not been told. Nothing failed until
// somebody ran it by hand.
//
// So: `perfekt` is a journal with every option set and must come back clean.
// `halbfertig` is valid and incomplete and must also come back clean, because
// incomplete is not wrong. `luecken` has one planted fault of each kind and
// must come back with all of them — a validator that stops noticing is the
// other way this rots.
//
// The fixtures live beside this script rather than under `content/`, because
// `content/` is gitignored — correctly, it is where somebody's own
// photographs go — and a fixture that only exists on the machine that wrote
// it is not a regression test, it is a folder. `FERNSCOUT_CONTENT_DIR` below
// is the one thing that points `validate.mjs` at the fixtures instead;
// nothing else ever sets it, so a real run against `content/` is unaffected.
//
// A fixture that has gone missing is a broken test, not a skipped one: it
// used to print "not here, skipped" and exit 0, which is exactly how this
// self-test could stop testing anything and nobody would notice. Now it is a
// hard failure, loud and non-zero.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { openapi, contentModel } from "./api.mjs";
import { apiOnlyDrift, readSnapshot, snapshotDrift } from "./contentModel.mjs";

const FIXTURES = join(ROOT, ".claude/skills/shared/fixtures");

/** What each fixture is for, and what it must say. `errors` is a floor: a new
 * check that finds something genuinely wrong in `luecken` is welcome, and one
 * that finds something wrong in the two clean ones is not. */
const EXPECTED = [
  { user: "perfekt", errors: 0, what: "every option set, and nothing wrong" },
  { user: "halbfertig", errors: 0, what: "valid and incomplete — incomplete is not wrong" },
  // B644: 24 -> 26. Two more planted faults were added so this fixture
  // actually exercises the two named checks the document just gained —
  // `entries/2026-13-40-badcalendar.md` (a date that matches the YYYY-MM-DD
  // shape but is not a real calendar date) and `costs.md`'s `budget.days: -3`
  // (present, but not positive) — rather than leaving them declared and
  // implemented with nothing in any fixture ever tripping them.
  { user: "luecken", atLeast: 26, what: "one planted fault of each kind" },
];

const validate = join(ROOT, ".claude/skills/validate-content/validate.mjs");

let failed = 0;
let missing = 0;
for (const fixture of EXPECTED) {
  if (!existsSync(join(FIXTURES, fixture.user))) {
    // Absent must fail loudly. It used to print "not here, skipped" and exit
    // 0 — indistinguishable from every fixture passing — which is the whole
    // bug this file exists to fix.
    console.log(`✗ ${fixture.user}: missing — expected a fixture at ${join(FIXTURES, fixture.user)}`);
    missing += 1;
    continue;
  }
  let report;
  try {
    report = execFileSync(process.execPath, [validate, "--user", fixture.user, "--json"], {
      encoding: "utf8",
      env: { ...process.env, FERNSCOUT_CONTENT_DIR: FIXTURES },
    });
  } catch (refused) {
    // The validator exits non-zero when it finds errors, which is most of the
    // point for `luecken` — the report is on stdout either way.
    report = refused.stdout ?? "";
  }

  let counts;
  try {
    counts = JSON.parse(report).counts;
  } catch {
    console.log(`✗ ${fixture.user}: the validator did not answer with JSON`);
    failed += 1;
    continue;
  }

  const wanted = fixture.errors ?? fixture.atLeast;
  const ok = fixture.errors !== undefined ? counts.error === fixture.errors : counts.error >= fixture.atLeast;
  const how = fixture.errors !== undefined ? `${wanted}` : `at least ${wanted}`;
  console.log(
    `${ok ? "✓" : "✗"} ${fixture.user.padEnd(12)} ${counts.error} error${counts.error === 1 ? "" : "s"}, ` +
    `${counts.warn} warning${counts.warn === 1 ? "" : "s"} — expected ${how}. ${fixture.what}`,
  );
  if (!ok) failed += 1;
}

// The blind spot no fixture can reach at all: `apiOnly` keys never appear in
// a file, so `checkKeys()` skips them (B585), and — since B610 — the
// manifest itself says nothing about their type either (a `never-in-file`
// rule only ever carries `because`, confirmed against a live document). This
// is the guard for exactly that gap — it does not validate a journal, it
// checks `contentModel.mjs`'s own `API_ONLY_TYPES` table, the one piece of
// B585's fix a published document has no vocabulary for, against the
// instance's live request schema.
let apiOnlyFailed = 0;
try {
  const { doc, from, site } = await openapi({});
  const drift = apiOnlyDrift(doc);
  if (drift.length) {
    apiOnlyFailed = drift.length;
    console.log(`\n✗ apiOnly drift — this repository's assumptions disagree with ${site} (schema from ${from}) about ${drift.length} key${drift.length === 1 ? "" : "s"}:`);
    for (const d of drift) console.log(`    ${d.file} ${d.key}: ${d.why}`);
  } else {
    console.log(`✓ apiOnly keys — this repository's declared types agree with ${site} (schema from ${from})`);
  }
} catch (failure) {
  apiOnlyFailed = 1;
  console.log(`✗ apiOnly drift check could not run: ${failure.message}`);
}

// The whole reason a committed snapshot is acceptable at all (B610, in place
// of the `model.mjs` copy that rotted more than once): it is compared to the
// live document on every run, and a run where they disagree fails, loudly,
// naming the disagreement, rather than the snapshot quietly drifting the way
// the hand-kept copy did. This only runs online — there is nothing to
// compare a snapshot against without the live document to compare it to.
let snapshotFailed = 0;
try {
  const { doc, from, site } = await contentModel({});
  if (!doc) {
    console.log(`✗ snapshot check could not run — ${site ?? "the instance"} publishes no content-model.json to compare against`);
    snapshotFailed = 1;
  } else {
    const snapshot = readSnapshot();
    const drift = snapshotDrift(doc, snapshot);
    if (drift.length) {
      snapshotFailed = drift.length;
      console.log(`\n✗ snapshot drift — content-model.snapshot.json disagrees with the live document (from ${from}):`);
      for (const d of drift) console.log(`    ${d}`);
    } else {
      console.log(`✓ snapshot agrees with the live document (from ${from}, taken ${snapshot.snapshotTakenAt})`);
    }
  }
} catch (failure) {
  snapshotFailed = 1;
  console.log(`✗ snapshot check could not run: ${failure.message}`);
}

if (missing > 0) {
  console.log(
    `\n${missing} fixture${missing === 1 ? "" : "s"} missing — this self-test proved nothing for ${missing === 1 ? "it" : "them"}.\n` +
    `Fixtures live at ${FIXTURES}; restore ${missing === 1 ? "it" : "them"} from git rather than skipping the run.`,
  );
}
if (failed > 0) {
  console.log(
    `\n${failed} fixture${failed === 1 ? "" : "s"} did not say what it should.\n` +
    "Usually this means the instance has learned a field these tools have not.\n" +
    "Read the report — `node .claude/skills/validate-content/validate.mjs --user <name>` —\n" +
    "and if it calls a real field unknown, the fix is in the fernscout repo's content-model.json —\n" +
    "this repository only reads it.",
  );
}
if (apiOnlyFailed > 0) {
  console.log(
    "\nAn apiOnly key's declared type does not match what the instance now publishes.\n" +
    "That key never appears in a file, so no fixture could have caught this — see B585.\n" +
    "The fix is in the fernscout repo's content-model.json.",
  );
}
if (snapshotFailed > 0) {
  console.log(
    "\ncontent-model.snapshot.json is out of date. Refresh it with:\n" +
    "  node .claude/skills/shared/snapshot.mjs\n" +
    "and commit the result — never hand-edit the JSON.",
  );
}
// publish.mjs's own logic — matching a local file to a remote day, and
// whether a dry run can plan for a trip the instance does not have yet — has
// no fixture journal that can exercise it, because the bug is in how it talks
// to an instance rather than in what a journal says. `publish.test.mjs` runs
// it against a fake one in-process (B647, B648).
let publishFailed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, ".claude/skills/publish/publish.test.mjs")], { stdio: "inherit" });
} catch {
  publishFailed = 1;
}

// B1401: a stopped YAML parse has to say so explicitly, and block scalars
// (`|`/`>`) have to be read rather than triggering a stop at all.
let frontmatterFailed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, ".claude/skills/shared/frontmatter.test.mjs")], { stdio: "inherit" });
} catch {
  frontmatterFailed = 1;
}

// B645: a real photograph through build.mjs, checked afterwards — the one
// part of this repository that transforms somebody's own files, and the one
// part nothing here used to run at all.
let buildFailed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, ".claude/skills/icloud-export/build.test.mjs")], { stdio: "inherit" });
} catch {
  buildFailed = 1;
}

// B646: the review page has to preview what actually gets published.
let reviewFailed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, ".claude/skills/icloud-export/review.test.mjs")], { stdio: "inherit" });
} catch {
  reviewFailed = 1;
}

// B649/B650: which photo build.mjs trusts for a day's time and coordinates.
let metadataFailed = 0;
try {
  execFileSync(process.execPath, [join(ROOT, ".claude/skills/icloud-export/build.metadata.test.mjs")], { stdio: "inherit" });
} catch {
  metadataFailed = 1;
}

process.exit(
  failed > 0 || missing > 0 || apiOnlyFailed > 0 || snapshotFailed > 0 ||
  publishFailed > 0 || frontmatterFailed > 0 || buildFailed > 0 || reviewFailed > 0 || metadataFailed > 0 ? 1 : 0,
);
