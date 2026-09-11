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
//   b1400fix   — a journal asking for two features, where the server's PATCH
//                comes back 200 having actually changed only one of them.
//                Before B1400 the client printed "set features — a=true,
//                b=true" from the request alone, never looking at the
//                response, so a feature the server silently left alone still
//                read as applied.
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

// b1525cover: an existing trip whose title has changed since it was
// created, and whose trip.md names a cover in *local* terms — the folder
// the export wrote, not the slug the instance assigned the day.
write("b1525cover", "voyage", "2025-08-01-day-one.md", {
  title: "Day One",
  date: "2025-08-01",
  gallery: [{ src: "/media/voyage/local-folder/02.jpg", type: "image", width: 10, height: 10 }],
});
mkdirSync(join(CONTENT, "b1525cover", "trips", "voyage"), { recursive: true });
writeFileSync(join(CONTENT, "b1525cover", "trips", "voyage", "trip.md"),
  '---\nid: "voyage"\ntitle: "Voyage Diaries"\ntagline: "Same"\n' +
  'cover: "/media/voyage/local-folder/02.jpg"\n---\n\nIntro.\n');

// b1529replace: a day whose photo already exists remotely under the same
// basename, but bigger locally now — the shape that used to need a
// hand-driven DELETE plus a hand-driven re-upload, 177 times over.
write("b1529replace", "biggerphotos", "2025-09-01-bigger.md", {
  title: "Bigger",
  date: "2025-09-01",
  gallery: [{ src: "/media/biggerphotos/bigger/01.jpg", type: "image", width: 40, height: 30 }],
});
mkdirSync(join(CONTENT, "b1529replace", "trips", "biggerphotos", "media", "bigger"), { recursive: true });
writeFileSync(join(CONTENT, "b1529replace", "trips", "biggerphotos", "media", "bigger", "01.jpg"), "bigger-bytes");

// b1400fix: no trips at all — this scenario only exercises the config PATCH,
// which happens before the per-trip loop.
mkdirSync(join(CONTENT, "b1400fix"), { recursive: true });
writeFileSync(join(CONTENT, "b1400fix", "config.json"), JSON.stringify({
  features: { weather: { enabled: true }, costs: { enabled: true } },
}));

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

  "GET /api/v1/b1400fix/status": () => [200, { trips: [] }],
  // The server actually wrote only "weather" — "costs" was asked for too but
  // left as it was (say, already off at the instance's own ceiling).
  "PATCH /api/v1/b1400fix/config": () => [200, {
    ok: true, features: { weather: true }, changed: ["weather"],
    note: "Changed: weather. This is what the journal asks for; the server is still the ceiling above it, and /api/health says what it provides.",
  }],
  "GET /api/v1/b1400fix/trips": () => [200, { trips: [] }],

  "GET /api/v1/b1525cover/status": () => [200, { trips: [{ id: "voyage" }] }],
  "GET /api/v1/b1525cover/trips": () => [200, { trips: [{ id: "voyage" }] }],
  // The instance's own record: an old title, the tagline already matching
  // (so it must NOT show up in the PATCH body), and no cover yet.
  "GET /api/v1/b1525cover/trips/voyage": () => [200, { title: "Old Title", tagline: "Same", cover: null }],
  "PATCH /api/v1/b1525cover/trips/voyage": () => [200, {}],
  "GET /api/v1/b1525cover/trips/voyage/days": () => [200, {
    days: [{ slug: "der-erste-tag", date: "2025-08-01", title: "Day One" }],
  }],
  // Already carries the file (matched by basename) — nothing left to upload,
  // so this scenario never needs a real file on disk for the photograph.
  "GET /api/v1/b1525cover/trips/voyage/days/der-erste-tag": () => [200, {
    gallery: [{ src: "/b1525cover/media/voyage/der-erste-tag/02.jpg" }],
  }],
  "PATCH /api/v1/b1525cover/trips/voyage/days/der-erste-tag": () => [200, {}],

  "GET /api/v1/b1529replace/status": () => [200, { trips: [{ id: "biggerphotos" }] }],
  "GET /api/v1/b1529replace/trips": () => [200, { trips: [{ id: "biggerphotos" }] }],
  "GET /api/v1/b1529replace/trips/biggerphotos": () => [200, {}],
  "GET /api/v1/b1529replace/trips/biggerphotos/days": () => [200, {
    days: [{ slug: "bigger-slug", date: "2025-09-01", title: "Bigger" }],
  }],
  // The instance already has a smaller version of this file, under the same
  // basename — exactly what `publish` would otherwise skip as "already sent".
  "GET /api/v1/b1529replace/trips/biggerphotos/days/bigger-slug": () => [200, {
    gallery: [{ src: "/b1529replace/media/biggerphotos/bigger-slug/01.jpg" }],
  }],
  "PATCH /api/v1/b1529replace/trips/biggerphotos/days/bigger-slug": () => [200, {}],
  "DELETE /api/v1/b1529replace/trips/biggerphotos/media": () => [200, { removed: ["/b1529replace/media/biggerphotos/bigger-slug/01.jpg"] }],
  "POST /api/v1/b1529replace/trips/biggerphotos/media": () => [200, { added: 1 }],
};

