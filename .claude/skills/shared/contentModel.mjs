// The interpreter for `<site>/content-model.json` (B608/B609), and the
// snapshot fallback for an instance that cannot be reached at all (B610).
//
// `model.mjs` used to be the file shape's only source: a hand-kept copy, and
// it rotted more than once — see `docs/plans/W41-the-file-shape-is-
// published.md` in the fernscout repo. B609 taught this client to read the
// same document the server itself now publishes; B610 finished the job by
// moving every rule that could move and deleting the copy. What is left is
// this file, plus the disk-only checks `validate.mjs` keeps for itself
// (gallery files existing, media folders, filename/frontmatter dates,
// duplicate slugs, dates with no day — none of that is on any server to
// publish).
//
// Deleting the copy removes the only thing this client could check a journal
// against when the instance cannot be reached. A clone that needs a live
// server before it can check anything at all is a smaller promise than the
// one `AGENTS.md` makes ("no npm install before somebody's photographs
// work"), so the fallback is not gone — it moved from a hand-kept file to a
// **generated** one: `content-model.snapshot.json`, produced by fetching a
// real instance and never hand-edited (`snapshot.mjs`). The distinction is
// the whole reason this is allowed: a copy nobody checks against anything is
// how `model.mjs` rotted. This one is compared to the live document on every
// `selftest.mjs` run (`snapshotDrift()`, below), and a run that disagrees
// fails, loudly, naming the disagreement.
//
// The live instance always wins when it can be reached. The snapshot is only
// ever reached for when it cannot — see `resolveModel()`'s three-way
// fallback below — and every notice this file prints when it is used says so
// plainly: which snapshot, from where, taken when, and why the live document
// was not used instead.
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
// `checkKeys()`/`checkValue()` read: `{ type, enum, pattern, expected,
// required, fileOnly, apiOnly, note }`. There is no `Function`, no `eval`, no
// dynamic code path of any kind: an `assert` kind this file does not
// recognise is not attempted, guessed at, or skipped quietly — it is
// collected as a notice and reported by name. See `pattern.mjs` for the one
// kind, `pattern`, that takes something regex-shaped: it is anchored,
// length-capped, and matched with a linear-time matcher of this repository's
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
// rather than expressed, because a cost line or a gallery item is a member of
// an array, and this vocabulary's one wildcard addresses a map's members, not
// an array's). They are always this file's own lists — the honest
// alternative to a rule language with no wildcard for one — kept here now
// that there is no `model.mjs` for them to live in instead.
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
// returns a usable `{ MODEL, COST_KEYS, GALLERY_KEYS }` — from the live
// document when one can be had and understood, from the committed snapshot
// otherwise — plus `source` (which one, and where it came from) and
// `notices` (every edge case along the way, worded for a person to read).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { contentModel as fetchContentModel } from "./api.mjs";
import { compileSafePattern, PatternError } from "./pattern.mjs";

/**
 * A cost line is `components.schemas.Cost` in the published `openapi.json` —
 * its fields, its types and the closed list `category` must be one of all
 * come from there (`crosscheck()`, below, catches an unknown one). Named here
 * only so `checkCosts()` in `validate.mjs` can ask "is this key one of them
 * at all" before the instance's own schema gets a say on what it may be.
 */
export const COST_KEYS = ["label", "amount", "currency", "category"];

/**
 * A gallery item is `components.schemas.GalleryItem` in the published
 * document, the same way. Named here only so an unknown key can be caught —
 * the types, and the closed list `type` must be one of, are the instance's.
 */
export const GALLERY_KEYS = ["src", "type", "width", "height", "caption", "poster", "from"];

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
 * The seven `named` checks this client actually runs — hand-written in
 * `validate-content/validate.mjs`, independent of whether the file shape came
 * from the live document or the snapshot: the tracks:/without:/unrecorded:
 * cross-check, the locales:/translations: cross-check, the plan.md-only-for-
 * upcoming gate, the cost-line/gallery-item key checks (off `COST_KEYS`/
 * `GALLERY_KEYS`, above), the real-calendar-date check and the positive-
 * budget check. A manifest declaring a `named` id NOT in this list is one
 * this client has not implemented, and that is reported rather than silently
 * skipped — W41's "a check that did not run must never look like a check
 * that passed" applies to this client's own gaps as much as to the
 * manifest's.
 */
