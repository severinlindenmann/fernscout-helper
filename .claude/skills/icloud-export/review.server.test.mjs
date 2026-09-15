#!/usr/bin/env node
// B1778 and B1779 — the review page serves every exported trip from one
// server, and a frame somebody marked as showing something private is
// reachable rather than hunted for by date.
//
// The other review test (review.test.mjs) deliberately never starts the
// server, because it is about the derivative. This one is about the routes, so
// it does start it — with --no-open, since a test must not take over a
// browser.
//
//   node .claude/skills/icloud-export/review.server.test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, "review.mjs");
const FIXTURE = join(ROOT, ".claude/skills/shared/fixtures/orientation/orientation-1.jpg");
const PORT = 41787;

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const TRIPS = ["b1778-one", "b1778-two"];
for (const [i, trip] of TRIPS.entries()) {
  const DIR = join(ROOT, "export", trip);
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "photos"), { recursive: true });
  copyFileSync(FIXTURE, join(DIR, "photos", "one.jpg"));
  writeFileSync(join(DIR, "photos.json"), JSON.stringify({ trip, photos: [
    { name: "one.jpg", day: "2025-06-0" + (i + 1), time: "09:00", taken: `2025-06-0${i + 1}T09:00:00`, place: "Basel", fav: false },
  ] }, null, 2));
}
// The second trip has been reviewed, and something private was noticed in it
// by whoever read the contact sheets.
writeFileSync(join(ROOT, "export", TRIPS[1], "review.json"), JSON.stringify({
  photos: { "one.jpg": { drop: false, note: "", visibility: "" } },
  days: { "2025-06-02": "A day." },
  observed: { "2025-06-02": "one photograph of a street" },
  flags: { "one.jpg": "an identity card, front and back" },
}, null, 2));

const server = spawn(process.execPath, [REVIEW, "--port", String(PORT), "--no-open"], { stdio: "pipe" });
let log = "";
server.stdout.on("data", (c) => { log += c });
server.stderr.on("data", (c) => { log += c });

const at = `http://127.0.0.1:${PORT}`;
const get = async (path) => {
  const r = await fetch(at + path);
  return { status: r.status, text: r.headers.get("content-type")?.includes("json") ? null : await r.text(),
           json: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
};

// wait for it to listen
for (let tries = 0; tries < 100; tries++) {
  try { await get("/"); break } catch { await new Promise((r) => setTimeout(r, 100)) }
}

try {
  // ── the index ───────────────────────────────────────────────────────────
  {
    const { status, text } = await get("/");
    check("B1778: the index answers at /", status === 200, String(status));
    check("B1778: and lists every exported trip",
      TRIPS.every((t) => text.includes(`/t/${t}/`)), text?.slice(0, 400));
    check("B1778: it says which one has been reviewed and which has not",
      /reviewed/.test(text) && /not yet/.test(text), text?.slice(0, 400));
    check("B1779: and how many frames were marked private", /1 marked private/.test(text), text?.slice(0, 600));
  }

  // ── one trip, served under its own path ─────────────────────────────────
  {
    const { status, text } = await get(`/t/${TRIPS[0]}/`);
    check("B1778: a trip's own page answers", status === 200 && text.includes(TRIPS[0]), String(status));
    check("B1778: the page fetches its data relative to itself, so both trips cannot collide",
      text.includes('fetch("data")'), "");
    const data = await get(`/t/${TRIPS[0]}/data`);
    check("B1778: its data is that trip's photographs", data.json?.photos?.length === 1, JSON.stringify(data.json));
    const other = await get(`/t/${TRIPS[1]}/data`);
    check("B1778: and the other trip's data is its own",
      other.json?.review?.flags?.["one.jpg"] === "an identity card, front and back", JSON.stringify(other.json?.review));
    const img = await fetch(`${at}/t/${TRIPS[0]}/img/one.jpg`);
    check("B1778: the thumbnail is served under the trip", img.status === 200, String(img.status));
    const full = await fetch(`${at}/t/${TRIPS[0]}/full/one.jpg`);
    check("B1778: and so is the full-size derivative", full.status === 200, String(full.status));
    const nope = await fetch(`${at}/t/does-not-exist/`);
    check("B1778: an unknown trip is a 404, not a crash", nope.status === 404, String(nope.status));
  }

  // ── a save keeps what the page did not write ─────────────────────────────
  {
    const saved = await fetch(`${at}/t/${TRIPS[1]}/save`, {
      method: "POST",
      body: JSON.stringify({ photos: { "one.jpg": { drop: true, note: "", visibility: "" } }, days: {} }),
    });
    const after = JSON.parse(readFileSync(join(ROOT, "export", TRIPS[1], "review.json"), "utf8"));
    check("B1779: saving the page's own choices does not delete the flags or the observations",
      saved.status === 204 && after.flags?.["one.jpg"] && after.observed?.["2025-06-02"], JSON.stringify(after));
    check("B1779: and the choice itself was written", after.photos["one.jpg"].drop === true, JSON.stringify(after.photos));
  }
} finally {
  server.kill();
  for (const trip of TRIPS) rmSync(join(ROOT, "export", trip), { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.\n${log}`);
  process.exit(1);
}
