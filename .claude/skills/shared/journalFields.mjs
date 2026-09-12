// Which keys of `content/<user>/config.json` have a door, and which never do.
//
// The same answer `tripFields.mjs` gives one level down, and here for the same
// reason: `publish.mjs` carried a hand-written list of nine profile keys while
// the instance's `JOURNAL_PROFILE_FIELDS` had grown to eleven, so `ownerTel`
// (B614) and `travellers` (B1526) were dropped in silence on every run —
// B1569, which is `teaser` and `cover` all over again.
//
// The second half is the one `tripFields.mjs` does not need. Three keys are
// refused by `PATCH /api/v1/<user>/config` **on purpose**, each with its
// reason written beside it in the fernscout repo's `JOURNAL_FIELD_REFUSALS`.
// A client that correctly declines to send them still owes the person a word
// about it, because "every call succeeded" and "every line arrived" are not
// the same claim — B1504.
export const JOURNAL_UPDATE_DOORS = [
  "title", "tagline", "visibility", "startLocation", "units",
  "locales", "defaultLocale", "displayCurrencies", "manualRates",
  "ownerTel", "travellers",
];

/**
 * Keys with no update door on purpose — not a gap, so never reported as one.
 *
 * Keyed by the top-level key as it appears in `config.json`, and carrying the
 * sentence a person is told. Deliberately shorter than the instance's own
 * refusal text: that one is written for a caller who *tried* to send the
 * field and got a 400. Nobody here tried — the point is to say what was left
 * behind, once, before anyone wonders why the site did not change.
 */
export const JOURNAL_NO_UPDATE_DOOR = {
  owner:
    "owner.email decides who can get a token for this journal, so no token can move it. " +
    "The telephone number is the exception and travels as ownerTel.",
  baseCurrency:
    "a cost written with no currency IS a cost in the base one, so changing it re-reads " +
    "every amount already recorded rather than reconverting it. It is set when the journal " +
    "is created.",
  media:
    "the server's own limits are already a ceiling over it, so this block is the operator's " +
    "rather than the journal's.",
};

/**
 * Which of those three a run can actually check, and which it can only state.
 *
 * `GET /api/v1/<user>/config` reads back `baseCurrency` and — since B1504 —
 * `media`, so a local edit to either is a real difference a run can name. It
 * does not read back `owner.email`, deliberately: a token that can read a
 * journal's config is not permission to collect its owner's address. So there
 * is nothing to compare it against, and a run that warned about it anyway
 * would fire on every honest journal, which is its own kind of useless.
 */
export const JOURNAL_COMPARABLE_NO_DOOR = ["baseCurrency", "media"];
