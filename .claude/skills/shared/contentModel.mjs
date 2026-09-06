// The interpreter for `<site>/content-model.json` (B608), and the fallback
// to `shared/model.mjs` for an instance that does not publish one yet.
//
// `model.mjs` is 263 lines of copied truth about the file shape, and it has
// rotted three times already (see its own header, and W41). The fix is not to
// hand-write a fourth copy here — it is to read the same document the server
// itself now publishes, the way `openapi.json` and `/api/health` already are.
//
// **This file does not evaluate anything.** It walks a fixed, closed
// vocabulary of eight `assert` kinds — `type`, `enum`, `pattern`, `required`,
// `shape`, `known-key`, `never-in-file`, `never-over-api` — and folds each one
// into the same plain data shape `validate.mjs`'s `checkKeys()`/`checkValue()`
// already know how to read off `model.mjs`. There is no `Function`, no
// `eval`, no dynamic code path of any kind: an assert kind this file does not
// recognise is not attempted, guessed at, or skipped quietly — it is
// collected as a notice and reported by name. See `pattern.mjs` for the one
// kind, `pattern`, that takes something regex-shaped: it is compiled by a
// linear-time matcher of this repository's own, never handed to `RegExp`.
//
// `resolveModel()` is the one entry point everything else calls. It always
// returns a usable `{ MODEL, COST_KEYS, GALLERY_KEYS }` — from the manifest
// when one can be had and understood, from `model.mjs` otherwise — plus
// `source` (which one, and where it came from) and `notices` (every edge case
// along the way, worded for a person to read). Nothing here throws for "no
// manifest": an instance older than B608 is the ordinary case this whole
// design exists to keep working through.
import { MODEL as FALLBACK_MODEL, COST_KEYS as FALLBACK_COST_KEYS, GALLERY_KEYS as FALLBACK_GALLERY_KEYS } from "./model.mjs";
import { contentModel as fetchContentModel } from "./api.mjs";
import { compileSafePattern, PatternError } from "./pattern.mjs";

/** The whole vocabulary. Nothing outside this set is attempted. */
const KNOWN_ASSERTS = new Set([
  "type", "enum", "pattern", "required", "shape", "known-key", "never-in-file", "never-over-api",
]);

/** Which major version of the document this client can read at all. A
 * document declaring a different one is refused wholesale — see W41's
 * "Version" section — never partially interpreted, because a partial read of
 * a format this client does not know is exactly the wrong findings W41 rules
 * out, only reached a different way. */
const SUPPORTED_MAJOR = 1;

/**
 * `named` checks this client actually runs. Empty today: B609 builds the
 * interpreter and keeps `model.mjs` as a fallback, and does not yet move any
 * cross-field rule across (that is B610, "rules cross over in batches" per
 * W41's order). So every `named` entry a manifest declares is, for now, one
 * this client has not implemented — and that is reported, not hidden, exactly
 * because "a check that did not run must never look like a check that
 * passed" (W41) applies to a client's own gaps as much as to the manifest's.
 */
const IMPLEMENTED_NAMED = [];

/** One key's `asserts` folded into the flat rule object `checkKeys()` and
 * `checkValue()` already read off `model.mjs` — `{ type, enum, pattern,
 * required, expected, tip, note, fileOnly, apiOnly, noTip, body, offerable }`.
 * Metadata that is prose rather than an assertion (`tip`, `note`, `noTip`,
 * `body`, `offerable`) rides along unchanged; it was never part of the closed
 * vocabulary and W41 does not ask it to be. */
function interpretKey(where, key, spec, notices) {
  const local = {};
  for (const field of ["tip", "note", "noTip", "body", "offerable"]) {
    if (spec[field] !== undefined) local[field] = spec[field];
  }
  for (const assertion of spec.asserts ?? []) {
    switch (assertion.assert) {
      case "type":
        local.type = assertion.type;
        break;
      case "enum":
        local.enum = assertion.enum;
        break;
      case "required":
        local.required = true;
        break;
      case "pattern":
        local.expected = assertion.expected;
        try {
          local.pattern = compileSafePattern(assertion.pattern);
        } catch (failure) {
          const reason = failure instanceof PatternError ? failure.message : String(failure);
          notices.push({
            kind: "rejected-pattern",
            message: `${where}.${key}: pattern rule rejected — ${reason} — the field is checked for everything else, not this`,
          });
        }
        break;
      case "never-in-file":
        local.apiOnly = true;
        break;
      case "never-over-api":
        local.fileOnly = true;
        break;
      case "known-key":
      case "shape":
        // Handled at the file level (`known-key`, over the whole set of
        // declared keys) or by `interpretShape()` below (`shape`, for a
        // nested object like a cost line or a gallery item) — a per-key
        // occurrence of either is accepted without changing this key's own
        // rule, since both describe the *container*, not this one field.
        break;
      default:
        notices.push({
          kind: "unknown-assert",
          message: `${where}.${key}: assert "${assertion.assert}" is not one this client knows ` +
            `(knows: ${[...KNOWN_ASSERTS].join(", ")})`,
        });
    }
  }
  return local;
}

