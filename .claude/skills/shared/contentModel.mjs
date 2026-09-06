// The interpreter for `<site>/content-model.json` (B608/B609), and the
// fallback to `shared/model.mjs` for an instance that does not publish one,
// or publishes something this client cannot read.
//
// `model.mjs` is a copy of the file shape, hand-kept, and it has rotted
// before — see its own header, and `docs/plans/W41-the-file-shape-is-
// published.md` in the fernscout repo. The fix is not a fourth copy here: it
// is reading the same document the server itself now publishes, the way
// `openapi.json` and `/api/health` already are.
//
// ## The document's actual shape
//
// `{ contentModel: 1, files: {...}, rules: [...], named: [...] }` — a FLAT
// array of rules, each `{ where, path, assert, ...kind-specific fields }`,
// plus a flat array of named cross-field checks this client implements by
// id. There is no nesting of rules under a file's keys: `path` addresses a
// key directly (`""` is the file's own root, used by the one whole-file
// `known-key` rule that lists every key the file may carry).
//
// **This file does not evaluate anything.** It walks the fixed, closed
// vocabulary of `assert` kinds — `type`, `enum`, `pattern`, `required`,
// `shape`, `known-key`, `never-in-file`, `never-over-api` — and folds each
// rule into the same plain per-key rule object `validate.mjs`'s
// `checkKeys()`/`checkValue()` already know how to read off `model.mjs`:
// `{ type, enum, pattern, expected, required, fileOnly, apiOnly, note }`.
// There is no `Function`, no `eval`, no dynamic code path of any kind: an
// `assert` kind this file does not recognise is not attempted, guessed at, or
// skipped quietly — it is collected as a notice and reported by name. See
// `pattern.mjs` for the one kind, `pattern`, that takes something
// regex-shaped: it is compiled by a linear-time matcher of this repository's
// own, never handed to `RegExp`.
//
// ## What a `path` can address, and what this client does with it
//
// `path` is `""` (the file's root — the whole-file `known-key` list),
// a plain key (`"title"`), or — the vocabulary's one wildcard — something
// with a `.` or a `*` in it (`"features.*"`). B644 is the first rule
// published at one: `config.json`'s `features.*` carries `assert: "shape"`
// with a `members` map, folded below into `MODEL[file].shapes[container]`
// rather than into `keys` — see that code for why a member's shape cannot be
// a flat per-key rule. `cost-line-known-keys` and `gallery-item-known-keys`
// stay `named` checks rather than a second `shape`/`known-key` pair at a
// wildcard path, precisely because a cost line or gallery item is a member
// of an *array*, which this vocabulary's one wildcard cannot address (see the
// document's own `named[].because`). A nested, non-wildcard path this client
// cannot fold anywhere (`"budget.total"`) is not attempted — nothing
// published today needs one.
//
// ## COST_KEYS / GALLERY_KEYS
//
// These never come from the manifest, by design, not by gap: the document
// itself says why (`cost-line-known-keys`/`gallery-item-known-keys` are named
// rather than expressed). They are always `model.mjs`'s own lists — the
// honest alternative to a rule language this vocabulary has no wildcard for.
//
// ## The failure this file exists to make impossible
//
// The incident this whole design answers (`unrecorded: [costs]`, AGENTS.md)
// was a manifest saying something this client did not know, reported
// silently. The failure a first attempt at this file *introduced* was the
// opposite shape of the same bug: a document read successfully, and folded
// into an empty ruleset that looked exactly like "understood, and there is
// nothing to check" — every key in a real journal then reads as "not a
// field". `interpretManifest()` below refuses to return `ok: true` if
// interpreting a non-empty `rules` array against a non-empty `files` object
// produces zero usable keys anywhere: that is a fault in reading the
// document, not an empty ruleset, and it is reported and falls back exactly
// like an unknown `assert` or an unsupported version.
//
// `resolveModel()` is the one entry point everything else calls. It always
// returns a usable `{ MODEL, COST_KEYS, GALLERY_KEYS }` — from the manifest
// when one can be had and understood, from `model.mjs` otherwise — plus
// `source` (which one, and where it came from) and `notices` (every edge case
// along the way, worded for a person to read).
import { MODEL as FALLBACK_MODEL, COST_KEYS as FALLBACK_COST_KEYS, GALLERY_KEYS as FALLBACK_GALLERY_KEYS } from "./model.mjs";
import { contentModel as fetchContentModel } from "./api.mjs";
import { compileSafePattern, PatternError } from "./pattern.mjs";

/** The whole vocabulary. Nothing outside this set is attempted. `shape` is
 * carried even though nothing published today emits it at a path this client
 * can fold anywhere — it is one of the eight kinds W41 promises, and refusing
 * to recognise the name would report a real, documented kind as unknown. */
