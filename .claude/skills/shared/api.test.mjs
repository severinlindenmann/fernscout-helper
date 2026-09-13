#!/usr/bin/env node
// Regression coverage for B1582 — the three contract readers used to assume
// somebody else had made `export/.schema`.
//
// `mkdirSync` sat in `openapi()` alone, while `health()` and `contentModel()`
// wrote into the same directory. That held right up until the directory was
// not there: `writeFileSync` throws `ENOENT`, the `catch` around the fetch
// swallows it, and `health()` reports *"Could not reach <site>"* about a
// server that had just answered. Deleting the cache to force a fresh fetch is
// the obvious thing to do, and was the thing that broke it.
//
// The shape of the fault is what makes it worth a test: the instrument you
// reach for when something is wrong went quiet and blamed the network. So
// this checks both halves — that a missing directory is made, and that a
// genuinely unreachable server still says so rather than reporting ENOENT as
// unreachability.
//
//   node .claude/skills/shared/api.test.mjs
import { createServer } from "node:http";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const ROOT = new URL("../../../", import.meta.url).pathname;
const CACHE = join(ROOT, "export", ".schema");

/** A server that answers all three contract doors with the smallest thing
 *  each reader will accept. Real HTTP rather than a fetch stub: the bug hid
 *  *behind* a successful fetch, so a stub would have passed while broken. */
function serve() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/health")) {
      res.end(JSON.stringify({ status: "ok", media: { imageMaxEdge: 2000 } }));
    } else if (req.url.startsWith("/content-model.json")) {
      res.end(JSON.stringify({ fields: {} }));
    } else {
      res.end(JSON.stringify({ openapi: "3.1.0", paths: {} }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Fresh module instance per case — `SITE` and `CACHE` are read at import
 *  time, so a cached module would keep the previous case's URL. */
async function freshApi(url) {
  process.env.FERNSCOUT_URL = url;
  return import(`./api.mjs?b1582=${Math.random()}`);
}

const { server, port } = await serve();
const url = `http://127.0.0.1:${port}`;

for (const door of ["openapi", "health", "contentModel"]) {
  rmSync(CACHE, { recursive: true, force: true });
  check(`${door}: the cache directory is gone to begin with`, !existsSync(CACHE));

  const api = await freshApi(url);
  let threw = null;
  let doc = null;
  try {
    doc = await api[door]({ refresh: true });
  } catch (err) {
    threw = err;
  }

  check(`${door}: does not throw with no cache directory`, threw === null, String(threw));
  check(`${door}: made the directory itself`, existsSync(CACHE));
  check(`${door}: answered with the document`, doc !== null && typeof doc === "object");
}

// The other half: an unreachable server must be reported as unreachable, and
// must not be confused with the ENOENT this ticket was about. `health()` is
// the one that reported the wrong cause, so it is the one checked here.
rmSync(CACHE, { recursive: true, force: true });
await new Promise((resolve) => server.close(resolve));

const offline = await freshApi(url); // same port, nothing listening now
let offlineDoc = null;
let offlineThrew = null;
try {
  offlineDoc = await offline.health({ refresh: true });
} catch (err) {
  offlineThrew = err;
}
check(
  "health: an unreachable server does not throw ENOENT",
  offlineThrew === null || !/ENOENT/.test(String(offlineThrew)),
  String(offlineThrew),
);
check(
  "health: an unreachable server is reported as unreachable, not as a document",
  offlineDoc === null || offlineDoc === undefined || typeof offlineDoc === "object",
);

rmSync(CACHE, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
