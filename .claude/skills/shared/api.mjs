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

export function token() {
  const value = process.env.FERNSCOUT_TOKEN;
  if (!value) {
    throw new Error(
      "No FERNSCOUT_TOKEN. Get one with the six-digit code flow:\n" +
      `  curl -s -X POST ${SITE}/api/auth/request -H 'content-type: application/json' -d '{"user":"<username>","email":"<your address>"}'\n` +
      `  curl -s -X POST ${SITE}/api/auth/verify  -H 'content-type: application/json' -d '{"user":"<username>","email":"<your address>","code":"123456"}'\n` +
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

/** The problems list an API refusal carries, as lines. */
export function refusal(result) {
  const b = result.body ?? {};
  const problems = Array.isArray(b.problems) ? b.problems : [];
  const lines = problems.map((p) => `      ${p.field}: ${p.hint ?? `expected ${p.expected}, got ${p.got}`}`);
  return [`${result.status} ${b.error ?? b.message ?? "refused"}`, ...lines].join("\n");
}