const IMPLEMENTED_NAMED = [
  "day-answers-tracked-fields",
  "day-translations-match-locales",
  "plan-only-for-upcoming-trips",
  "cost-line-known-keys",
  "gallery-item-known-keys",
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
 * The manifest, turned into `{ MODEL, COST_KEYS, GALLERY_KEYS }` — or
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
          // A fileOnly key can never appear in any request schema, by
          // definition — it never crosses the API at all — so `ruleFor()`'s
          // `published.description` fallback in validate.mjs (the live
          // schema's own wording, preferred everywhere it exists: see that
          // function's "the document's own wording is better than anything
          // written here") never has anything to offer one. The document's
          // own `because` is the only prose that will ever exist for a key
          // like this, and B620 put it there for exactly the two that had
          // none anywhere else (`cover`, `travellers`) — so this is where the
          // client reads it in as the key's tip, rather than the tip staying
          // hand-copied somewhere else. Every other assert kind is left
          // alone: `local.note` already carries the same `because` (below)
          // for a required-but-missing error, and a key that DOES cross the
          // API keeps deferring to the live description, which is more
          // likely to be current than a `because` written once and never
          // revisited.
          if (rule.because) local.tip = rule.because;
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

    // `files[<file>].noTip` — key names the document itself says are not
    // worth offering as a tip, because there is nothing to set: `test:` is
    // content nobody lived, and offering it as a choice is the exact defect
    // this exists to remove. Sibling to `what`/`api` on the file's own spec,
    // not a rule — `checkKeys()` skips a `noTip` key exactly like a `body`
    // one (validate.mjs's "nobody should be nudged towards `test`").
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

  return { ok: true, MODEL, notices };
}

/**
 * What this file shape and the live instance's `openapi.json` disagree
 * about.
 *
 * Both directions matter and they mean different things:
 *   missingHere  — the instance takes a field nobody here knows to offer.
 *   missingThere — a key that will be dropped on publish, silently.
 *
 * `MODEL` is whichever one `resolveModel()` just resolved — live document or
 * snapshot — so this check is only ever as current as the file shape it was
 * handed. It used to read a hand-kept copy of its own (`model.mjs`); B610
 * removed that copy, so the caller now passes in the one MODEL there is.
 */
export function crosscheck(openapi, MODEL) {
  const out = [];
  const compare = (file, schema, label) => {
    if (!schema) return;
    const there = Object.keys(schema.properties ?? {});
    const keys = MODEL[file]?.keys ?? {};
    // Two lists, because the two directions ask different questions. Every
    // key this file knows about — file-only ones included — answers "is the
    // instance offering something nobody here has heard of". Only the keys
    // that actually travel answer "will this be dropped on the way".
    const known = Object.keys(keys);
    const offered = known.filter((k) => !keys[k].fileOnly && !keys[k].apiOnly);
    for (const key of there) {
      if (key === "idempotency_key") continue;
      if (!known.includes(key)) out.push({ file, key, where: label, why: "the instance accepts this and nothing here offers it" });
    }
    for (const key of offered) {
      if (!there.includes(key)) out.push({ file, key, where: label, why: "this instance does not list it — it may be dropped on publish" });
    }
  };
  const body = (path, verb) =>
    openapi?.paths?.[path]?.[verb]?.requestBody?.content?.["application/json"]?.schema;
  const deref = (schema) => {
    const name = schema?.$ref?.split("/").pop();
    return name ? openapi.components?.schemas?.[name] : schema;
  };
  compare("trip.md", deref(body("/api/v1/{user}/trips", "post")), "POST …/trips");
  compare("entries/YYYY-MM-DD-slug.md", deref(body("/api/v1/{user}/trips/{trip}/days", "post")), "POST …/days");
  // A journal's file is written by two different calls — created by
  // POST /api/v1/journals and changed by PATCH …/config — so the fields it
  // may carry are the union of both. Comparing against either alone reports
  // half the file as unknown.
  const created = deref(body("/api/v1/journals", "post"))?.properties ?? {};
  const patched = deref(body("/api/v1/{user}/config", "patch"))?.properties ?? {};
  compare("config.json", { properties: { ...created, ...patched } }, "the journal's own fields");
  return out;
}

/**
 * What this file expects an `apiOnly` key's TYPE to be — never read off the
 * document, and that is deliberate rather than an oversight: a key that
 * `never-in-file` declares is one the manifest is right to say nothing else
 * about, because there is no value on disk for `type`/`enum`/`pattern` to
 * describe. Confirmed against a live `content-model.json`: every
 * `never-in-file` rule it publishes carries `because` and nothing else. So
 * this table is this repository's OWN record of what it believes these five
 * instructions look like — kept here, beside the check that uses it, rather
 * than inside `MODEL`, because it answers a different question than
 * everything else in this file does. Everything else asks "what does the
 * file shape say"; this asks "does the instance still agree with what this
 * client has assumed", and needs its own opinion to compare the instance
 * against.
 *
 * This is the one piece of B585's fix that survives `model.mjs`'s deletion by
 * necessity, not by choice — see `apiOnlyDrift()` below for what it is used
 * for and why it cannot be replaced with something read off the manifest.
 */