// B1525 — the trip-level PATCH bodies, keyed by "METHOD URL", so a test can
// check *what* was sent and not merely that something was.
const patchBodies = {};

const server = createServer(async (req, res) => {
  // A POST's body has to be drained even when nothing here reads it — an
  // unread body left on a keep-alive socket blocks the *next* request on the
  // same connection forever, which looked like publish.mjs hanging and was
  // actually this fake server never finishing the one before it.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const [method, url] = [req.method, req.url.split("?")[0]];
  requests.push(`${method} ${url}`);
  if ((method === "PATCH" || method === "DELETE") && chunks.length) {
    const key = `${method} ${url}`;
    try {
      (patchBodies[key] ??= []).push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { /* multipart or empty */ }
  }
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

// ── B1400: a 200 with a partial `changed` must not read as "applied" ──────
{
  const result = await run("b1400fix", "no-such-trip");
  check("B1400: the server's own note is printed, not a re-derived request echo",
    /Changed: weather. This is what the journal asks for/.test(result.stdout), result.stdout);
  check("B1400: a requested key absent from `changed` is called out by name",
    /not applied: costs/.test(result.stdout), result.stdout);
  check("B1400: a key the server did change is not also listed as unapplied",
    !/not applied:.*weather/.test(result.stdout), result.stdout);
}

// ── B1525: an existing trip's title/cover PATCH — cover translated from the
//    local folder into the day's real slug, and unchanged fields left out ──
{
  const result = await run("b1525cover", "voyage", "--drafts");
  check("B1525: a changed title reaches PATCH .../trips/{trip}",
    result.requests.includes("PATCH /api/v1/b1525cover/trips/voyage"), result.requests.join(", "));
  const tripBodies = patchBodies["PATCH /api/v1/b1525cover/trips/voyage"] ?? [];
  const titleBody = tripBodies.find((b) => "title" in b);
  check("B1525: the title patch carries only what changed, not the tagline that already matched",
    titleBody?.title === "Voyage Diaries" && titleBody?.tagline === undefined,
    JSON.stringify(tripBodies));
  check("B1525: cover goes out in its own PATCH, once the day's real slug is known",
    tripBodies.some((b) => b.cover === "/b1525cover/media/voyage/der-erste-tag/02.jpg"),
    JSON.stringify(tripBodies));
  check("B1525: a local cover is resolved to the instance's own slug-based src, not sent verbatim",
    result.stdout.includes("/b1525cover/media/voyage/der-erste-tag/02.jpg") &&
    !result.stdout.includes("set cover — /media/voyage/local-folder/02.jpg → /media/voyage/local-folder/02.jpg"),
    result.stdout);
  check("B1525: the day's own gallery upload is skipped — the photo was already there by basename",
    !result.stdout.includes("send 1 file"), result.stdout);
}

// ── B1529: --replace-media deletes the remote copy by src, then re-sends ──
{
  const result = await run("b1529replace", "biggerphotos", "--drafts", "--replace-media");
  check("B1529: the already-there photo is deleted by its exact remote src, not the local one",
    result.requests.includes("DELETE /api/v1/b1529replace/trips/biggerphotos/media"), result.requests.join(", "));
  const deleteBody = (patchBodies["DELETE /api/v1/b1529replace/trips/biggerphotos/media"] ?? [])[0];
  check("B1529: the delete names the day and the instance's own src",
    deleteBody?.day === "bigger-slug" &&
    Array.isArray(deleteBody?.src) && deleteBody.src.includes("/b1529replace/media/biggerphotos/bigger-slug/01.jpg"),
    JSON.stringify(deleteBody));
  check("B1529: the larger local file is re-sent after the delete, not skipped as already uploaded",
    result.requests.includes("POST /api/v1/b1529replace/trips/biggerphotos/media"), result.requests.join(", "));
}
{
  // Without the flag, the same basename is left alone — no delete, no re-send.
  const result = await run("b1529replace", "biggerphotos", "--drafts");
  check("B1529: without --replace-media, an already-uploaded basename is left alone",
    !result.requests.includes("DELETE /api/v1/b1529replace/trips/biggerphotos/media") &&
    !result.requests.includes("POST /api/v1/b1529replace/trips/biggerphotos/media"),
    result.requests.join(", "));
}

server.close();
rmSync(CONTENT, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} publish.mjs check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
