#!/usr/bin/env node
// Refresh the committed file-shape snapshot.
//
//   node .claude/skills/shared/snapshot.mjs
//   FERNSCOUT_URL=https://fernscout.ch node .claude/skills/shared/snapshot.mjs
//
// `content-model.snapshot.json` is the fallback `contentModel.mjs` reads when
// `<site>/content-model.json` cannot be reached at all — see that file's
// header, and `docs/tasks/in-development/B610-model-mjs-is-still-the-
// helper.md` in the fernscout repo for why a committed copy is acceptable
// here when it was not acceptable as `model.mjs`. Short version: this one is
// never hand-edited, always says where it came from and when, and
// `selftest.mjs` fails the moment it disagrees with the live document. Run
// this script to bring it back into agreement; do not edit the JSON by hand.
import { writeFileSync } from "node:fs";
import { SITE } from "./api.mjs";
import { SNAPSHOT_PATH } from "./contentModel.mjs";

let response;
try {
  response = await fetch(`${SITE}/content-model.json`, { headers: { accept: "application/json" } });
} catch (error) {
  console.error(`Could not reach ${SITE}/content-model.json: ${error.message} — nothing written`);
  process.exit(1);
}
if (!response.ok) {
  console.error(`${SITE}/content-model.json answered ${response.status} ${response.statusText} — nothing written`);
  process.exit(1);
}

let document;
try { document = await response.json(); }
catch {
  console.error(`${SITE}/content-model.json did not answer with JSON — nothing written`);
  process.exit(1);
}

if (!Number.isInteger(document.contentModel)) {
  console.error(`${SITE}/content-model.json has no recognisable "contentModel" version — refusing to snapshot it`);
  process.exit(1);
}

const snapshot = {
  snapshotOf: SITE,
  snapshotTakenAt: new Date().toISOString(),
  document,
};

writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(
  `Wrote ${SNAPSHOT_PATH} — ${document.rules?.length ?? 0} rules, ${document.named?.length ?? 0} named checks, ` +
  `from ${SITE}, taken ${snapshot.snapshotTakenAt}.`,
);