/** One file's `rules` — today only ever `known-key` at the whole-file level.
 * `checkKeys()` in `validate.mjs` already refuses any key it was not told
 * about unconditionally, so a declared `known-key` does not change its
 * behaviour; what matters here is that the assert is recognised rather than
 * reported as one this client cannot run. */
function interpretFileRules(where, rules, notices) {
  for (const rule of rules ?? []) {
    if (!KNOWN_ASSERTS.has(rule.assert)) {
      notices.push({
        kind: "unknown-assert",
        message: `${where}: assert "${rule.assert}" is not one this client knows (knows: ${[...KNOWN_ASSERTS].join(", ")})`,
      });
    }
  }
}

/** `shapes.cost` / `shapes.gallery` — the known-key lists `COST_KEYS` and
 * `GALLERY_KEYS` used to be hand-written duplicates of. A `shape` this file
 * cannot get a key list out of (missing `known-key` rule, or no `keys` at
 * all) falls back to whatever the caller already had, with a notice — an
 * absent list is not the same as an empty one, and must not silently start
 * refusing every cost line's fields as unknown. */
function interpretShape(where, spec, notices, fallback) {
  if (!spec) return fallback;
  const hasKnownKey = (spec.rules ?? []).some((r) => r.assert === "known-key");
  if (!hasKnownKey || !Array.isArray(spec.keys)) {
    notices.push({
      kind: "unrecognised-shape",
      message: `${where}: no "known-key" rule with a "keys" list — kept the built-in list instead`,
    });
    return fallback;
  }
  interpretFileRules(where, spec.rules, notices);
  return spec.keys;
}

/**
 * The manifest, turned into the same shape `model.mjs` exports — or `null`
 * with a reason, when the document cannot be used at all (wrong major
 * version, or not shaped like a content model in the first place).
 */
export function interpretManifest(doc) {
  const notices = [];
  if (!doc || typeof doc !== "object" || !Number.isInteger(doc.contentModel)) {
    return { ok: false, reason: "the document has no recognisable \"contentModel\" version", notices };
  }
  if (doc.contentModel !== SUPPORTED_MAJOR) {
    return {
      ok: false,
      reason: `contentModel version ${doc.contentModel} is not one this client understands (knows: ${SUPPORTED_MAJOR}) — refusing to validate against it`,
      notices,
    };
  }

  const MODEL = {};
  for (const [file, spec] of Object.entries(doc.files ?? {})) {
    const keys = {};
    for (const [key, kspec] of Object.entries(spec.keys ?? {})) {
      keys[key] = interpretKey(file, key, kspec, notices);
    }
    interpretFileRules(file, spec.rules, notices);
    MODEL[file] = { what: spec.what, api: spec.api, optional: spec.optional, tip: spec.tip, keys };
  }

  const COST_KEYS = interpretShape("shapes.cost", doc.shapes?.cost, notices, FALLBACK_COST_KEYS);
  const GALLERY_KEYS = interpretShape("shapes.gallery", doc.shapes?.gallery, notices, FALLBACK_GALLERY_KEYS);

  for (const named of doc.named ?? []) {
    if (!IMPLEMENTED_NAMED.includes(named.id)) {
      notices.push({
        kind: "unimplemented-named",
        message: `named check "${named.id}" is declared but this client has not implemented it yet` +
          (named.because ? ` (${named.because})` : ""),
      });
    }
  }

  return { ok: true, MODEL, COST_KEYS, GALLERY_KEYS, notices };
}

/**
 * Fetch, interpret, and fall back — the one thing `validate.mjs` calls.
 *
 * `source` is always worth printing: it says whether the file-shape checks
 * that just ran came from the manifest or from `model.mjs`, and why, so
 * "which run did I get" is answerable without reading this module's source.
 */
export async function resolveModel({ offline = false, refresh = false } = {}) {
  const fallback = () => ({
    MODEL: FALLBACK_MODEL, COST_KEYS: FALLBACK_COST_KEYS, GALLERY_KEYS: FALLBACK_GALLERY_KEYS,
  });

  let fetched;
  try {
    fetched = await fetchContentModel({ offline, refresh });
  } catch (failure) {
    return { ...fallback(), source: `model.mjs (content-model.json: ${failure.message})`, notices: [] };
  }

  if (!fetched.doc) {
    return { ...fallback(), source: `model.mjs (${fetched.note ?? "no content model available"})`, notices: [] };
  }

  const interpreted = interpretManifest(fetched.doc);
  if (!interpreted.ok) {
    return { ...fallback(), source: `model.mjs (content-model.json from ${fetched.from}: ${interpreted.reason})`, notices: interpreted.notices };
  }

  return {
    MODEL: interpreted.MODEL,
    COST_KEYS: interpreted.COST_KEYS,
    GALLERY_KEYS: interpreted.GALLERY_KEYS,
    source: `content-model.json (${fetched.from})`,
    notices: interpreted.notices,
  };
}