const API_ONLY_TYPES = {
  "entries/YYYY-MM-DD-slug.md": {
    weather: "boolean",
    weatherData: "object",
    coordinates: ["boolean", "string"],
    photos: ["boolean", "string"],
    idempotency_key: "string",
  },
};

/**
 * The blind spot `crosscheck()` cannot see: `checkKeys()` skips every
 * `apiOnly` key (`validate.mjs`'s `if (local.apiOnly) continue`), on purpose
 * — these keys never appear in a file, so there is nothing on disk to check
 * them against. That also means no fixture can ever exercise one, and B585
 * is what happened in that blind spot: `coordinates` and `photos` gained a
 * third answer over the API (`"unknown"`, beside `false`) and the file shape
 * this repository assumed kept saying "only ever false" for months before
 * anybody noticed by hand.
 *
 * This walks `API_ONLY_TYPES`, above, and compares each entry against the
 * instance's own request schema for the file that key belongs to. It cannot
 * check prose at all: nothing here parses English. But `type` is data, and
 * "boolean" beside `["boolean", "string"]` is a disagreement in kind, not in
 * wording — exactly what B585 asks this function to catch.
 */
export function apiOnlyDrift(openapi) {
  const out = [];
  const body = (path, verb) =>
    openapi?.paths?.[path]?.[verb]?.requestBody?.content?.["application/json"]?.schema;
  const deref = (schema) => {
    const name = schema?.$ref?.split("/").pop();
    return name ? openapi.components?.schemas?.[name] : schema;
  };
  const created = deref(body("/api/v1/journals", "post"))?.properties ?? {};
  const patched = deref(body("/api/v1/{user}/config", "patch"))?.properties ?? {};
  const SCHEMA_FOR = {
    "trip.md": deref(body("/api/v1/{user}/trips", "post")),
    "entries/YYYY-MM-DD-slug.md": deref(body("/api/v1/{user}/trips/{trip}/days", "post")),
    "config.json": { properties: { ...created, ...patched } },
  };
  for (const [file, keys] of Object.entries(API_ONLY_TYPES)) {
    const schema = SCHEMA_FOR[file];
    if (!schema) continue;
    for (const [key, type] of Object.entries(keys)) {
      const published = schema.properties?.[key];
      // No key there at all is `crosscheck()`'s finding, not this one's — it
      // already reports an `apiOnly` key the instance has dropped entirely.
      if (!published || published.type === undefined) continue;
      const here = [type].flat().slice().sort().join("|");
      const there = [published.type].flat().slice().sort().join("|");
      if (here !== there) {
        out.push({ file, key, why: `this repository assumes ${here}, the instance's schema says ${there}` });
      }
    }
  }
  return out;
}

/**
 * The committed fallback: `content-model.json` fetched from a real instance
 * by `snapshot.mjs` and never hand-edited, wrapped with the instance it came
 * from and the date it was taken. Read defensively — a half-written file from
 * a killed process, or one hand-edited into garbage, is treated exactly like
 * "no snapshot at all" rather than a thrown parse error.
 */
export const SNAPSHOT_PATH = join(ROOT, ".claude/skills/shared/content-model.snapshot.json");

export function readSnapshot(path = SNAPSHOT_PATH) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.snapshotOf !== "string" || typeof raw.snapshotTakenAt !== "string") return null;
  if (!raw.document || typeof raw.document !== "object") return null;
  return raw;
}

/**
 * Turn a committed snapshot into the same `{ MODEL, source, notices }` shape
 * `resolveModel()` returns for the live document — or `null` when there is no
 * usable snapshot to fall back to at all, which should not happen (one is
 * committed to the repository) but must not crash a validation run if it
 * ever does.
 *
 * `why` is the caller's account of what went wrong with the live document —
 * it is folded straight into `source`, because "used a snapshot" without
 * saying why is exactly the silent fallback W41 exists to end.
 */
function snapshotFallback(why) {
  const snapshot = readSnapshot();
  if (!snapshot) return null;
  const interpreted = interpretManifest(snapshot.document);
  if (!interpreted.ok) return null;
  const takenAt = snapshot.snapshotTakenAt.slice(0, 10);
  return {
    MODEL: interpreted.MODEL,
    COST_KEYS,
    GALLERY_KEYS,
    source: `a snapshot taken from ${snapshot.snapshotOf} on ${takenAt} — ${why}`,
    notices: interpreted.notices,
  };
}

