#!/usr/bin/env node
// Regression coverage for B647 and B648 — a fake instance in-process, plain
// node:http, no dependencies. Neither bug shows up in `validate-content`'s
// fixtures: both are about how `publish.mjs` matches a local file against
// what the instance already holds, which only exists once there is a server
// on the other end of the call.
//
//   node .claude/skills/publish/publish.test.mjs
//
// Three scenarios, three journals under one throwaway content dir:
//
//   b647fix    — two local entries share a date, one remote day shares it.
//                Before B647 the date-alone branch fired for the first entry
//                processed and overwrote the remote day with its content.
//                Now: neither guesses, both create.
//   b647legit  — one local entry, one remote day, same date, no title/slug
//                match. The date-alone guess is still the right call here —
//                this is the case B647 must not break — but its slug must
//                never be written back into the file, since a guess is
//                exactly the match a later run needs to be free to revisit.
//   b648fix    — a trip the instance does not have yet. `--dry-run` must
//                still print the whole plan (a 404 on GET …/days is an empty
//                list, not a refusal), and `--dry-run --offline` must not
//                make that request at all.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLISH = join(HERE, "publish.mjs");

const CONTENT = mkdtempSync(join(tmpdir(), "fernscout-publish-test-"));
const requests = [];

function write(user, trip, file, frontmatter, body = "Body.") {
  const dir = join(CONTENT, user, "trips", trip, "entries");
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  writeFileSync(join(dir, file), `---\n${fm}\n---\n\nBody.\n`);
}

// b647fix: two entries, one date, and a remote day that matches neither by
// title or slug — the shape that overwrote a day on 2026-09-06.
write("b647fix", "triptest", "2025-11-14-hotel.md", { title: "Hotel" });
write("b647fix", "triptest", "2025-11-14-bahnhof.md", { title: "Bahnhof" });

// b647legit: the guess this fix must still make.
write("b647legit", "solotrip", "2025-06-01-mittag.md", { title: "Mittag" });

// b648fix: a trip the fake instance has never heard of.
write("b648fix", "newtrip", "2026-01-01-ankunft.md", { title: "Ankunft" });

let created = 0;
const routes = {
  "GET /api/health": () => [200, { media: {} }],

  "GET /api/v1/b647fix/status": () => [200, { trips: [{ id: "triptest" }] }],
  "GET /api/v1/b647fix/trips": () => [200, { trips: [{ id: "triptest" }] }],
  "GET /api/v1/b647fix/trips/triptest": () => [200, {}],
  "GET /api/v1/b647fix/trips/triptest/days": () => [200, {
    days: [{ slug: "mit-dem-zug", date: "2025-11-14", title: "Zug" }],
  }],
  "GET /api/v1/b647fix/trips/triptest/days/mit-dem-zug": () => [200, { gallery: [] }],
  "POST /api/v1/b647fix/trips/triptest/days": () => {
    created += 1;
    return [200, { slug: `created-${created}` }];
  },
  "GET /api/v1/b647fix/trips/triptest/days/created-1": () => [200, { gallery: [] }],
  "GET /api/v1/b647fix/trips/triptest/days/created-2": () => [200, { gallery: [] }],
  "PATCH /api/v1/b647fix/trips/triptest/days/mit-dem-zug": () => [200, {}],

  "GET /api/v1/b647legit/status": () => [200, { trips: [{ id: "solotrip" }] }],
  "GET /api/v1/b647legit/trips": () => [200, { trips: [{ id: "solotrip" }] }],
  "GET /api/v1/b647legit/trips/solotrip": () => [200, {}],
  "GET /api/v1/b647legit/trips/solotrip/days": () => [200, {
    days: [{ slug: "irgendein-tag", date: "2025-06-01", title: "Anderer Titel" }],
  }],
  "GET /api/v1/b647legit/trips/solotrip/days/irgendein-tag": () => [200, { gallery: [] }],
  "PATCH /api/v1/b647legit/trips/solotrip/days/irgendein-tag": () => [200, {}],

  "GET /api/v1/b648fix/status": () => [200, { trips: [] }],
  "GET /api/v1/b648fix/trips": () => [200, { trips: [] }],
  "GET /api/v1/b648fix/trips/newtrip/days": () => [404, { error: "unknown_trip" }],
};

