#!/usr/bin/env node
// Do these tools still agree with the instance?
//
//   node .claude/skills/shared/selftest.mjs
//   FERNSCOUT_URL=http://127.0.0.1:3311 node .claude/skills/shared/selftest.mjs
//
// **This file used to be green while every write route in this repository
// answered 404**, and that is the first thing it now checks. `AGENTS.md` sold
// it as "do these tools still agree with the site?"; what it actually did was
// run fixtures through the validator and compare two documents the site
// publishes. It asserted nothing about a single route the skills call. The v2
// migration deleted the whole v1 write surface, and this stayed green through
// all of it — a real journal migration had to be made by hand to find out.
//
// So it does three things, in this order:
//
//   1. **Every route the skills call exists in the instance's own contract.**
//      Read out of `/api/v2/openapi.json` rather than asserted against a list
//      typed here — the point is to compare with the site, not with ourselves.
//      This is the check whose absence cost a fortnight.
//   2. **The unit tests run** — the contract reader, the frontmatter parser,
//      the converter, the folder walk, the sync compare, the publish flow.
//   3. **The fixtures still say what they should.** `perfekt` and
//      `halbfertig` are valid journals and must come back clean; `luecken` has
//      a planted fault of each kind and must come back with them. A validator
//      that stops noticing is the other way this rots.
//
// The fixtures are v1 folders — the shape these tools wrote before B1715 — and
// they stay that way on purpose: they are what `convert.mjs` takes as input,
// and a converter with no real folder to convert is not tested. Each one is
// converted into a temporary directory and the v2 checks run there.
//
// A fixture that has gone missing is a broken test, not a skipped one: it used
// to print "not here, skipped" and exit 0, which is exactly how a self-test
// stops testing anything without anybody noticing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./lib.mjs";
import { openapi } from "./api.mjs";

const FIXTURES = join(ROOT, ".claude/skills/shared/fixtures");
let failed = 0;
const ok = (line) => console.log(`✓ ${line}`);
const bad = (line) => { console.log(`✗ ${line}`); failed += 1; };

// ── 1. every route these skills call, against the instance's own contract ──
//
// One entry per call this repository makes. Adding a call without adding it
// here is the only way back to where B1715 found this repository, and the list
// is short enough to keep true.
const CALLS = [
  ["GET", "/api/v2/status", "the limits and capabilities every tool reads"],
  ["GET", "/api/v2/openapi.json", "the contract itself"],
  ["GET", "/api/v2/{user}", "publish: does this journal exist"],
  ["GET", "/api/v2/{user}/trips/{trip}", "publish, validate: what the instance holds"],
  ["PUT", "/api/v2/{user}/trips/{trip}", "publish: create a trip at a client-chosen id"],
  ["PATCH", "/api/v2/{user}/trips/{trip}", "publish: correct one"],
  ["GET", "/api/v2/{user}/trips/{trip}/days/{slug}", "publish, validate: read a day back"],
  ["PUT", "/api/v2/{user}/trips/{trip}/days/{slug}", "publish: write a day"],
  ["PATCH", "/api/v2/{user}/trips/{trip}/days/{slug}", "publish: correct a day"],
  ["POST", "/api/v2/{user}/trips/{trip}/days/{slug}/publish", "publish: put it on the site"],
  ["POST", "/api/v2/{user}/media", "publish: upload a photograph with its intent"],
  ["PUT", "/api/v2/{user}/figures/{id}", "publish: the figure library"],
  ["GET", "/api/v2/{user}/figures/{id}", "publish: is this figure already there"],
  ["GET", "/api/v2/{user}/sync/manifest", "sync: what the site holds, hashed"],
  ["GET", "/api/v2/{user}/sync/file/{path}", "sync: one file's bytes"],
  ["POST", "/api/v2/{user}/import", "gps-history, statement-costs: hand a file to the instance"],
];

let contract = null;
try {
  contract = (await openapi({ refresh: true })).doc;
} catch (error) {
  bad(`could not read the contract: ${error.message}`);
}

if (contract) {
  const missing = CALLS.filter(([verb, path]) => !contract.paths?.[path]?.[verb.toLowerCase()]);
  if (missing.length) {
    for (const [verb, path, why] of missing) bad(`${verb} ${path} — ${why} — is not in the instance's contract`);
  } else {
    ok(`all ${CALLS.length} routes these skills call are in the instance's contract`);
  }

  // The asked-or-declined list, read rather than copied. A tool that cannot
  // see it cannot tell a person which sections are still open.
  const day = contract.paths["/api/v2/{user}/trips/{trip}/days/{slug}"]?.put;
  const schema = (day?.requestBody ?? day?.request)?.content?.["application/json"]?.schema;
  const declinables = schema?.["x-required-or-declined"];
  if (Array.isArray(declinables) && declinables.length) {
    ok(`the day contract names ${declinables.length} sections that must be answered or declined`);
  } else {
    bad("the day contract publishes no x-required-or-declined list — the tools cannot tell anybody what is open");
  }
}

