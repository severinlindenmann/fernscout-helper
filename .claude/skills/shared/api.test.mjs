#!/usr/bin/env node
// What the two contract readers must do, and the two faults they have
// actually had.
//
// **B1582** — `mkdirSync` sat in `openapi()` alone, while the other readers
// wrote into the same directory. That held right up until the directory was
// not there: `writeFileSync` throws `ENOENT`, the `catch` around the fetch
// swallows it, and the reader reports *"Could not reach <site>"* about a
// server that had just answered. Deleting the cache to force a fresh fetch is
// the obvious thing to do, and was the thing that broke it. The shape of the
// fault is what makes it worth a test: the instrument you reach for when
// something is wrong went quiet and blamed the network.
//
// **B1715** — the reader fetched `/openapi.json` and accepted whatever came
// back. That document still answers, and is deliberately scoped to the
// surviving v1 and auth doors, so discovery succeeded, cached a v1 contract,
// and described none of the calls this repository makes. So the fourth case
// below is the important one: a v1 document offered to a v2 reader is a
// refusal, not a cache entry.
//
//   node .claude/skills/shared/api.test.mjs
import { createServer } from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const ROOT = new URL("../../../", import.meta.url).pathname;
const CACHE = join(ROOT, "export", ".schema");

/** A server that answers both contract doors with the smallest thing each
 *  reader will accept. Real HTTP rather than a fetch stub: B1582 hid *behind*
 *  a successful fetch, so a stub would have passed while broken. */
function serve(openapiDoc) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/v2/status")) {
      res.end(JSON.stringify({ capabilities: { weather: true }, limits: { itemsPerDay: 40 }, media: {} }));
    } else {
      res.end(JSON.stringify(openapiDoc));
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
  return import(`./api.mjs?case=${Math.random()}`);
}

const V2_DOC = {
  openapi: "3.1.0",
  info: { version: 2 },
  paths: {
    "/api/v2/{user}/trips/{trip}/days/{slug}": {
      put: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                "x-required-or-declined": [{ field: "media", whyRequired: "…", toDecline: "declined.media" }],
              },
            },
          },
        },
      },
    },
  },
};

const { server, port } = await serve(V2_DOC);
const url = `http://127.0.0.1:${port}`;

for (const door of ["openapi", "status"]) {
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

// The contract is read, never copied: the declinables and the limits both
// come out of what the server just said.
{
  const api = await freshApi(url);
  const { doc } = await api.openapi({ refresh: true });
  const fields = api.declinables(doc, "/api/v2/{user}/trips/{trip}/days/{slug}", "put").map((d) => d.field);
  check("declinables are read off the request body schema", fields.join() === "media", fields.join() || "none");

  const { limits } = await api.limits({ refresh: true });
  check("limits come from the instance", limits.itemsPerDay === 40, JSON.stringify(limits));
}

// B1715's own case: v1 answering where v2 was asked for.
{
  rmSync(CACHE, { recursive: true, force: true });
  const { server: v1Server, port: v1Port } = await serve({ openapi: "3.1.0", info: { version: 1 }, paths: {} });
  const api = await freshApi(`http://127.0.0.1:${v1Port}`);
  let threw = null;
  try { await api.openapi({ refresh: true }); } catch (err) { threw = err; }
  check("a v1 document is refused, not cached as the contract", threw !== null, "it was accepted");
  await new Promise((resolve) => v1Server.close(resolve));
}

// The other half of B1582: an unreachable server must be reported as
// unreachable, and must not be confused with an ENOENT.
rmSync(CACHE, { recursive: true, force: true });
await new Promise((resolve) => server.close(resolve));

const offline = await freshApi(url); // same port, nothing listening now
let offlineThrew = null;
try {
  await offline.status({ refresh: true });
} catch (err) {
  offlineThrew = err;
}
check(
  "an unreachable server does not throw ENOENT",
  offlineThrew === null || !/ENOENT/.test(String(offlineThrew)),
  String(offlineThrew),
);
check(
  "an unreachable server with no cache says so",
  offlineThrew !== null && /Could not reach/.test(String(offlineThrew)),
  String(offlineThrew),
);

rmSync(CACHE, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
