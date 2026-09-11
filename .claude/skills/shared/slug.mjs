// Mirrors fernscout's lib/slug.ts, which is the instance's own rule for
// turning a day's title into its address within a trip. Kept here rather
// than round-tripped to the server because validate-content checks every
// title pair in a folder before anything is sent (B1520) — but it is a copy,
// not the source: if the instance's slugify ever changes, this drifts, and
// the fix is to paste lib/slug.ts's TRANSLITERATIONS/logic back in here.
const TRANSLITERATIONS = [
  [/[äÄ]/g, "ae"],
  [/[öÖ]/g, "oe"],
  [/[üÜ]/g, "ue"],
  [/[æÆ]/g, "ae"],
  [/[œŒ]/g, "oe"],
  [/[þÞ]/g, "th"],
  [/ß/g, "ss"],
  [/[đĐðÐ]/g, "d"],
  [/[øØ]/g, "o"],
  [/[łŁ]/g, "l"],
];
const COMBINING_MARKS = /[̀-ͯ]/g;
const SLUG_MAX_LENGTH = 60;
const SLUG_FALLBACK = "entry";

export function slugify(text) {
  let out = text.normalize("NFC");
  for (const [pattern, replacement] of TRANSLITERATIONS) out = out.replace(pattern, replacement);
  return (
    out
      .toLowerCase()
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, "") || SLUG_FALLBACK
  );
}
