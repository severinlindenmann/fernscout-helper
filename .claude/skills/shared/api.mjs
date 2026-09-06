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
 * The instance's own contract.
 *
 * `offline` uses the cached copy and never touches the network; without a
 * cached copy that is an error rather than an empty schema, because a
 * validator that checks nothing and says "no problems" is worse than one that
 * refuses to run.
 */
export async function openapi({ offline = false, refresh = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}.json`);
  const cached = existsSync(path);
  const fresh = cached && Date.now() - statSync(path).mtimeMs < FRESH_MS;

  if (offline || (fresh && !refresh)) {
    if (!cached) {
      throw new Error(`No cached schema for ${SITE}. Run once with a network connection first.`);
    }
    return { doc: JSON.parse(readFileSync(path, "utf8")), from: "cache", site: SITE };
  }

  try {
    const response = await fetch(`${SITE}/openapi.json`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const doc = await response.json();
    writeFileSync(path, JSON.stringify(doc, null, 1));
    return { doc, from: SITE, site: SITE };
  } catch (error) {
    if (cached) return { doc: JSON.parse(readFileSync(path, "utf8")), from: "cache (fetch failed)", site: SITE };
    throw new Error(`Could not reach ${SITE}/openapi.json and have no cached copy: ${error.message}`);
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
export async function health({ offline = false } = {}) {
  const path = join(CACHE, `${SITE.replace(/[^a-z0-9]+/gi, "-")}-health.json`);
  const cached = existsSync(path);
  const fresh = cached && Date.now() - statSync(path).mtimeMs < FRESH_MS;
  if (offline || fresh) {
    if (!cached) throw new Error(`No cached /api/health for ${SITE}. Run once online first.`);
    return { doc: JSON.parse(readFileSync(path, "utf8")), from: "cache" };
  }
  try {
    const response = await fetch(`${SITE}/api/health`, { headers: { accept: "application/json" } });
    const doc = await response.json();
    writeFileSync(path, JSON.stringify(doc, null, 1));
    return { doc, from: SITE };
  } catch (error) {
    if (cached) return { doc: JSON.parse(readFileSync(path, "utf8")), from: "cache (fetch failed)" };
    throw new Error(`Could not reach ${SITE}/api/health: ${error.message}`);
  }
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
