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
import { openapi } from "./api.mjs";
import { apiOnlyDrift } from "./model.mjs";

const FIXTURES = join(ROOT, ".claude/skills/shared/fixtures");

/** What each fixture is for, and what it must say. `errors` is a floor: a new
 * check that finds something genuinely wrong in `luecken` is welcome, and one
 * that finds something wrong in the two clean ones is not. */
const EXPECTED = [
  { user: "perfekt", errors: 0, what: "every option set, and nothing wrong" },
  { user: "halbfertig", errors: 0, what: "valid and incomplete — incomplete is not wrong" },
  { user: "luecken", atLeast: 24, what: "one planted fault of each kind" },
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

// The blind spot the three fixtures above cannot reach at all: `apiOnly`
// keys never appear in a file, so `checkKeys()` skips them and no fixture,
// however carefully planted, can exercise one (B585). This is the guard for
// exactly that gap — it does not validate a journal, it validates
// `model.mjs` itself, by comparing every `apiOnly` key that declares a
// `type` against the instance's own published schema for that field.
let apiOnlyFailed = 0;
try {
  const { doc, from, site } = await openapi({});
  const drift = apiOnlyDrift(doc);
  if (drift.length) {
    apiOnlyFailed = drift.length;
    console.log(`\n✗ apiOnly drift — model.mjs disagrees with ${site} (schema from ${from}) about ${drift.length} key${drift.length === 1 ? "" : "s"}:`);
    for (const d of drift) console.log(`    ${d.file} ${d.key}: ${d.why}`);
  } else {
    console.log(`✓ apiOnly keys — model.mjs's declared types agree with ${site} (schema from ${from})`);
  }
} catch (failure) {
  apiOnlyFailed = 1;
  console.log(`✗ apiOnly drift check could not run: ${failure.message}`);
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
    "and if it calls a real field unknown, the fix is in shared/model.mjs.",
  );
}
if (apiOnlyFailed > 0) {
  console.log(
    "\nmodel.mjs's declared type for an apiOnly key does not match what the instance now publishes.\n" +
    "That key never appears in a file, so no fixture could have caught this — see B585.\n" +
    "Fix the note and the type in shared/model.mjs to say what the schema now says.",
  );
}
process.exit(failed > 0 || missing > 0 || apiOnlyFailed > 0 ? 1 : 0);
