// Talking to a Fernscout instance, and keeping a copy of what it published.
//
// The instance is the authority on what it will accept, and it says so at
// `<site>/openapi.json`. Fetched once and cached under `export/.schema/`, so a
// validation run works on a train and a publish run does not ask twice.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

export const SITE = process.env.FERNSCOUT_URL?.replace(/\/$/, "") || "https://fernscout.ch";
const CACHE = join(ROOT, "export", ".schema");
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
 * The instance's own contract.
 *
 * `offline` uses the cached copy and never touches the network; without a
 * usable cached copy that is an error rather than an empty schema, because a
 * validator that checks nothing and says "no problems" is worse than one that
 * refuses to run.
 */
export async function openapi({ offline = false, refresh = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}.json`);
  const cached = existsSync(path);
  const cachedDoc = cached ? readCache(path) : null;
  const usable = cachedDoc !== null;
  const fresh = usable && Date.now() - statSync(path).mtimeMs < FRESH_MS;

  if (offline || (fresh && !refresh)) {
    if (!cached) {
      throw new Error(`No cached schema for ${SITE}. Run once with a network connection first.`);
    }
    if (!usable) {
      throw new Error(`Cached schema at ${path} is not valid JSON. Delete it and run online, or run without --offline.`);
    }
    return { doc: cachedDoc, from: "cache", site: SITE };
  }

  try {
    const response = await fetch(`${SITE}/openapi.json`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const doc = await response.json();
    writeFileSync(path, JSON.stringify(doc, null, 1));
    return { doc, from: SITE, site: SITE };
  } catch (error) {
    if (usable) return { doc: cachedDoc, from: "cache (fetch failed)", site: SITE };
    throw new Error(`Could not reach ${SITE}/openapi.json and have no usable cached copy: ${error.message}`);
  }
}

/**
 * What this server can do, and what it will accept in an upload.
 *
 * `/api/health` is public and answers `capabilities` (every optional feature,
 * and *why* an absent one is absent) and `media` (the formats and the size
 * limits). Both were things these tools used to carry their own copy of, and
 * both had drifted: the format list here offered `jpg` and `avif`, neither of
 * which the server takes, so a batch was accepted by the local check and
 * refused half-way through the upload.
 */
export async function health({ offline = false, refresh = false } = {}) {
  const path = join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}-health.json`);
  const cached = existsSync(path);
  // `readCache` already folds "not valid JSON" into the same `null` as "not
  // there" — a corrupt file (half-written, hand-edited into garbage) is the
  // most unrecognised shape there is, and it must not survive a single run:
  // without this it throws a raw JSON syntax error out of `JSON.parse` here,
  // gets caught by validate.mjs's existing "(health)" warning, and is never
  // rewritten — every later run hits the same corrupt bytes and degrades the
  // same way, forever, which is exactly the check-loss this ticket is about,
  // just reached by a different door than a missing `media` key.
  const cachedDoc = cached ? readCache(path) : null;
  // A cached document with no `media` key is not an instance that has no
  // upload limits — the server has carried `media` since before this cache
  // format existed, so its absence means the copy predates it. The two are
  // indistinguishable by looking at the JSON alone, and treating the older
  // shape as "no limits" is exactly how B579 went unnoticed: the checks that
  // read `media` simply had nothing to read and said nothing about it. So an
  // unrecognised shape — no `media` key, or not parseable at all — is always
  // treated as stale, however new the mtime is, and refetched — a fresh
  // /api/health is cheap, and `offline` is still the one way to force the old
  // copy through anyway.
  const recognised = cachedDoc !== null && cachedDoc.media !== undefined;
  const fresh = cached && recognised && Date.now() - statSync(path).mtimeMs < FRESH_MS;
  if (offline || (fresh && !refresh)) {
    if (!cached) throw new Error(`No cached /api/health for ${SITE}. Run once online first.`);
    if (cachedDoc === null) {
      throw new Error(`Cached /api/health at ${path} is not valid JSON. Delete it and run online, or run without --offline.`);
    }
    return { doc: cachedDoc, from: "cache" };
  }
  try {
    const response = await fetch(`${SITE}/api/health`, { headers: { accept: "application/json" } });
    const doc = await response.json();
    writeFileSync(path, JSON.stringify(doc, null, 1));
    return { doc, from: SITE };
  } catch (error) {
    if (cachedDoc !== null) return { doc: cachedDoc, from: "cache (fetch failed)" };
    throw new Error(`Could not reach ${SITE}/api/health and have no usable cached copy: ${error.message}`);
  }
}

