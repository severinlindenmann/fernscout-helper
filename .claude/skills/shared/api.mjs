// Talking to a Fernscout instance, and keeping a copy of what it published.
//
// The instance is the authority on what it will accept, and it says so at
// `<site>/api/v2/openapi.json` (the shapes) and `<site>/api/v2/status` (the
// capabilities, the limits and the prices). Both are fetched once and cached
// under `export/.schema/`, so a validation run works on a train and a publish
// run does not ask twice.
//
// **This is v2, and v1 is not a fallback.** The whole write surface these
// tools used — `POST /api/v1/journals`, `/api/v1/{user}/config`, `POST
// .../trips`, `POST .../days`, the per-field trip PATCHes — was deleted with
// the v2 migration and answers 404. `/openapi.json` still answers, and that is
// the trap this file used to walk into: it is deliberately scoped to the
// surviving v1 and auth doors, so discovery "worked" and described none of the
// calls this repository makes. The v2 document is the contract.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

export const SITE = process.env.FERNSCOUT_URL?.replace(/\/$/, "") || "https://fernscout.ch";
const CACHE = join(ROOT, "export", ".schema");

/**
 * Where one cached contract lives, with the directory made ready for it.
 *
 * **The `mkdirSync` is the point** — B1582. It used to sit in `openapi()`
 * alone, while the other fetchers wrote into the same directory and assumed
 * somebody else had made it. That held right up until the directory was not
 * there: `writeFileSync` throws `ENOENT`, the `catch` around the fetch
 * swallows it, and the tool reports *"Could not reach <site>"* about a server
 * that had just answered. Deleting the cache to force a fresh fetch is the
 * obvious thing to do and was the thing that broke it.
 */
function cacheFile(suffix = "") {
  mkdirSync(CACHE, { recursive: true });
  return join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}${suffix}.json`);
}
/** A day. The contract changes when the instance is deployed, not hourly. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * A cache file, parsed defensively. `null` covers both "not there" and "there
 * but not valid JSON" — a half-written file from a killed process, or one
 * hand-edited into garbage. Either way there is nothing to read out of it, so
 * the caller treats it exactly like an unrecognised shape: stale, and worth a
 * refetch rather than a thrown syntax error nobody asked for.
 */
function readCache(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

/**
 * One cached document, with the same rules for all of them.
 *
 * `recognise` is what makes a cached copy trustworthy — not its mtime. A
 * document of the wrong shape (an older cache format, a half-written file, a
 * v1 document where a v2 one was wanted) cannot be told from a current one by
 * looking at the file, so it is always treated as stale and refetched however
 * new it is. B579 is the ticket: a `media`-less cached `/api/health` read as
 * "this instance has no upload limits", and every check that depended on them
 * silently said nothing.
 */
async function cachedDocument(url, suffix, recognise, { offline = false, refresh = false } = {}) {
  const path = cacheFile(suffix);
  const cached = existsSync(path) ? readCache(path) : null;
  const usable = cached !== null && recognise(cached);
  const fresh = usable && Date.now() - statSync(path).mtimeMs < FRESH_MS;

  if (offline || (fresh && !refresh)) {
    if (cached === null) throw new Error(`No cached ${url} for ${SITE}. Run once with a network connection first.`);
    if (!usable) throw new Error(`Cached ${url} at ${path} is not a document this version recognises. Delete it and run online.`);
    return { doc: cached, from: "cache", site: SITE };
  }

  try {
    const response = await fetch(`${SITE}${url}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const doc = await response.json();
    if (!recognise(doc)) throw new Error(`${SITE}${url} answered something this version does not recognise`);
    writeFileSync(path, JSON.stringify(doc, null, 1));
    return { doc, from: SITE, site: SITE };
  } catch (error) {
    if (usable) return { doc: cached, from: "cache (fetch failed)", site: SITE };
    throw new Error(`Could not reach ${SITE}${url} and have no usable cached copy: ${error.message}`);
  }
}

/**
 * The instance's own contract — every v2 path, verb, request body and refusal.
 *
 * Recognised by `info.version === 2`, which is the one check that would have
 * caught the whole of this migration: the old code fetched `/openapi.json`,
 * got a perfectly valid `info.version: 1` document listing thirteen auth
 * paths, cached it, and reported success.
 *
 * Having none of this is an error rather than an empty schema, because a
 * validator that checks nothing and says "no problems" is worse than one that
 * refuses to run.
 */
export async function openapi(options = {}) {
  return cachedDocument(
    "/api/v2/openapi.json",
    "",
    (doc) => Number(doc?.info?.version) === 2 && typeof doc?.paths === "object",
    options,
  );
}

/**
 * What this server can do, what it will accept in an upload, and what things
 * cost — `<site>/api/v2/status`, public and unauthenticated.
 *
 * This replaces `/api/health`, which still answers and is still the operator's
 * own page; `limits` is what these tools need, and it is here. **Read the
 * numbers, never carry them.** `publish` had `40` written into it twice as a
 * literal; the value was right and the source was wrong, and the day the
 * instance raises it every clone of this repository is silently a version
 * behind.
 */
export async function status(options = {}) {
  return cachedDocument(
    "/api/v2/status",
    "-status",
    (doc) => typeof doc?.capabilities === "object" && typeof doc?.limits === "object",
    options,
  );
}

/** The instance's own numbers, with no local defaults behind them: a missing
 * limit is `undefined`, and a caller deciding what to do about that is better
 * than a caller quietly using a number this repository made up. */
