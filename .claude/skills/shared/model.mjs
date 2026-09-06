// Every option a Fernscout journal has, as data.
//
// ## Why this is here and not only on the server
//
// The instance publishes its own contract at `<site>/openapi.json`, and that
// is the authority for **what a route will accept**. It is not, and cannot be,
// the authority for **what a file on disk may contain**: a journal is markdown
// with frontmatter, and several of its keys never cross the API at all —
// `gallery:` is the media call, `status: draft` is the publish call, `id:` is
// the folder's name.
//
// So this file is the file format, and `crosscheck()` below compares it
// against whatever the live instance publishes — in both directions. A key
// here that the instance does not know is a key that will be silently dropped
// on publish. A field the instance accepts that is missing here is an option
// nobody is being told about, which is the whole complaint this exists to
// answer.
//
// **What is deliberately NOT here: types and enums.**
//
// They used to be, and they were wrong within a week — the media formats
// listed `jpg` and `avif`, neither of which the server takes, and the cost
// categories were enforced from a copy. Every one of them now comes from the
// instance: `validate.mjs` reads the type, the `enum` and the `required` list
// out of the fetched `/openapi.json` for any key that crosses the API, and out
// of `/api/health` for the upload formats and limits. What is left here is the
// half a contract about HTTP cannot describe: which keys a file on disk may
// carry, which of them never travel, and what each one is for.
//
// A `type` or `enum` below is therefore a deliberate statement that the API
// does not carry this key — `gallery`, `status`, `without`. If you find
// yourself adding one for a field the API does have, the answer is in the
// document already.
//
// **Keep it honest.** Every key below is one that exists in the Fernscout
// codebase today. Do not add a key because it seems reasonable — an invented
// option produces a confident tip telling somebody to set something that does
// nothing.
//
// `tip` is what a person is told when an optional key is absent. Write it as
// something they can act on, or leave it out; "consider setting tagline" helps
// nobody.

/**
 * The capabilities are the instance's to list — `GET /api/health` answers one
 * entry per feature, with the reason an absent one is absent. Nothing here
 * keeps a copy: the list gained `weather` and this file did not notice.
 */

const ISO_DATE = { type: "string", pattern: /^\d{4}-\d{2}-\d{2}$/, expected: "a date like 2026-06-24" };

