#!/usr/bin/env node
// The proof this ticket asks for, not an eyeball check: that the three
// fixture journals come back with *identical* findings whether the file
// shape came from `<site>/content-model.json` or from `shared/model.mjs`,
// and that each of the four edges — an unknown `assert` kind, an
// unimplemented `named` check, an unsupported major version, and no
// manifest at all — is reported by name rather than skipped.
//
//   node .claude/skills/shared/contentModel.test.mjs
//
// It runs a small local instance of its own — a plain `node:http` server —
// rather than reaching across the network for `openapi.json` and
// `/api/health`: those two are not this ticket's concern and must stay fixed
// across every scenario for the comparison to mean anything, and the real
// `content-model.json` 404s today regardless (B608 is still being built).
// The `openapi.json` and `/api/health` bodies served are read from whatever
// is already cached for the real site — `api.mjs`'s existing machinery
// fetches them once if there is nothing cached yet — so this test is
// checking the interpreter, not re-deriving somebody else's contract.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "./lib.mjs";
import { openapi, health } from "./api.mjs";

const execFileAsync = promisify(execFile);

const FIXTURES = join(ROOT, ".claude/skills/shared/fixtures");

/**
 * A one-trip probe journal, written fresh into a scratch directory rather
 * than kept beside the three committed fixtures — it exists only to prove
 * the interpreter is genuinely being consulted (see below), and a fixture
 * that changed `perfekt`/`halbfertig`/`luecken`'s own counts would break the
 * one thing `selftest.mjs` exists to hold steady.
 */
function writeProbeJournal() {
  const root = mkdtempSync(join(tmpdir(), "content-model-probe-"));
  const tripDir = join(root, "badid", "trips", "Bad_Trip");
  mkdirSync(join(tripDir, "entries"), { recursive: true });
  writeFileSync(join(root, "badid", "config.json"), JSON.stringify({ title: "Probe", defaultLocale: "en", locales: ["en"] }));
  writeFileSync(join(tripDir, "trip.md"),
    "---\nid: Bad_Trip\ntitle: Probe trip\nstart: 2026-01-01\nend: 2026-01-01\n---\nIntro.\n");
  writeFileSync(join(tripDir, "entries", "2026-01-01-day.md"),
    "---\ntitle: Day one\ndate: 2026-01-01\n---\nContent.\n");
  return root; // FERNSCOUT_CONTENT_DIR points at the parent of "badid/"
}
const PROBE = writeProbeJournal();
const VALIDATE = join(ROOT, ".claude/skills/validate-content/validate.mjs");

const { doc: openapiDoc } = await openapi({});
const { doc: healthDoc } = await health({});

let scenario = { status: 404 }; // content-model.json response for the current run
const server = createServer((req, res) => {
  if (req.url === "/openapi.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(openapiDoc));
  } else if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(healthDoc));
  } else if (req.url === "/content-model.json") {
    if (scenario.status === 404) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(scenario.status ?? 200, { "content-type": "application/json" });
    res.end(scenario.raw ?? JSON.stringify(scenario.body));
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${server.address().port}`;

// The cache directory `api.mjs` writes to keys its filenames off the site
// string, so a fresh mock server (a new port every run of this file) never
// collides with a real cached schema. `--refresh` still forces every
// invocation below past the freshness check regardless, since several
// scenarios reuse this one port with a different `content-model.json` body.
// `execFile`, not `execFileSync` — the mock server above lives in this same
// process, on this same event loop, and a *synchronous* spawn blocks that
// loop for as long as the child runs, which means the child's request back
// to `http://127.0.0.1:PORT` never gets accepted and the whole thing hangs
// until the child's own timeout kills it. Awaiting the async form lets the
// server keep answering while the child (`validate.mjs`) is running.
async function runValidate(user, extraEnv = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [VALIDATE, "--user", user, "--json", "--refresh"], {
      encoding: "utf8",
      env: { ...process.env, FERNSCOUT_URL: SITE, FERNSCOUT_CONTENT_DIR: FIXTURES, ...extraEnv },
    }));
  } catch (refused) {
    stdout = refused.stdout ?? "";
  }
  return JSON.parse(stdout);
}

/** The non-JSON report carries the one line this test also needs to see —
 * "File shape from …" — which `--json` mode deliberately keeps out of the
 * machine-readable report. */
async function runValidateText(user) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [VALIDATE, "--user", user, "--refresh"], {
      encoding: "utf8",
      env: { ...process.env, FERNSCOUT_URL: SITE, FERNSCOUT_CONTENT_DIR: FIXTURES },
    });
    return stdout;
  } catch (refused) {
    return refused.stdout ?? "";
  }
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

// ── the acceptance line that matters most: identical findings, either source ──
scenario = { status: 404 };
const fromModel = {};
for (const user of ["perfekt", "halbfertig", "luecken"]) fromModel[user] = await runValidate(user);
for (const [user, report] of Object.entries(fromModel)) {
  check(`${user}: model.mjs fallback ran at all`, Array.isArray(report.found), `${report.counts?.error} errors`);
}

