#!/usr/bin/env node
// B1402 — a CONTENT dir pointed one level too shallow (or, the mirror case,
// one level too deep) used to be validated as though every subdirectory it
// found were a journal, producing a confusing "has no config.json" instead
// of naming what was actually wrong. `suggestedContentDir()` is the fix:
// find an actual journal-shaped directory nearby and say so.
//
//   node .claude/skills/shared/journal.test.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

function makeJournal(dir) {
  mkdirSync(join(dir, "trips"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
}

async function suggestionFor(contentDir) {
  process.env.FERNSCOUT_CONTENT_DIR = contentDir;
  // A fresh import per case: journal.mjs reads FERNSCOUT_CONTENT_DIR into a
  // module-level constant at import time, so each case needs its own copy —
  // a cache-busting query string is the plain way to get one without a
  // dependency.
  const mod = await import(`./journal.mjs?case=${encodeURIComponent(contentDir)}`);
  return mod.suggestedContentDir();
}

const root = mkdtempSync(join(tmpdir(), "fernscout-journal-test-"));

// Correct depth: content/ directly holds journal-shaped directories.
const correct = join(root, "correct", "content");
makeJournal(join(correct, "alice"));
makeJournal(join(correct, "bob"));

// Too shallow: pointed at the folder above content/.
const shallow = join(root, "shallow");
makeJournal(join(shallow, "content", "alice"));

// Too deep: pointed at one journal's own folder.
const deepJournal = join(root, "deep", "content", "alice");
makeJournal(deepJournal);

// Genuinely empty.
const empty = join(root, "empty");
mkdirSync(empty, { recursive: true });

// One at a time, not Promise.all: each call mutates the shared
// process.env.FERNSCOUT_CONTENT_DIR before its dynamic import evaluates
// journal.mjs's module-level CONTENT, so kicking off several concurrently
// races that write against import()'s microtask — the last write wins for
// every one of them, and three of the four cases below silently checked the
// same directory. This was that bug, not a hypothetical.
const atCorrectDepth = await suggestionFor(correct);
const atShallowDepth = await suggestionFor(shallow);
const atJournalItself = await suggestionFor(deepJournal);
const atEmptyDir = await suggestionFor(empty);

check("nothing is suggested when CONTENT already holds journal-shaped directories",
  atCorrectDepth === null, String(atCorrectDepth));
check("too shallow: the journal-holding directory one level in is named",
  atShallowDepth === join(shallow, "content"), String(atShallowDepth));
check("too deep: the parent of the journal itself is named",
  atJournalItself === join(root, "deep", "content"), String(atJournalItself));
check("a genuinely empty directory is left alone — nothing nearby to suggest",
  atEmptyDir === null, String(atEmptyDir));

rmSync(root, { recursive: true, force: true });
delete process.env.FERNSCOUT_CONTENT_DIR;

if (failed > 0) {
  console.log(`\n${failed} journal.mjs check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