/**
 * Fetch, interpret, and fall back — the one thing `validate.mjs` calls.
 *
 * Three sources, tried in this order, and the order is the whole point:
 *
 *   1. the live document, when the instance can be reached and understood —
 *      this always wins, because it is the only one that cannot go stale;
 *   2. the committed snapshot, when the live document could not be fetched,
 *      does not exist yet (an instance older than B608), or could not be
 *      interpreted — reported as exactly that, never silently;
 *   3. nothing usable at all, only if there is no committed snapshot either
 *      — a bug in this repository, not an expected outcome, since one is
 *      always committed.
 *
 * `source` is always worth printing: it says whether the file-shape checks
 * that just ran came from the live document or a snapshot, and — for a
 * snapshot — from where and when, and why the live one was not used. "Which
 * run did I get" has to be answerable without reading this module's source.
 */
export async function resolveModel({ offline = false, refresh = false } = {}) {
  let fetched;
  try {
    fetched = await fetchContentModel({ offline, refresh });
  } catch (failure) {
    const snapshot = snapshotFallback(`the live document could not be fetched (${failure.message}), so this may be out of date`);
    if (snapshot) return snapshot;
    throw failure;
  }

  if (!fetched.doc) {
    // `fetched.note` already says why — unreachable, no cache, 404 (an
    // instance older than B608), not JSON, or an unrecognised version.
    const snapshot = snapshotFallback(`${fetched.note} — the instance was not reachable, so this may be out of date`);
    if (snapshot) return snapshot;
    return { MODEL: {}, COST_KEYS, GALLERY_KEYS, source: `no file shape available (${fetched.note}, and no committed snapshot to fall back to)`, notices: [] };
  }

  const interpreted = interpretManifest(fetched.doc);
  if (!interpreted.ok) {
    const snapshot = snapshotFallback(`the document from ${fetched.from} could not be interpreted (${interpreted.reason}), so this may be out of date`);
    if (snapshot) return snapshot;
    return { MODEL: {}, COST_KEYS, GALLERY_KEYS, source: `no file shape available (${interpreted.reason})`, notices: interpreted.notices };
  }

  return {
    MODEL: interpreted.MODEL,
    COST_KEYS,
    GALLERY_KEYS,
    source: `content-model.json (${fetched.from})`,
    notices: interpreted.notices,
  };
}

/**
 * The check the whole snapshot design hangs on: `selftest.mjs` calls this
 * with the live document, and it fails, naming the disagreement, when the
 * committed snapshot no longer matches it. `model.mjs` rotted because nothing
 * compared it to anything — a committed copy is only acceptable here because
 * this makes going stale a failing test rather than something nobody notices.
 *
 * Compared as `rules`/`named`/`files`, each independently, rather than one
 * big deep-equal against the whole document: a byte-for-byte compare would
 * also fail on harmless reordering (nothing about the document's contract
 * promises a stable array order), and naming which *rule* changed is a lot
 * more useful than "the documents differ". Values are compared by their own
 * JSON text, sorted, so reordering within `rules`/`named` is not itself a
 * disagreement — only a rule that is actually different, added, or missing
 * is.
 */
export function snapshotDrift(liveDoc, snapshot) {
  const problems = [];
  if (!snapshot) {
    problems.push("no committed snapshot to compare — run node .claude/skills/shared/snapshot.mjs");
    return problems;
  }
  if (liveDoc.contentModel !== snapshot.document.contentModel) {
    problems.push(`contentModel version: live is ${liveDoc.contentModel}, snapshot is ${snapshot.document.contentModel}`);
  }
  if (JSON.stringify(liveDoc.files ?? {}) !== JSON.stringify(snapshot.document.files ?? {})) {
    problems.push("\"files\" differs between the live document and the snapshot");
  }
  const byText = (list) => new Set((list ?? []).map((item) => JSON.stringify(item)));
  const liveRules = byText(liveDoc.rules);
  const snapRules = byText(snapshot.document.rules);
  for (const rule of liveRules) if (!snapRules.has(rule)) problems.push(`rule only on the live instance: ${rule}`);
  for (const rule of snapRules) if (!liveRules.has(rule)) problems.push(`rule only in the snapshot: ${rule}`);
  const liveNamed = byText(liveDoc.named);
  const snapNamed = byText(snapshot.document.named);
  for (const n of liveNamed) if (!snapNamed.has(n)) problems.push(`named check only on the live instance: ${n}`);
  for (const n of snapNamed) if (!liveNamed.has(n)) problems.push(`named check only in the snapshot: ${n}`);
  return problems;
}
