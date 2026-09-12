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