const KNOWN_ASSERTS = new Set([
  "type", "enum", "pattern", "required", "shape", "known-key", "never-in-file", "never-over-api",
]);

/** Which major version of the document this client can read at all. A
 * document declaring a different one is refused wholesale — never partially
 * interpreted, because a partial read of a format this client does not know
 * is exactly the wrong findings W41 rules out, only reached a different way. */
const SUPPORTED_MAJOR = 1;

/**
 * The five `named` checks this client actually runs — hand-written in
 * `validate-content/validate.mjs`, independent of whether the file shape came
 * from the manifest or from `model.mjs`: the tracks:/without:/unrecorded:
 * cross-check, the locales:/translations: cross-check, the plan.md-only-for-
 * upcoming gate, and the cost-line/gallery-item key checks (off `COST_KEYS`/
 * `GALLERY_KEYS`, always `model.mjs`'s own lists — see the file header).
 * A manifest declaring a `named` id NOT in this list is one this client has
 * not implemented, and that is reported rather than silently skipped — W41's
 * "a check that did not run must never look like a check that passed"
 * applies to this client's own gaps as much as to the manifest's.
 */
const IMPLEMENTED_NAMED = [
  "day-answers-tracked-fields",
  "day-translations-match-locales",
  "plan-only-for-upcoming-trips",
  "cost-line-known-keys",
  "gallery-item-known-keys",
  // B644: both hand-written already, in `validate-content/validate.mjs` —
  // `isRealCalendarDate()` (an entry's `date`, no `2026-13-40`) and the
  // `budget.total`/`budget.days` positivity check beside the existing
  // "budget needs all three" one. Wiring these two ids onto the checks that
  // already run is the whole point: writing a *second* pair would be the
  // rotted-copy failure W41 exists to end, one level down.
  "entry-date-is-a-real-calendar-date",
  "budget-total-and-days-are-positive",
];

/**
 * The one piece of file shape the closed vocabulary has no `assert` kind for
 * at all: which key is not frontmatter but the markdown body itself. The
 * manifest is right to say `trip.md`'s `intro` and a day's `content` are
 * `required` strings — they are — but `checkKeys()` reads a file's
 * frontmatter object, where a body key never appears under its own name; it
 * is `trip.body`/`entry.body` instead, checked separately (`validate.mjs`'s
 * "has no intro prose" / "has no prose"). Folding a manifest's `required` for
 * one of these into an ordinary frontmatter check would report every file as
 * missing a key that in fact holds the entire prose of the page. This is
 * client-side file-format knowledge no HTTP contract or closed rule
 * vocabulary can carry — the same permanent exception `AGENTS.md` already
 * makes for cost/gallery item shapes and the client-only disk checks.
 */
const BODY_KEY_BY_FILE = {
  "trip.md": "intro",
  "entries/YYYY-MM-DD-slug.md": "content",
};

