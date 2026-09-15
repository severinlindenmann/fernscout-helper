#!/usr/bin/env node
// What publishing against v2 must do — a fake instance in-process, plain
// node:http, no dependencies.
//
//   node .claude/skills/publish/publish.test.mjs
//
// The old file tested v1's own mechanics: which of eleven per-field doors
// wrote which key, and how a local entry was matched to a remote day by date
// or title when the two disagreed. None of that exists any more — a day has a
// client-chosen slug that IS its address, so there is nothing to guess and
// nothing to guess wrong. What is worth pinning now is the handful of things
// that can still go quietly wrong:
//
//   create vs correct   a document that is there is PATCHed with If-Match, not
//                       PUT over. PUT is create-only in v2, and a create that
//                       finds something there answers 409 — so getting this
//                       backwards means every second run fails, or worse,
//                       succeeds by replacing what the server knew.
//   media by hash       a photograph already stored is not sent again. B1529
//                       was the opposite: matched by basename, so a larger
//                       re-export under the same name was silently skipped.
//   incomplete          a 422 is reported with the server's own list of open
//                       sections, and the run exits non-zero. It must never be
//                       answered with an invented decline.
//   publishing          is a separate call, does not happen with --drafts, and
//                       does not happen twice.
//   dry run             asks, prints, writes nothing.
import { createServer } from "node:http";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const HERE = dirname(new URL(import.meta.url).pathname);
const PUBLISH = join(HERE, "publish.mjs");

// ── a journal on disk, in the shape the instance stores ───────────────────
const content = mkdtempSync(join(tmpdir(), "fernscout-publish-test-"));
const USER = "ana";
const TRIP = "alps";
const DAY = "2026-08-26-hoi-an";
const FIGURE = "walker-1";
const PHOTO = Buffer.from("not really a jpeg, but bytes are bytes");
const HASH = createHash("sha256").update(PHOTO).digest("hex").slice(0, 32);
const SRC = `/media/${TRIP}/${DAY}/${HASH}.jpg`;