export const MODEL = {
  "config.json": {
    what: "who this journal belongs to, and what it switches on",
    api: "POST /api/v1/journals to create, PATCH /api/v1/{user}/config to change",
    keys: {
      ownerName: { type: "string", apiOnly: true, note: "owner.name in the file" },
      ownerNickname: { type: "string", apiOnly: true, note: "owner.nickname in the file" },
      username: { type: "string", apiOnly: true, note: "the folder name is the username — the API asks for it, the file does not carry it" },
      title: { type: "string", required: true },
      owner: { type: "object", required: true, fileOnly: true, note: "{ name, nickname, email } — the API takes ownerName and ownerNickname instead, and the address from the signup" },
      tagline: { type: "string", tip: "a line under the title on the front page" },
      visibility: { tip: "whether this instance advertises the journal at all. Absent reads as public" },
      startLocation: { type: "string", tip: "where the maps open before a trip has begun" },
      defaultLocale: { type: "string", required: true },
      locales: { type: "array", required: true, note: "every language the journal is written in" },
      baseCurrency: { type: "string", tip: "what totals are converted into" },
      displayCurrencies: { type: "array", tip: "the currencies shown beside the base one" },
      units: {},
      manualRates: { type: "object", tip: "rates the ECB does not publish, as units per euro" },
      features: { type: "object", tip: "what this journal switches on — /api/health lists what this server can offer, and why anything off is off" },
      travellers: {
        type: "array",
        fileOnly: true,
        tip:
          "how the walking figures are drawn when a trip does not say. There is no API " +
          "call for the journal's default party — it is read from this file, and a trip's " +
          "own travellers: block is set through …/trips/<trip>/travellers",
      },
      media: { type: "object", fileOnly: true, note: "this journal's upload allowance; may narrow the server's, never widen it" },
    },
  },

  "trip.md": {
    what: "the trip itself. Frontmatter, then the intro prose as the body",
    api: "POST /api/v1/{user}/trips",
    keys: {
      id: { type: "string", required: true, pattern: /^[a-z0-9][a-z0-9-]*$/, expected: "lowercase letters, digits and hyphens", note: "must equal the folder name" },
      title: { type: "string", required: true },
      start: { ...ISO_DATE, required: true, note: "a trip without start and end is skipped at every reading path" },
      end: { ...ISO_DATE, required: true },
      tagline: { type: "string", tip: "one line under the trip's title" },
      intro: { type: "string", body: true, apiOnly: true, note: "the prose under the frontmatter; the API calls it intro" },
      status: { tip: "which trip the journal opens on" },
      accent: { tip: "the trip's colour" },
      visibility: { tip: "who may read it. private = only the people who were there; guest = everyone let into the journal. An unreadable value reads as private, never public" },
      listed: { type: "boolean", tip: "false keeps a public trip out of the sitemap, the feed and the switcher. It only ever narrows" },
      costsVisibility: { tip: "who may see what it cost, once they can read the trip at all" },
      test: { noTip: true, note: "content nobody lived, written to prove the pipeline works. It says so in a banner" },
      people: { type: "array", tip: "who was on the trip — up to ten, each a name and an email. They may write to it, and it is who the trip is credited to" },
      travellers: { type: "array", tip: "how the party is drawn on this trip" },
      rates: { type: "object", tip: "the rates this trip's money was actually changed at, as units per euro" },
      tracks: { type: "object", tip: "what this trip keeps track of — costs, location, photos. Absent means all of them, and a day missing one is refused" },
      translations: { type: "object", tip: "the title, tagline and intro in the journal's other languages" },
      cover: { type: "string", fileOnly: true, tip: "a photograph from the trip for the index and the OG image. It cannot be set at create time — the media does not exist yet" },
    },
  },

  "entries/YYYY-MM-DD-slug.md": {
    what: "one update. Several per day is normal",
    api: "POST /api/v1/{user}/trips/{trip}/days, then …/days/{slug}/publish",
    keys: {
      title: { type: "string", required: true },
      date: { ...ISO_DATE, required: true, note: "must match the filename, and fall inside the trip" },
      content: { type: "string", required: true, body: true, note: "the prose — the markdown after the frontmatter" },
      time: { type: "string", pattern: /^([01]\d|2[0-3]):[0-5]\d$/, expected: "24-hour, like 18:40", tip: "orders several updates that share a date" },
      location: { type: "string", tip: "where this was" },
      country: { type: "string", tip: "the country's name, not its code" },
      countryCode: { type: "string", pattern: /^[A-Z]{2}$/, expected: "two capitals, like PT", tip: "draws the flag" },
      lat: { type: "number", tip: "where it goes on the map" },
      lng: { type: "number" },
      transportMode: { tip: "how you arrived; draws the leg from the previous day" },
      transportFrom: { type: "string" },
      transportTo: { type: "string" },
      travelScene: { tip: "how the travel scene into this day plays" },
      tags: { type: "array", tip: "lowercase words joined by single hyphens" },
      costs: { type: "array", tip: "what this day cost, each line in the currency it was spent in" },
      test: { noTip: true, note: "content nobody lived, written to prove the pipeline works" },
      translations: { type: "object", tip: "the title and prose in the journal's other languages. Required when the journal declares more than one" },
      without: { type: "array", fileOnly: true, note: "what this day deliberately has none of — written by sending e.g. costs: false" },
      unrecorded: {
        type: "array",
        fileOnly: true,
        note:
          "what this day had and nobody wrote down — written by sending e.g. " +
          'costs: "unknown". A different statement from `without`, and kept apart on ' +
          "purpose: *there was none* against *there was some and it is gone*",
      },
      // The three request-only fields on a day. They are instructions to the
      // server, not content: nothing on disk carries them, and a file that did
      // would be describing a call rather than a day.
      weather: { apiOnly: true, note: "ask the server to look up what the weather was" },
      weatherData: { apiOnly: true, note: "a reading somebody actually took" },
      coordinates: { apiOnly: true, note: "only ever false — this day has no one place" },
      photos: { apiOnly: true, note: "only ever false — this day has no photographs" },
      idempotency_key: { apiOnly: true, note: "names one write, so a retry is safe" },
      gallery: { type: "array", fileOnly: true, note: "the photographs. Not part of the day's body over the API — POST them to …/media" },
      cover: { type: "string", fileOnly: true },
      status: { type: "string", enum: ["draft"], fileOnly: true, note: "publishing is a separate call, never a field" },
    },
  },

  "costs.md": {
    what: "the budget and what was spent before leaving. Optional",
    api: "PUT /api/v1/{user}/trips/{trip}/costs",
    optional: true,
    tip: "no costs.md — a trip with a budget shows how the spending is tracking against it",
    keys: {
      budget: { type: "object", tip: "{ total, days, currency } — what the trip was expected to cost" },
      costs: { type: "array", tip: "flights, accommodation and anything else paid before leaving" },
    },
  },

  "plan.md": {
    what: "the planned route, for a trip that has not happened yet. Optional",
    api: "not over the API today — write the file",
    optional: true,
    onlyWhen: (trip) => trip?.status === "upcoming",
    tip: "an upcoming trip with no plan.md shows no route on its map",
    keys: {
      route: { type: "array", tip: "the stops, each with a location:" },
    },
  },
};

/**
 * A cost line is `components.schemas.Cost` in the published document — its
 * fields, its types and the closed list `category` must be one of all come
 * from there. This names the keys only so an unknown one can be caught; the
 * rules are the instance's.
 */
export const COST_KEYS = ["label", "amount", "currency", "category"];

/**
 * A gallery item is `components.schemas.GalleryItem` in the published
 * document. Named here only so an unknown key can be caught — the types, and
 * the closed list `type` must be one of, are the instance's.
 */
export const GALLERY_KEYS = ["src", "type", "width", "height", "caption", "poster", "from"];

/**
 * Which files may be uploaded is `media` in `GET /api/health` —
 * `imageFormats`, `videoFormats` and the size limits. The copy that used to be
 * here listed `jpg` and `avif`; the server takes neither, so a gallery full of
 * `.jpg` passed this check and was refused by the upload. Do not put it back.
 */

/**
 * What this file and the live instance disagree about.
 *
 * Both directions matter and they mean different things:
 *   missingHere  — the instance takes a field nobody here knows to offer.
 *   missingThere — a key that will be dropped on publish, silently.
 */
export function crosscheck(openapi) {
  const out = [];
  const compare = (file, schema, label) => {
    if (!schema) return;
    const there = Object.keys(schema.properties ?? {});
    const keys = MODEL[file].keys;
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