/**
 * The file shape itself — `<site>/content-model.json`, B608's answer to the
 * one part of the contract `openapi.json` and `/api/health` cannot describe:
 * which keys a file on disk may carry. Same cache, same day, same
 * `--offline`/`--refresh` — this is not a second caching path, it is the same
 * one with a third file in it.
 *
 * Unlike `openapi()` and `health()`, having none of this is an ordinary,
 * expected outcome rather than a failure to surface: an instance older than
 * B608 simply does not publish it yet, and `contentModel.mjs` falls back to
 * `model.mjs` for exactly that reason. So this never throws. A 404, an
 * unreachable host, a document with no recognisable `contentModel` version,
 * and one that does not even parse as JSON are all reported back as `doc:
 * null` with a `note` saying which — the caller decides what "no manifest"
 * means for it, this function's job stops at "here is what happened".
 *
 * "Unrecognised" is treated exactly the way B579 made `health()` treat a
 * `media`-less cache: not a fresh document with nothing to say, but a stale
 * one worth refetching regardless of its mtime. A response that is not valid
 * JSON, or has no integer `contentModel`, cannot be told apart from an old
 * cached copy by looking at the file alone — so both are refetched rather
 * than trusted.
 */
export async function contentModel({ offline = false, refresh = false } = {}) {
  const path = join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}-content-model.json`);
  const cached = existsSync(path);
  const cachedDoc = cached ? readCache(path) : null;
  const recognised = cachedDoc !== null && Number.isInteger(cachedDoc.contentModel);
  const fresh = cached && recognised && Date.now() - statSync(path).mtimeMs < FRESH_MS;

  if (offline || (fresh && !refresh)) {
    if (!cached) return { doc: null, from: "none", note: `no cached content model for ${SITE} — run once online first` };
    if (!recognised) return { doc: null, from: "cache", note: `cached content model at ${path} is not a recognised document` };
    return { doc: cachedDoc, from: "cache" };
  }

  let response;
  try {
    response = await fetch(`${SITE}/content-model.json`, { headers: { accept: "application/json" } });
  } catch (error) {
    if (recognised) return { doc: cachedDoc, from: "cache (fetch failed)" };
    return { doc: null, from: "none", note: `could not reach ${SITE}/content-model.json: ${error.message}` };
  }
  if (response.status === 404) {
    return { doc: null, from: "none", note: `${SITE} publishes no /content-model.json — an instance older than B608` };
  }
  if (!response.ok) {
    if (recognised) return { doc: cachedDoc, from: "cache (fetch failed)" };
    return { doc: null, from: "none", note: `${SITE}/content-model.json answered ${response.status} ${response.statusText}` };
  }
  let doc;
  try { doc = await response.json(); }
  catch {
    if (recognised) return { doc: cachedDoc, from: "cache (fetch failed)" };
    return { doc: null, from: "none", note: `${SITE}/content-model.json did not answer with JSON` };
  }
  writeFileSync(path, JSON.stringify(doc, null, 1));
  if (!Number.isInteger(doc.contentModel)) {
    return { doc: null, from: "none", note: `${SITE}/content-model.json has no recognisable "contentModel" version` };
  }
  return { doc, from: SITE };
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
 * instance's answer, not ours. `validate.mjs` reads types and enums out of
 * here and falls back to its own rules only for the keys that never cross the
 * API at all.
 */
export function requestSchema(doc, path, verb) {
  const body = doc?.paths?.[path]?.[verb]?.requestBody?.content?.["application/json"]?.schema;
  return body ? deref(body, doc) : null;
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
 * One API call. Returns `{ status, body }` — never throws on a 4xx, because
 * the caller's whole job is deciding what a 404 means (usually: create it).
 */
export async function call(method, path, { body, headers = {}, auth = true } = {}) {
  const init = { method, headers: { accept: "application/json", ...headers } };
  if (auth) init.headers.authorization = `Bearer ${token()}`;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${SITE}${path}`, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, ok: response.ok, body: parsed };
}

/**
 * An API refusal, rendered.
 *
 * Two shapes, and printing only the first one is how a real publish run came
 * back as a bare "422 incomplete_day" with everything the server had said
 * about how to fix it thrown away:
 *
 *   `problems[]` — the shape of the day is wrong. Field, what arrived, what
 *   was expected.
 *   `missing[]`  — the day is not wrong, it is incomplete: the trip keeps
 *   track of something this day says nothing about. Each entry carries `why`,
 *   `send` and `decline`, and the decline matters as much as the send — it is
 *   the answer for a day that genuinely had none, and the alternative to
 *   inventing one.
 */
export function refusal(result) {
  const b = result.body ?? {};
  const lines = [`${result.status} ${b.error ?? "refused"}`];
  if (b.message) lines.push(`      ${b.message}`);
  for (const p of Array.isArray(b.problems) ? b.problems : []) {
    lines.push(`      ${p.field}: ${p.hint ?? `expected ${p.expected}, got ${p.got}`}`);
  }
  for (const m of Array.isArray(b.missing) ? b.missing : []) {
    lines.push(`      ${m.field}: ${m.why}`);
    if (m.send) lines.push(`          send    ${m.send}`);
    if (m.decline) lines.push(`          or say  ${m.decline}`);
  }
  return lines.join("\n");
}
