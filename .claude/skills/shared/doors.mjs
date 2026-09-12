// Which keys of a file this repository cannot send — asked the same way three
// times, so it is written once.
//
// B1518 built the question for `trip.md`, B1569 for `config.json` and for a
// day. All three ask it of the instance's own `content-model.json`: given every
// key a file may carry, which of them does this repository account for — either
// by sending it, or by naming a reason it never travels? Anything left over is
// the next `teaser`, `cover`, `ownerTel` or `travellers`: accepted by the local
// check, never sent, and reported as a success.
//
// The warning this feeds is a fallback, and a weak one: it only notices after
// the instance has already grown the field. The gate belongs where the field is
// added, which is B1577.

/**
 * `modelKeys` is `MODEL[file].keys` — the instance's own list, each entry
 * carrying the flags `contentModel.mjs` folded out of the document.
 * `sends` is the list this repository puts on the wire; `accounted` is a map
 * of key to the sentence saying where else it goes, or why it never does.
 *
 * An `apiOnly` key is skipped, always. It never appears in a file at all, so
 * there is nothing on disk that could have failed to be sent — warning about
 * one would fire on every honest journal, which is its own kind of useless.
 */
export function unaccountedKeys(modelKeys, sends, accounted) {
  return Object.entries(modelKeys ?? {})
    .filter(([key, spec]) => !spec?.apiOnly && !sends.includes(key) && !(key in accounted))
    .map(([key]) => key);
}

/**
 * Which keys of a file travel as plain fields on its own general update call.
 *
 * **This is the read that ended the hand-kept lists** — B1577. The instance
 * publishes `doors` in `content-model.json`: a `call` (the file's own general
 * update call), an `update` map of key to the call that writes it, and a
 * `noUpdate` map of key to why none does. The keys whose call *is* `call` are
 * the ones a client puts in that call's body; the rest have doors of their own
 * and are somebody else's business.
 *
 * `fallback` is used only when the instance publishes no doors at all, which
 * means an instance older than B1577. It is a committed copy, the same bargain
 * `content-model.snapshot.json` already makes — and `selftest.mjs` fails when
 * a fallback disagrees with a live document, which is what makes a committed
 * copy acceptable here when a hand-written list was not.
 */
export function sendableKeys(doors, fallback) {
  if (!doors) return { keys: fallback, from: "fallback" };
  const keys = Object.entries(doors.update)
    .filter(([, call]) => call === doors.call)
    .map(([key]) => key);
  return { keys, from: "the instance" };
}

/** Keys with no door at all, and the reason for each — the instance's own
 * sentences where it publishes them (B1504 prints one to a person). */
export function noDoorKeys(doors, fallback) {
  if (!doors) return { reasons: fallback, from: "fallback" };
  return { reasons: doors.noUpdate ?? {}, from: "the instance" };
}