function write(path, value) {
  const full = join(content, USER, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
}

write("config.json", {
  title: "Ana",
  tagline: "Unterwegs",
  owner: { name: "Ana B", nickname: "Ana", email: "ana@example.test",
           // On disk and never writable — the proven telephone number and its
           // proof. Publishing must drop these rather than send them: the
           // API's owner sub-schema is {name, nickname, email} with
           // additionalProperties: false, and proving a number is a round trip
           // a file cannot perform.
           tel: "41760000000", telProvenAt: "2026-09-14T08:00:00.000Z", telProvenMethod: "whatsapp-inbound" },
});
write(`trips/${TRIP}/trip.json`, {
  id: TRIP,
  title: "Alps",
  dates: { from: "2026-08-20", to: "2026-09-10" },
  visibility: "private",
  declined: { costs: "no budget tracked on this trip" },
});
write(`trips/${TRIP}/entries/${DAY}.json`, {
  title: "Hoi An",
  date: "2026-08-26",
  content: "Erster Tag.",
  status: "draft",
  media: [{ src: SRC, caption: "Lanterns" }],
  declined: { costs: "nothing was spent on this day" },
});
write(`trips/${TRIP}/media/${DAY}/${HASH}.jpg`, PHOTO);

// ── the fake instance ─────────────────────────────────────────────────────
const seen = [];
let journalDoc = { username: USER, title: "Ana", owner: { name: "Ana B", nickname: "Ana", email: "ana@example.test" } };
let dayDoc = null;
let tripDoc = null;
let figureDoc = null;
let manifest = [];
let incomplete = false;

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (req, res) => {
  const [path] = req.url.split("?");
  seen.push(`${req.method} ${path}`);
  const json = (status, value, etag) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    if (etag) res.setHeader("etag", etag);
    res.end(JSON.stringify(value));
  };

  if (path === "/api/v2/status") {
    return json(200, {
      capabilities: {}, limits: { itemsPerDay: 40, imageMaxBytes: 1000000 }, media: {},
      // B1783: the one source name a caller may never write, published where
      // a caller reads before it writes.
      weather: { reservedSources: ["open-meteo"] },
    });
  }
  if (path === "/api/v2/openapi.json") {
    return json(200, {
      openapi: "3.1.0",
      info: { version: 2 },
      paths: {
        "/api/v2/{user}": {
          patch: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: {}, tagline: {}, visibility: {}, locales: {}, units: {},
                      baseCurrency: {}, displayCurrencies: {}, figures: {}, owner: {}, declined: {},
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
  if (path === `/api/v2/${USER}`) {
    if (req.method === "PATCH") {
      journalDoc = { ...journalDoc, ...JSON.parse(String(await body(req))) };
      return json(200, journalDoc, '"journal-1"');
    }
    return json(200, journalDoc, '"journal-1"');
  }

  // The figure library: GET, PUT and DELETE, and no PATCH — the instance's own
  // shape (app/api/v2/[user]/figures/[id]/route.ts). A PATCH here answers 405,
  // which is what B1774 was.
  if (path === `/api/v2/${USER}/figures/${FIGURE}`) {
    if (req.method === "GET") return figureDoc ? json(200, figureDoc, '"figure-1"') : json(404, { error: "no_such_figure" });
    if (req.method !== "PUT") return json(405, { error: "method_not_allowed" });
    if (figureDoc && !req.headers["if-match"]) {
      return json(409, { error: "stale_document", message: "Read it back, then PUT again with If-Match." });
    }
    figureDoc = JSON.parse(String(await body(req)));
    return json(figureDoc ? 200 : 201, figureDoc, '"figure-1"');
  }

  if (path === `/api/v2/${USER}/sync/manifest`) {
    return json(200, { files: manifest.map((p) => ({ path: p, size: 1, hash: `remote-${p}` })) });
  }

  const tripPath = `/api/v2/${USER}/trips/${TRIP}`;
  if (path === tripPath) {
    if (req.method === "GET") return tripDoc ? json(200, tripDoc, '"trip-1"') : json(404, { error: "unknown_trip" });
    tripDoc = { ...JSON.parse(String(await body(req))) };
    return json(req.method === "PUT" ? 201 : 200, tripDoc, '"trip-1"');
  }

  const dayPath = `${tripPath}/days/${DAY}`;
  if (path === dayPath) {
    if (req.method === "GET") return dayDoc ? json(200, dayDoc, '"day-1"') : json(404, { error: "unknown_day" });
    if (incomplete) {
      return json(422, {
        error: "incomplete",
        message: "Some sections are neither answered nor declined.",
        details: {
          missing: [{
            field: "weather",
            why: "a day asks for the lookup, brings a reading, or declines",
            decline: "declined.weather",
          }],
        },
      });
    }
    dayDoc = { ...JSON.parse(String(await body(req))), status: dayDoc?.status ?? "draft", media: dayDoc?.media ?? [] };
    return json(req.method === "PUT" ? 201 : 200, dayDoc, '"day-1"');
  }

  if (path === `/api/v2/${USER}/media` && req.method === "POST") {
    await body(req);
    dayDoc = { ...(dayDoc ?? {}), media: [...(dayDoc?.media ?? []), { src: SRC }] };
    return json(201, { src: SRC });
  }

  if (path === `${dayPath}/publish`) {
    await body(req);
    dayDoc = { ...(dayDoc ?? {}), status: "published" };
    return json(200, { ok: true });
  }

  return json(404, { error: "not_found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;

const execFileP = promisify(execFile);

/** publish.mjs has to run asynchronously: the fake instance above is on THIS
 * process's event loop, so a synchronous child would block the very server it
 * is calling and the run would hang rather than fail. */
async function run(args = []) {
  const env = {
    ...process.env,
    FERNSCOUT_URL: site,
    FERNSCOUT_TOKEN: "test-token",
    FERNSCOUT_CONTENT_DIR: content,
  };
  try {
    const { stdout } = await execFileP(process.execPath, [PUBLISH, "--user", USER, ...args], { env, encoding: "utf8" });
    return { out: stdout, code: 0 };
  } catch (error) {
    return { out: `${error.stdout ?? ""}${error.stderr ?? ""}`, code: error.code ?? 1 };
  }
}

// ── the dry run asks, prints, and writes nothing ──────────────────────────
{
  const { out } = await run(["--dry-run"]);
  check("a dry run says what it would create", /would create.*trip alps/s.test(out), out);
  check("a dry run names the day it would write", out.includes(`day ${DAY}`), out);
  check("a dry run would publish, and says so", /would publish/.test(out), out);
  check("a dry run wrote nothing", tripDoc === null && dayDoc === null, JSON.stringify({ tripDoc, dayDoc }));
  check("a dry run still asked the instance what it holds", seen.some((s) => s.startsWith("GET ")), seen.join(", "));
}

// ── the real run creates, uploads once, and publishes ─────────────────────
{
  seen.length = 0;
  const { out, code } = await run();
  check("the run succeeds", code === 0, out);
  check("the trip is created with PUT", seen.includes(`PUT /api/v2/${USER}/trips/${TRIP}`), seen.join(", "));
  check("the day is created with PUT", seen.includes(`PUT /api/v2/${USER}/trips/${TRIP}/days/${DAY}`), seen.join(", "));
  check("the photograph is uploaded", seen.includes(`POST /api/v2/${USER}/media`), seen.join(", "));
  check("publishing is its own call", seen.includes(`POST /api/v2/${USER}/trips/${TRIP}/days/${DAY}/publish`), seen.join(", "));
  check("the day is on the site afterwards", dayDoc?.status === "published", JSON.stringify(dayDoc));
}

// ── the journal document itself is sent, and the tel is not ──────────────
//
// It had no door at all: config.json is in the sync manifest, so a sync
// planned a push for it, said "↑ config.json — changed locally", ran publish —
// which had no mention of `config` anywhere — and then recorded that both
// sides agreed. An owner renaming their journal lost the rename silently and
// permanently, since a later pull saw nothing to bring back either.
{
  check("the journal was corrected", journalDoc.tagline === "Unterwegs", JSON.stringify(journalDoc));
  check("the writable fields came from the contract", seen.includes(`PATCH /api/v2/${USER}`), seen.join(", "));
  check(
    "the proven telephone number was NOT sent — it lives on disk and has no door",
    journalDoc.owner?.tel === undefined && journalDoc.owner?.telProvenAt === undefined,
    JSON.stringify(journalDoc.owner),
  );
  check("what the API does take of the owner block did go", journalDoc.owner?.email === "ana@example.test", JSON.stringify(journalDoc.owner));
}

// ── running it again corrects rather than creates, and re-sends nothing ───
{
  seen.length = 0;
  const { out, code } = await run();
  check("a second run succeeds", code === 0, out);
  check(
    "the trip is corrected, not re-created",
    seen.includes(`PATCH /api/v2/${USER}/trips/${TRIP}`) && !seen.includes(`PUT /api/v2/${USER}/trips/${TRIP}`),
    seen.join(", "),
  );
  check("the day is corrected, not re-created", seen.includes(`PATCH /api/v2/${USER}/trips/${TRIP}/days/${DAY}`), seen.join(", "));
  check("the photograph the instance already holds is not sent again", !seen.includes(`POST /api/v2/${USER}/media`), seen.join(", "));
  check("the journal, already in step, is not patched again", !seen.includes(`PATCH /api/v2/${USER}`), seen.join(", "));
  check("a day already on the site is not published twice", !seen.some((s) => s.endsWith("/publish")), seen.join(", "));
}

// ── --drafts writes and stops ─────────────────────────────────────────────
{
  dayDoc = null;
  seen.length = 0;
  await run(["--drafts"]);
  check("--drafts writes the day", seen.some((s) => s.includes(`/days/${DAY}`)), seen.join(", "));
  check("--drafts publishes nothing", !seen.some((s) => s.endsWith("/publish")), seen.join(", "));
}

// ── an incomplete document is reported, never answered ────────────────────
{
  dayDoc = null;
  incomplete = true;
  seen.length = 0;
  const { out, code } = await run(["--drafts"]);
  check("an incomplete day fails the run", code !== 0, String(code));
  check("the server's own reason is printed", /a day asks for the lookup/.test(out), out);
  check("the way to decline it is printed", /declined\.weather/.test(out), out);
  check(
    "nothing was invented to get past it",
    !/"weather"\s*:/.test(readFileSync(join(content, USER, `trips/${TRIP}/entries/${DAY}.json`), "utf8")),
  );
  incomplete = false;
}

// ── B1774: a figure is corrected through the door it has ─────────────────
{
  write(`figures/${FIGURE}.json`, { id: FIGURE, kind: "walker", name: "Ana", palette: "cream" });
  seen.length = 0;
  const { out, code } = await run(["--drafts"]);
  check("B1774: a figure that is not there is created", code === 0 && figureDoc?.name === "Ana", out);
  check("B1774: with PUT", seen.includes(`PUT /api/v2/${USER}/figures/${FIGURE}`), seen.join(", "));

  seen.length = 0;
  const again = await run(["--drafts"]);
  check("B1774: a second run does not write an unchanged figure at all",
    again.code === 0 && !seen.some((s) => s.startsWith(`PUT /api/v2/${USER}/figures/`)), seen.join(", "));
  check("B1774: and says so rather than claiming a correction", /unchanged {5}figure/.test(again.out), again.out);

  write(`figures/${FIGURE}.json`, { id: FIGURE, kind: "walker", name: "Ana B", palette: "cream" });
  seen.length = 0;
  const changedRun = await run(["--drafts"]);
  check("B1774: a figure that really changed is replaced, with PUT and never PATCH",
    changedRun.code === 0 && figureDoc?.name === "Ana B"
      && seen.includes(`PUT /api/v2/${USER}/figures/${FIGURE}`)
      && !seen.some((s) => s.startsWith(`PATCH /api/v2/${USER}/figures/`)),
    `${changedRun.out}\n${seen.join(", ")}`);
}

// ── B1782: a reading the server made goes back as the ask ────────────────
{
  const entryPath = `trips/${TRIP}/entries/${DAY}.json`;
  const onDisk = JSON.parse(readFileSync(join(content, USER, entryPath), "utf8"));
  write(entryPath, { ...onDisk, weather: {
    source: "open-meteo", recordedAt: "2026-08-27T02:00:00.000Z", tempC: 29,
  } });
  dayDoc = null;
  const { out, code } = await run(["--drafts"]);
  check("B1782: the day is accepted rather than refused by name", code === 0, out);
  check("B1782: what went up is `weather: true`, not the server's own reading",
    dayDoc?.weather === true, JSON.stringify(dayDoc?.weather));
  check("B1782: the run says how many readings it handed back", /handed back|sent back/.test(out), out);
  check("B1782: the file on disk keeps the reading",
    JSON.parse(readFileSync(join(content, USER, entryPath), "utf8")).weather?.source === "open-meteo");
  write(entryPath, onDisk);
}

// ── B1775: the sync baseline is written for what publish wrote ───────────
{
  const baseFile = join(content, USER, ".fernscout-sync.json");
  rmSync(baseFile, { force: true });
  manifest = [`trips/${TRIP}/entries/${DAY}.json`, `trips/${TRIP}/trip.json`, "config.json"];
  dayDoc = null; tripDoc = null;
  const { out, code } = await run(["--drafts"]);
  check("B1775: the run succeeds", code === 0, out);
  const base = JSON.parse(readFileSync(baseFile, "utf8"));
  check("B1775: the day it wrote is recorded as agreed — otherwise a sync down calls it a conflict",
    !!base.files?.[`trips/${TRIP}/entries/${DAY}.json`], JSON.stringify(base.files));
  check("B1775: with both sides remembered, since a typed route normalises what it is given",
    base.files?.[`trips/${TRIP}/entries/${DAY}.json`]?.remote === `remote-trips/${TRIP}/entries/${DAY}.json`,
    JSON.stringify(base.files));
  check("B1775: and it says so", /Sync state updated/.test(out), out);

  // Invoked by a sync, the baseline is the sync's to write.
  const changedList = join(content, "changed.json");
  writeFileSync(changedList, JSON.stringify([`trips/${TRIP}/entries/${DAY}.json`]));
  rmSync(baseFile, { force: true });
  const viaSync = await run(["--drafts", "--changed", changedList]);
  check("B1775: publish run by a sync leaves the baseline to the sync",
    !existsSync(baseFile), viaSync.out);
}

await new Promise((resolve) => server.close(resolve));
rmSync(content, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