const server = createServer(async (req, res) => {
  // A POST's body has to be drained even when nothing here reads it — an
  // unread body left on a keep-alive socket blocks the *next* request on the
  // same connection forever, which looked like publish.mjs hanging and was
  // actually this fake server never finishing the one before it.
  for await (const _chunk of req) { /* discarded */ }
  const [method, url] = [req.method, req.url.split("?")[0]];
  requests.push(`${method} ${url}`);
  const handler = routes[`${method} ${url}`];
  const [status, body] = handler ? handler() : [404, { error: "not_found_in_test_server" }];
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, resolve));
const SITE = `http://127.0.0.1:${server.address().port}`;

const execFileP = promisify(execFile);

// The fake instance below lives in *this* process, so the call to run
// publish.mjs has to be asynchronous — `execFileSync` blocks this process's
// whole event loop until the child exits, and the child cannot exit until
// this event loop is free to answer its requests. That deadlock is not
// theoretical: it is exactly what a first draft of this file did.
async function run(user, trip, ...flags) {
  requests.length = 0;
  let stdout, status = 0;
  try {
    ({ stdout } = await execFileP(process.execPath, [PUBLISH, "--user", user, "--trip", trip, "--skip-validate", ...flags], {
      encoding: "utf8",
      env: { ...process.env, FERNSCOUT_URL: SITE, FERNSCOUT_TOKEN: "test", FERNSCOUT_CONTENT_DIR: CONTENT },
    }));
  } catch (failedRun) {
    stdout = failedRun.stdout ?? "";
    status = failedRun.code ?? 1;
  }
  return { stdout, status, requests: [...requests] };
}

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// ── B647: two local entries, one date, one ambiguous remote day ────────────
{
  const result = await run("b647fix", "triptest", "--drafts");
  check("B647: two local entries on one date create two days, not a guess",
    result.status === 0 && !/matched .* by date alone/.test(result.stdout) &&
    (result.stdout.match(/write \d{4}-\d{2}-\d{2}-.*\.md/g) ?? []).length === 2,
    result.stdout);
  check("B647: the remote day sharing the date is never patched",
    !result.requests.includes("PATCH /api/v1/b647fix/trips/triptest/days/mit-dem-zug"));
  check("B647: both local entries are created rather than one overwriting the other",
    result.requests.filter((r) => r === "POST /api/v1/b647fix/trips/triptest/days").length === 2,
    result.requests.join(", "));
  const hotel = readFileSync(join(CONTENT, "b647fix/trips/triptest/entries/2025-11-14-hotel.md"), "utf8");
  const bahnhof = readFileSync(join(CONTENT, "b647fix/trips/triptest/entries/2025-11-14-bahnhof.md"), "utf8");
  check("B647: each file records the slug the instance actually created (not a guess)",
    /^slug: "created-\d"$/m.test(hotel) && /^slug: "created-\d"$/m.test(bahnhof));
}

// ── B647: the date-alone guess must still fire when it is genuinely the only
//    candidate, and must still not be recorded ──────────────────────────────
{
  const result = await run("b647legit", "solotrip", "--drafts");
  check("B647: an unambiguous date-alone match still guesses",
    /matched irgendein-tag loosely, by date alone/.test(result.stdout), result.stdout);
  check("B647: a guessed match is still applied (PATCH sent)",
    result.requests.includes("PATCH /api/v1/b647legit/trips/solotrip/days/irgendein-tag"));
  const file = readFileSync(join(CONTENT, "b647legit/trips/solotrip/entries/2025-06-01-mittag.md"), "utf8");
  check("B647: a guessed slug is never written back into the file",
    !/^slug:/m.test(file), file);
}

// ── B648: a trip the instance does not have yet ─────────────────────────────
{
  const result = await run("b648fix", "newtrip", "--dry-run");
  check("B648: --dry-run on a brand-new trip exits 0 and prints the plan",
    result.status === 0 && /would write 2026-01-01-ankunft\.md/.test(result.stdout), result.stdout);
  check("B648: a 404 on a new trip's day list is not printed as a refusal",
    !/✗/.test(result.stdout));
}
{
  const result = await run("b648fix", "newtrip", "--dry-run", "--offline");
  check("B648: --dry-run --offline exits 0 without asking for the new trip's days",
    result.status === 0 && !result.requests.includes("GET /api/v1/b648fix/trips/newtrip/days"),
    result.requests.join(", "));
}

server.close();
rmSync(CONTENT, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} publish.mjs check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
