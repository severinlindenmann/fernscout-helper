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

/** Sent as ordinary values in the day body, if the file carries them. */
export const DAY_UPDATE_DOORS = [
  "time", "location", "country", "countryCode", "lat", "lng", "tags", "costs",
  "transportMode", "transportFrom", "transportTo", "travelScene", "test", "translations",
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