scenario = { status: 200, body: readFixture("content-model.json") };
const fromManifest = {};
for (const user of ["perfekt", "halbfertig", "luecken"]) fromManifest[user] = await runValidate(user);

for (const user of ["perfekt", "halbfertig", "luecken"]) {
  const a = JSON.stringify(fromModel[user]);
  const b = JSON.stringify(fromManifest[user]);
  check(`${user}: identical findings from content-model.json and model.mjs`, a === b,
    a === b ? `${fromModel[user].counts.error}e/${fromModel[user].counts.warn}w/${fromModel[user].counts.tip}t, both sources` :
      `model.mjs: ${a.length} chars, manifest: ${b.length} chars`);
}

// ── the manifest is genuinely being read, not just present ──
// A journal-shaped comparison of "the same rule set, byte for byte" proves
// the interpreter agrees with `model.mjs` — it does not by itself prove the
// interpreter is the one that actually ran. So: a one-trip probe journal
// (outside the three committed fixtures, so this cannot move their counts)
// whose `id: Bad_Trip` violates `trip.md`'s `id` pattern, checked once with
// that `pattern` rule in the manifest and once with it deleted from the
// manifest. If the finding disappears exactly when the rule does, the
// pattern in the manifest — not some hidden copy — is what caught it.
{
  const withRule = readFixture("content-model.json");
  scenario = { status: 200, body: withRule };
  const withPattern = await runValidate("badid", { FERNSCOUT_CONTENT_DIR: PROBE });

  const withoutRule = readFixture("content-model.json");
  withoutRule.files["trip.md"].keys.id.asserts = withoutRule.files["trip.md"].keys.id.asserts.filter((a) => a.assert !== "pattern");
  scenario = { status: 200, body: withoutRule };
  const withoutPattern = await runValidate("badid", { FERNSCOUT_CONTENT_DIR: PROBE });

  const patternFinding = (report) => report.found.some((f) => f.message === 'id is "Bad_Trip"');
  const caughtWithPattern = patternFinding(withPattern);
  const caughtWithoutPattern = patternFinding(withoutPattern);
  check("removing the id: pattern rule from the manifest changes what the probe journal reports",
    caughtWithPattern && !caughtWithoutPattern,
    `with pattern: ${caughtWithPattern}, without: ${caughtWithoutPattern}`);
}

// ── the four edges, each reported by name ──

// 1. an assert kind the interpreter does not know
{
  scenario = { status: 200, body: readFixture("content-model-bad-assert.json") };
  const report = await runValidate("perfekt");
  const hit = report.found.find((f) => f.where === "(content-model)" && /assert "regex-eval" is not one this client knows/.test(f.message));
  check("unknown assert kind is reported by name", Boolean(hit), hit?.message);
}

// 2. a named check the client has not implemented
{
  scenario = { status: 200, body: readFixture("content-model-with-named.json") };
  const report = await runValidate("perfekt");
  const hit = report.found.find((f) => f.where === "(content-model)" && /named check "day-answers-tracked-fields" is declared but this client has not implemented it/.test(f.message));
  check("unimplemented named check is reported by name", Boolean(hit), hit?.message);
}

// 3. a major version the interpreter does not understand → refuse and say so
{
  scenario = { status: 200, body: readFixture("content-model-bad-version.json") };
  const text = await runValidateText("perfekt");
  const line = text.split("\n").find((l) => l.startsWith("File shape from"));
  const refused = /model\.mjs/.test(line ?? "") && /contentModel version 2/.test(line ?? "");
  check("unsupported major version refuses the manifest and says so", refused, line);
  // And it must actually have fallen back to model.mjs's rules, not run with
  // an empty one — same findings as the plain 404 case proves that.
  const report = await runValidate("perfekt");
  check("…and still validates (falls back to model.mjs, not to nothing)",
    JSON.stringify(report) === JSON.stringify(fromModel.perfekt), `${report.counts.error} errors`);
}

// 4. no manifest at all → file-shape checks only, and say which run it got
{
  scenario = { status: 404 };
  const text = await runValidateText("perfekt");
  const line = text.split("\n").find((l) => l.startsWith("File shape from"));
  const said = /model\.mjs/.test(line ?? "") && /publishes no \/content-model\.json/.test(line ?? "");
  check("no manifest at all is reported by name", said, line);
}

server.close();
rmSync(join(ROOT, "export", ".schema", `${SITE.replace(/[^a-z0-9]+/gi, "-")}-content-model.json`), { force: true });
rmSync(join(ROOT, "export", ".schema", `${SITE.replace(/[^a-z0-9]+/gi, "-")}.json`), { force: true });
rmSync(join(ROOT, "export", ".schema", `${SITE.replace(/[^a-z0-9]+/gi, "-")}-health.json`), { force: true });
rmSync(PROBE, { recursive: true, force: true });

if (failed > 0) console.log(`\n${failed} check${failed === 1 ? "" : "s"} did not say what it should.`);
process.exit(failed > 0 ? 1 : 0);
