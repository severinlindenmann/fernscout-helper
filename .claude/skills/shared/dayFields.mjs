// ── A FALLBACK, NOT THE SOURCE — B1577 ────────────────────────────────────
//
// The instance publishes which call writes each key, in `content-model.json`'s
// `doors` section. `shared/doors.mjs` reads it and that answer wins. What is
// below is used only against an instance older than B1577, which publishes no
// doors at all — the same bargain `content-model.snapshot.json` already makes
// for the file shape.
//
// It is not left on trust: `selftest.mjs` compares every list here against a
// live document's doors and fails on a disagreement. That check is why a
// committed copy is acceptable where a hand-written list was not, and it is
// the difference between this file and the six lists B1577 was raised about.
//
// Once every instance these tools follow publishes doors, this file goes.

// Which keys of a day's markdown this repository can send, and through which
// door — B1569, and the same answer `tripFields.mjs` gives for `trip.md`.
//
// This was a hand-written list inside `publish.mjs`'s entry loop with nothing
// checking it, which made it the least protected of the six such lists and the
// most costly one to get wrong: a day is where almost every new field lands.
// A key the instance grows and this list does not know is simply never sent,
// on every run, with the run reporting success — the failure B1518 and B1569
// are both already recordings of.
//
// `validate-content` now warns when `<site>/content-model.json` knows a day
// key that appears in neither list below. That is a warning rather than a
// gate, and the gate belongs in the instance instead — B1577.

/**
 * Sent as ordinary values in the day body, if the file carries them.
 *
 * **Sent, never composed.** Every key here travels only when the file already
 * carries it; nothing in this repository fills one in. That is what makes the
 * list safe to grow — the last three were added by B1578 and each is a field a
 * person's own agent or instrument produced, which is exactly the case the
 * instance's own validators exist to police.
 *
 * The three B1578 added, and what the instance checks about each:
 *
 * - `timezone` — an IANA name, checked against `Intl` rather than a list, so
 *   `Asia/Bangkok` passes and `+07:00` is refused. It decides what a reader's
 *   "their time" is computed against, and a day without one falls back to the
 *   trip's.
 * - `visibility` — `guest` or `private`, or `null` to hold nothing back.
 *   There is no `public`: the label narrows what the trip's own visibility
 *   already allows and can never widen it.
 * - `weatherData` — a reading, with `source` and `recordedAt`. The one field
 *   on a day a caller may not simply assert, and the one this list was most
 *   wrong to drop: it is the sanctioned route for a measurement somebody's own
 *   instrument or service produced, and it was being thrown away in silence.
 *   The instance requires a non-empty `source`, an ISO `recordedAt`, at least
 *   one measurement, and every measurement in a plausible range — and it
 *   refuses `open-meteo` as a source outright, because that name means the
 *   server looked it up itself. A refusal stops the run like any other.
 */
export const DAY_UPDATE_DOORS = [
  "time", "timezone", "location", "country", "countryCode", "lat", "lng", "tags", "costs",
  "transportMode", "transportFrom", "transportTo", "travelScene", "test", "translations",
  "visibility", "weatherData",
];

/**
 * Keys that do travel, but not as themselves — so a key here is accounted
 * for, not missing. The value is where it is actually handled, because "it is
 * not in the list above" and "nobody sends it" are different facts and only
 * this sentence tells them apart.
 */
export const DAY_DEDICATED_DOORS = {
  title: "sent in the day body, always",
  date: "sent in the day body, always — from the frontmatter or the filename",
  content: "the markdown body itself",
  gallery: "POST …/trips/{trip}/media, as files rather than as a field",
  cover: "the trip's own cover, sent after the day loop once slugs are known",
  slug: "written back into the file by publish, never sent",
  status: "POST …/days/{slug}/publish, or left alone with --drafts",
  weather: "--weather sends `weather: true` for a day with coordinates; never a value",
  without: "sent as the field itself set to false — B560",
  unrecorded: "sent as the field itself set to \"unknown\" — B560",
};

/**
 * Weather sources only this server may claim — read from the instance, not
 * kept here.
 *
 * `/api/health` publishes `weather.reservedSources` (B1580), which is the same
 * constant `lib/validate/entry.ts` refuses by, so this cannot fall behind the
 * rule it is enforcing. It was hardcoded for exactly as long as the instance
 * described the list in prose only.
 *
 * Why a client needs it at all: a day whose weather this server looked up
 * carries `weatherData` with `source: "open-meteo"` **written into the file**,
 * and sending that back is refused — so a publish run that simply forwarded
 * every `weatherData` it found would fail on every day the archive had ever
 * answered for. Found by driving, not by reading (B1578).
 *
 * The fallback is not the old copy. An instance too old to publish the list,
 * or one that cannot be reached, leaves `reservedSources` absent — and a
 * client that then guessed would be back where it started. `open-meteo` is
 * named here as the one value every instance that has ever had this rule
 * refuses, and the run says when it is working from that rather than from the
 * instance's own answer.
 */
export const FALLBACK_RESERVED_WEATHER_SOURCES = ["open-meteo"];

/** Whether a reading in a file is the server's own, and so must not be sent
 * back as though somebody had measured it. `reserved` is what the instance
 * said; the fallback covers an instance that does not publish it yet. */
export function isServerWeather(weatherData, reserved) {
  const list = Array.isArray(reserved) && reserved.length
    ? reserved
    : FALLBACK_RESERVED_WEATHER_SOURCES;
  const source = typeof weatherData?.source === "string" ? weatherData.source.trim().toLowerCase() : "";
  return list.some((name) => String(name).toLowerCase() === source);
}