// ── 2. the unit tests ──────────────────────────────────────────────────────
const UNIT = [
  ".claude/skills/shared/api.test.mjs",
  ".claude/skills/shared/frontmatter.test.mjs",
  ".claude/skills/shared/journal.test.mjs",
  ".claude/skills/shared/convert.test.mjs",
  ".claude/skills/sync/sync.test.mjs",
  ".claude/skills/publish/publish.test.mjs",
  ".claude/skills/icloud-export/build.test.mjs",
  ".claude/skills/icloud-export/build.metadata.test.mjs",
  ".claude/skills/icloud-export/review.test.mjs",
  ".claude/skills/icloud-export/review.server.test.mjs",
  ".claude/skills/icloud-export/describe.test.mjs",
  ".claude/skills/icloud-export/narrow.test.mjs",
  ".claude/skills/icloud-export/export.test.mjs",
  // Written with find-trips and never added here, so the two rules that cost a
  // whole day of somebody's journal — a day is a journey not a point, a
  // household is not one unit — were tested by nothing that ever ran.
  ".claude/skills/find-trips/discover.test.mjs",
];
for (const test of UNIT) {
  const path = join(ROOT, test);
  if (!existsSync(path)) { bad(`${test} is missing`); continue; }
  try {
    execFileSync(process.execPath, [path], { encoding: "utf8", stdio: "pipe" });
    ok(test);
  } catch (error) {
    const lines = String(error.stdout ?? "").split("\n").filter((l) => l.includes("✗")).slice(0, 5).join("\n");
    bad(`${test}${lines ? `\n${lines}` : ""}`);
  }
}

// ── 3. the fixtures, converted and then checked ───────────────────────────
/** What each fixture is for, and what it must say after conversion. `errors`
 * is exact where the answer is "none"; `atLeast` is a floor, because a
 * validator noticing MORE about a deliberately broken journal is not a
 * regression. */
const EXPECTED = [
  { user: "perfekt", errors: 0, what: "every option set, and it is a valid journal" },
  { user: "halbfertig", errors: 0, what: "valid and incomplete — incomplete is not wrong" },
  { user: "luecken", atLeast: 1, what: "a planted fault of each kind, and they must still be found" },
];

const converted = mkdtempSync(join(tmpdir(), "fernscout-selftest-"));
try {
  for (const fixture of EXPECTED) {
    if (!existsSync(join(FIXTURES, fixture.user))) {
      bad(`${fixture.user}: missing — expected a fixture at ${join(FIXTURES, fixture.user)}`);
      continue;
    }
    try {
      execFileSync(process.execPath, [
        join(ROOT, ".claude/skills/shared/convert.mjs"), fixture.user,
        "--into", join(converted, fixture.user), "--force",
      ], { env: { ...process.env, FERNSCOUT_CONTENT_DIR: FIXTURES }, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      bad(`${fixture.user}: the converter failed — ${String(error.stderr ?? error.stdout ?? "").split("\n")[0]}`);
      continue;
    }

    // Offline: the disk half. What the instance would accept is checked
    // against the instance by validating a real journal, not by sending
    // fixture journals to a live server that has never heard of them.
    let report;
    try {
      report = execFileSync(process.execPath, [
        join(ROOT, ".claude/skills/validate-content/validate.mjs"),
        "--user", fixture.user, "--json", "--offline",
      ], { env: { ...process.env, FERNSCOUT_CONTENT_DIR: converted }, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      report = String(error.stdout ?? "");
    }
    let found;
    try { found = JSON.parse(report).found; }
    catch { bad(`${fixture.user}: the validator did not answer with JSON`); continue; }

    const errors = found.filter((f) => f.severity === "error").length;
    const warns = found.filter((f) => f.severity === "warn").length;
    const passed = fixture.errors !== undefined ? errors === fixture.errors : errors >= fixture.atLeast;
    const how = fixture.errors !== undefined ? `${fixture.errors}` : `at least ${fixture.atLeast}`;
    const line = `${fixture.user.padEnd(12)} ${errors} error${errors === 1 ? "" : "s"}, ` +
      `${warns} warning${warns === 1 ? "" : "s"} — expected ${how}. ${fixture.what}`;
    if (passed) ok(line);
    else {
      bad(line);
      for (const f of found.filter((f) => f.severity === "error").slice(0, 5)) {
        console.log(`      ${f.where}: ${f.message}`);
      }
    }
  }
} finally {
  rmSync(converted, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