export async function limits(options = {}) {
  const { doc, from } = await status(options);
  return { limits: doc.limits ?? {}, media: doc.media ?? {}, capabilities: doc.capabilities ?? {}, from };
}

/** Follow a `$ref` into the document's own components. */
export function deref(schema, doc) {
  const name = schema?.$ref?.split("/").pop();
  return name ? (doc.components?.schemas?.[name] ?? schema) : schema;
}

/**
 * The request schema for one operation, refs resolved one level.
 *
 * This is the whole point of fetching the document: what a field may be is the
 * instance's answer, not ours.
 *
 * `requestBody` is the OpenAPI key. The generated v2 document emitted
 * `request` instead — not a key the specification has, so every standard tool
 * read two dozen write operations as taking no body at all — until fernscout's
 * B1714. Both are read here: an instance that has not been deployed since is
 * still describable, and the day it is, nothing here changes.
 */
export function requestSchema(doc, path, verb) {
  const operation = doc?.paths?.[path]?.[verb];
  const body = (operation?.requestBody ?? operation?.request)?.content?.["application/json"]?.schema;
  return body ? deref(body, doc) : null;
}

/**
 * Which sections one write must either carry or decline, and why.
 *
 * The asked-or-declined rule is v2's deepest change, and the document states
 * it per operation as `x-required-or-declined` on the body schema: a list of
 * `{field, whyRequired, toDecline}`. Read rather than copied, for the same
 * reason every other list here is read — this one is fourteen entries long for
 * a day, and it grows.
 */
export function declinables(doc, path, verb) {
  const schema = requestSchema(doc, path, verb);
  const declared = schema?.["x-required-or-declined"];
  return Array.isArray(declared) ? declared : [];
}

export function token() {
  const value = process.env.FERNSCOUT_TOKEN;
  if (!value) {
    throw new Error(
      "No FERNSCOUT_TOKEN. Get one with the six-digit code flow:\n" +
      `  curl -s -X POST ${SITE}/api/auth/request -H 'content-type: application/json' \\\n` +
      `       -d '{"user":"<username>","email":"<your address>","kind":"agent"}'\n` +
      `  curl -s -X POST ${SITE}/api/auth/verify  -H 'content-type: application/json' \\\n` +
      `       -d '{"user":"<username>","email":"<your address>","code":"123456","kind":"agent"}'\n` +
      `\n  "kind":"agent" on BOTH calls. Without it you get a guest cookie: 200 OK,\n` +
      `  no token in the body, and nothing saying you asked for the wrong thing.\n` +
      "then  export FERNSCOUT_TOKEN=…  (it lasts seven days).",
    );
  }
  return value;
}

/**
 * One API call. Returns `{ status, ok, body, etag }` — never throws on a 4xx,
 * because the caller's whole job is deciding what a refusal means.
 *
 * `etag` is carried out because v2 needs it: `PUT` is create-only, and writing
 * over a document that already exists is a deliberate act that has to send
 * `If-Match` with the ETag of the document it read. Dropping the header here
 * would make every replace a `409 stale_document` with no way to proceed.
 */
export async function call(method, path, { body, headers = {}, auth = true, ifMatch } = {}) {
  const init = { method, headers: { accept: "application/json", ...headers } };
  if (auth) init.headers.authorization = `Bearer ${token()}`;
  if (ifMatch) init.headers["if-match"] = ifMatch;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${SITE}${path}`, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, ok: response.ok, body: parsed, etag: response.headers.get("etag") };
}

/**
 * An API refusal, rendered.
 *
 * Three shapes now, and printing only the first is how a real publish run came
 * back as a bare "422 incomplete" with everything the server had said about
 * how to fix it thrown away:
 *
 *   `problems[]` — the shape of the document is wrong. Field, what arrived,
 *   what was expected.
 *   `details.missing[]` — the document is not wrong, it is incomplete: a
 *   section it must either answer or decline. The decline matters as much as
 *   the send — it is the answer for a day that genuinely had none, and the
 *   alternative to inventing one.
 *   `details.current` — a `409 stale_document` hands back the document as it
 *   stands now, which is what a caller needs in order to retry with
 *   `If-Match`.
 */
export function refusal(result) {
  const b = result.body ?? {};
  const lines = [`${result.status} ${b.error ?? "refused"}`];
  if (b.message) lines.push(`      ${b.message}`);
  const details = b.details ?? {};
  const problems = [
    ...(Array.isArray(b.problems) ? b.problems : []),
    ...(Array.isArray(details.problems) ? details.problems : []),
    ...(Array.isArray(details) ? details : []),
  ];
  for (const p of problems) {
    if (typeof p === "string") { lines.push(`      ${p}`); continue; }
    lines.push(`      ${p.field}: ${p.hint ?? p.problem ?? `expected ${p.expected}, got ${p.got}`}`);
  }
  const missing = Array.isArray(details.missing) ? details.missing : Array.isArray(b.missing) ? b.missing : [];
  for (const m of missing) {
    if (typeof m === "string") { lines.push(`      ${m}`); continue; }
    lines.push(`      ${m.field}: ${m.why ?? m.whyRequired ?? ""}`.trimEnd());
    if (m.send) lines.push(`          send    ${m.send}`);
    if (m.decline ?? m.toDecline) lines.push(`          or say  ${m.decline ?? m.toDecline}`);
  }
  if (details.current && (details.current.slug || details.current.id)) {
    lines.push(`      the stored document is ${details.current.slug ?? details.current.id} — read it and send If-Match to replace it`);
  }
  return lines.join("\n");
}
