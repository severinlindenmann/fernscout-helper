#!/usr/bin/env node
// A location-history export on this machine → a Fernscout journal, and one
// trip's real route on its map.
//
//   node upload.mjs --user <username> --file import/Timeline.json --dry-run
//   node upload.mjs --user <username> --file import/Timeline.json
//   node upload.mjs --user <username> --trip algarve-2026 --track
//
// **This script parses nothing.** Reading a Google Timeline, a Takeout, a GPX
// or plain JSON Lines is the instance's job — `importers/` in the fernscout
// repository, MIT-licensed, one file per format, running on the server where
// everybody gets the same version of it. What is here is the half a server
// cannot do: find the file on somebody's own disk, and hand it over.
//
// That division is the whole design of this repository. If a thing can happen
// on the instance, it happens there and this repo calls it.
import { existsSync, statSync, createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { ROOT, arg, has, die } from "../shared/lib.mjs";
import { SITE, call, refusal, token } from "../shared/api.mjs";

const user = arg("user") ?? die("--user <username> is required.");
const file = arg("file");
const trip = arg("trip");
const format = arg("format");
const dryRun = has("dry-run");
const wantsTrack = has("track");

if (!file && !wantsTrack) die("--file <export> is required, or --track with --trip.");
if (wantsTrack && !trip) die("--track needs --trip <id>: which trip's line to draw.");
token(); // fail now, with the how-to, rather than after the upload

const bytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Stage the export in the journal's inbox, where it belongs to no day. */
async function stage(path) {
  const name = basename(path);
  const form = new FormData();
  // Streamed rather than read whole: a Takeout can be hundreds of megabytes,
  // and this machine is somebody's laptop.
  form.append("files", await fileFrom(path, name));
  form.append("meta", JSON.stringify({ description: "" }));
  const result = await call("POST", `/api/v1/${user}/inbox`, { body: form });
  if (!result.ok) die(`  inbox refused it:\n${refusal(result)}`);
  const item = result.body.items?.[0];
  if (!item) die(`  the inbox accepted nothing back: ${JSON.stringify(result.body).slice(0, 200)}`);
  return item;
}

async function fileFrom(path, name) {
  const chunks = [];
  for await (const chunk of createReadStream(path)) chunks.push(chunk);
  return new File([Buffer.concat(chunks)], name, { type: "application/octet-stream" });
}

async function main() {
  console.log(`${SITE} · ${user}`);

  if (file) {
    const path = resolve(ROOT, file);
    if (!existsSync(path)) die(`No such file: ${path}`);
    console.log(`\n${basename(path)} — ${bytes(statSync(path).size)}`);

    // Staged first, then read from there: the same id can be imported again
    // without a second upload, and a dry run that refused would otherwise have
    // sent the bytes for nothing anyway.
    const staged = await stage(path);
    console.log(`  staged as ${staged.id}${staged.duplicate ? " (already there)" : ""}`);

    const body = { kind: "gps", inbox: staged.id, dryRun };
    if (format) body.format = format;
    const result = await call("POST", `/api/v1/${user}/import`, { body });
    if (!result.ok) {
      console.error(`  refused:\n${refusal(result)}`);
      for (const problem of result.body?.problems ?? []) console.error(`      ${problem}`);
      process.exit(1);
    }

    const r = result.body;
    console.log(
      `  ${r.format}${r.detected ? " (recognised)" : " (as told)"} — ${r.read} positions, ` +
        `${(r.from ?? "").slice(0, 10)} → ${(r.to ?? "").slice(0, 10)}`,
    );
    if (dryRun) {
      console.log("  --dry-run: nothing kept. The staged file is still in the inbox.");
    } else {
      console.log(
        `  the journal now holds ${r.stored.after} positions for those months ` +
          `(was ${r.stored.before})`,
      );
      console.log(
        `\n  The staged export is still in the inbox, and it is the unthinned whole of it.\n` +
          `  Offer to remove it:  DELETE ${SITE}/api/v1/${user}/inbox/${staged.id}`,
      );
    }
  }

  if (wantsTrack) {
    const result = await call("POST", `/api/v1/${user}/trips/${trip}/track`);
    if (!result.ok) die(`\n${trip}: refused\n${refusal(result)}`);
    const t = result.body;
    console.log(
      `\n${trip}: ${t.written ? `${t.segments} segments, ${t.points} points` : "nothing written"}`,
    );
    console.log(`  ${t.message}`);
    if (t.next) console.log(`  ${t.next}`);
  } else if (file && !dryRun) {
    console.log(
      `\n  Nothing is drawn yet. Ask which trip should show its route, then:\n` +
        `    node upload.mjs --user ${user} --trip <trip-id> --track`,
    );
  }
}

await main();