/**
 * The manifest, turned into the same shape `model.mjs` exports — or
 * `ok: false` with a `reason`, when the document cannot be used at all (wrong
 * major version, not shaped like a content model at all, or shaped like one
 * but folding into nothing usable — see the file header's last section).
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
  if (!Array.isArray(doc.rules)) {
    return { ok: false, reason: "the document has no \"rules\" array — nothing to interpret", notices };
  }
  const filesSpec = doc.files;
  if (!filesSpec || typeof filesSpec !== "object" || Array.isArray(filesSpec)) {
    return { ok: false, reason: "the document has no \"files\" object — nothing to interpret", notices };
  }

  const rulesByFile = new Map();
  for (const rule of doc.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.where !== "string") continue;
    if (!rulesByFile.has(rule.where)) rulesByFile.set(rule.where, []);
    rulesByFile.get(rule.where).push(rule);
  }

  const MODEL = {};
  let totalKeys = 0;
  for (const [file, spec] of Object.entries(filesSpec)) {
    const rules = rulesByFile.get(file) ?? [];
    const keys = {};
    const shapes = {};
    let knownKeyList = null;

    for (const rule of rules) {
      if (!KNOWN_ASSERTS.has(rule.assert)) {
        notices.push({
          kind: "unknown-assert",
          message: `${file}${rule.path ? `.${rule.path}` : ""}: assert "${rule.assert}" is not one this client knows ` +
            `(knows: ${[...KNOWN_ASSERTS].join(", ")})`,
        });
        continue;
      }
      const path = rule.path ?? "";
      if (path === "") {
        if (rule.assert === "known-key" && Array.isArray(rule.keys)) knownKeyList = rule.keys;
        continue;
      }
      // The one wildcard this vocabulary has (`features.*`) addresses every
      // member of a map, not one top-level key — `known-key`/`type`/etc at a
      // plain path fold into the flat per-key rule `checkKeys()` reads;
      // `shape` at a wildcard path describes the shape of every MEMBER
      // instead (B644 — `config.json`'s `features.*` is the first one
      // published), and is folded into `shapes[container]` below rather than
      // into `keys`, so a caller can check each member's own nested fields
      // (`value.enabled`) against `rule.members` — the exact thing the
      // server's own interpreter got backwards before B616 fixed it there:
      // it compared a wildcard member's whole VALUE against `rule.members`
      // keyed by member NAME, instead of checking each member's nested
      // fields against `rule.members`. A nested nonwildcard path
      // (`"budget.total"`) is not published by anything today and still
      // folds nowhere — there is no container to record it against.
      if (path.endsWith(".*") && rule.assert === "shape" && rule.members && typeof rule.members === "object") {
        const container = path.slice(0, -2);
        shapes[container] = { members: rule.members, because: rule.because };
        continue;
      }
      if (path.includes(".") || path.includes("*")) continue;

      const key = path;
      const local = keys[key] ?? {};
      switch (rule.assert) {
        case "type":
          local.type = rule.type;
          break;
        case "enum":
          local.enum = rule.values;
          break;
        case "required":
          local.required = true;
          break;
        case "pattern":
          local.expected = rule.expected;
          try {
            local.pattern = compileSafePattern(rule.pattern);
          } catch (failure) {
            const reason = failure instanceof PatternError ? failure.message : String(failure);
            notices.push({
              kind: "rejected-pattern",
              message: `${file}.${key}: pattern rule rejected — ${reason} — the field is checked for everything else, not this`,
            });
          }
          break;
        case "never-in-file":
          local.apiOnly = true;
          break;
        case "never-over-api":
          local.fileOnly = true;
          break;
        case "shape":
        case "known-key":
          // A `shape`/`known-key` at a plain top-level path describes the
          // container the key already is, not a further assertion on the
          // key's own rule — nothing to fold in beyond what `type` already
          // says.
          break;
        default:
          break;
      }
      if (rule.because && local.note === undefined) local.note = rule.because;
      keys[key] = local;
    }

    if (knownKeyList) {
      for (const key of knownKeyList) if (!keys[key]) keys[key] = {};
    }
    const bodyKey = BODY_KEY_BY_FILE[file];
    if (bodyKey && keys[bodyKey]) keys[bodyKey].body = true;
    if (!knownKeyList) {
      notices.push({
        kind: "missing-known-key",
        message: `${file}: no "known-key" rule at path "" — cannot say which keys this file may carry`,
      });
    }

    // B620/B644: `files[<file>].noTip` — key names the document itself says
    // are not worth offering as a tip, because there is nothing to set:
    // `test:` is content nobody lived, and offering it as a choice is the
    // exact defect this exists to remove. Sibling to `what`/`api` on the
    // file's own spec, not a rule — `checkKeys()` already skips a `noTip`
    // key exactly like a `body` one (validate.mjs's "nobody should be
    // nudged towards `test`").
    for (const key of Array.isArray(spec?.noTip) ? spec.noTip : []) {
      if (!keys[key]) keys[key] = {};
      keys[key].noTip = true;
    }

    MODEL[file] = { what: spec?.what, api: spec?.api, optional: spec?.optional, keys, shapes };
    totalKeys += Object.keys(keys).length;
  }

  // The case B609 exists to add: a document fetched and parsed fine, with a
  // non-empty `rules` array, that this interpreter nonetheless folds into
  // nothing usable for any file it knows about — indistinguishable, without
  // this check, from "understood, and there is genuinely nothing to check".
  // That is a fault in reading the document, not an empty ruleset.
  if (Object.keys(filesSpec).length > 0 && doc.rules.length > 0 && totalKeys === 0) {
    return {
      ok: false,
      reason: `content-model.json was fetched and parsed, but interpreting its ${doc.rules.length} rule(s) ` +
        `produced no usable keys for any of its ${Object.keys(filesSpec).length} file(s) — the document is ` +
        "structurally unreadable to this client",
      notices,
    };
  }

  for (const named of doc.named ?? []) {
    if (!named || typeof named.id !== "string") continue;
    if (!IMPLEMENTED_NAMED.includes(named.id)) {
      notices.push({
        kind: "unimplemented-named",
        message: `named check "${named.id}" is declared but this client has not implemented it yet` +
          (named.because ? ` (${named.because})` : ""),
      });
    }
  }

  return { ok: true, MODEL, COST_KEYS: FALLBACK_COST_KEYS, GALLERY_KEYS: FALLBACK_GALLERY_KEYS, notices };
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
