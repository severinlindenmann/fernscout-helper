#!/usr/bin/env node
// Do these tools still agree with the instance?
//
//   node .claude/skills/shared/selftest.mjs
//   FERNSCOUT_URL=http://127.0.0.1:3311 node .claude/skills/shared/selftest.mjs
//
// Runs the three test journals under `content/` through `validate-content` and
// checks each one says what it is supposed to say. It is a regression test for
// the *tools*, not for anybody's journal.
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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

/** What each fixture is for, and what it must say. `errors` is a floor: a new
 * check that finds something genuinely wrong in `luecken` is welcome, and one
 * that finds something wrong in the two clean ones is not. */
const EXPECTED = [
  { user: "perfekt", errors: 0, what: "every option set, and nothing wrong" },
  { user: "halbfertig", errors: 0, what: "valid and incomplete — incomplete is not wrong" },
  { user: "luecken", atLeast: 12, what: "one planted fault of each kind" },
];

const validate = join(ROOT, ".claude/skills/validate-content/validate.mjs");

let failed = 0;
for (const fixture of EXPECTED) {
  if (!existsSync(join(ROOT, "content", fixture.user))) {
    console.log(`— ${fixture.user}: not here, skipped`);
    continue;
  }
  let report;
  try {
    report = execFileSync(process.execPath, [validate, "--user", fixture.user, "--json"], {
      encoding: "utf8",
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

if (failed > 0) {
  console.log(
    `\n${failed} fixture${failed === 1 ? "" : "s"} did not say what it should.\n` +
    "Usually this means the instance has learned a field these tools have not.\n" +
    "Read the report — `node .claude/skills/validate-content/validate.mjs --user <name>` —\n" +
    "and if it calls a real field unknown, the fix is in shared/model.mjs.",
  );
}
process.exit(failed > 0 ? 1 : 0);
