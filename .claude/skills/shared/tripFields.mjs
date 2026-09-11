// B1518 — the two bugs this fixed (`teaser` dropped in silence, then `cover`
// the same way) were both a hardcoded key list in `publish.mjs` falling
// behind `content-model.json`. This is the one list of every `trip.md` key
// that has a door once the trip already exists, imported by both
// `publish.mjs` (to send them) and `validate-content` (to warn when
// `content-model.json` knows a key this list does not) — so the next field
// the instance grows cannot drift betwen the two the way `teaser` and
// `cover` did, each in only one of them.
//
// `id`, `status` and `test` are the three known-keys with no update door and
// are not gaps: `id` addresses the trip rather than describing it, `status`
// is the server's own computation from `start`/`end` (B1521), and `test` is
// set once at creation and never meant to change.
export const TRIP_UPDATE_DOORS = [
  "visibility", "listed", "teaser", "rates", "people", "travellers", "tracks",
  "title", "start", "end", "tagline", "accent", "costsVisibility", "translations",
  "cover", "intro",
];

/** Keys with no update door on purpose — not a gap, so never warned about. */
export const TRIP_NO_UPDATE_DOOR = new Set(["id", "status", "test"]);
