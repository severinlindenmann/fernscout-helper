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
