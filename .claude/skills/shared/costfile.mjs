// Reading and writing the `costs:` block of an entry, and the trip's costs.md.
//
// One entry has one `costs:` list, and two things write into it: a bank
// statement and a person. So the marker lives on the LINE, not on the block —
// `# bank` at the end of a line means "generated, replace me on the next
// import". Without it a line is somebody's own and is never touched.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const CATEGORIES = ["preparation", "flights", "accommodation", "food", "transport", "activities", "other"];
export const MARK = "# bank";

export const costLine = ({ label, amount, currency, category }, bank = false) =>
  `  - { label: ${JSON.stringify(label)}, amount: ${amount}` +
  (currency ? `, currency: "${currency}"` : "") +
  `, category: "${category ?? "other"}" }` + (bank ? `  ${MARK}` : "");

/** The `costs:` lines already in a file, split by who wrote them. */
export function readCostLines(text) {
  const m = text.match(/^costs:(.*)\n((?:  - .*\n)*)/m);
  if (!m) return { own: [], bank: [] };
  const lines = m[2].split("\n").filter(Boolean);
  // The first import marked the whole block instead of each line. Read it as
  // generated, so a re-run replaces those rather than duplicating them.
  if (m[1].includes("from the bank statement")) return { own: [], bank: lines };
  return { own: lines.filter((l) => !l.includes(MARK)), bank: lines.filter((l) => l.includes(MARK)) };
}

/** Put a whole `costs:` list back, above `status:`, or drop the block if empty. */
export function writeCostLines(path, lines) {
  const text = readFileSync(path, "utf8");
  const block = lines.length ? `costs:\n${lines.join("\n")}\n` : "";
  const existing = /^costs:.*\n(?:  - .*\n)*/m;
  const next = existing.test(text)
    ? text.replace(existing, block)
    : (block ? text.replace(/^status:/m, block + "status:") : text);
  if (next !== text) writeFileSync(path, next);
  return next !== text;
}

/** costs.md — the budget, and what was spent before leaving. */
export function readCostsMd(tripDir) {
  const path = join(tripDir, "costs.md");
  if (!existsSync(path)) return { path, text: null, own: [], bank: [] };
  const text = readFileSync(path, "utf8");
  return { path, text, ...readCostLines(text) };
}

export function writeCostsMd(tripDir, { budget, lines, prose }) {
  const path = join(tripDir, "costs.md");
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  const body = prose ?? old?.split(/\n---\n/).slice(1).join("\n---\n").trim() ?? "";
  const head = ["---"];
  if (budget) {
    head.push("budget:", `  total: ${budget.total}`, `  days: ${budget.days}`, `  currency: ${budget.currency}`);
  } else if (old) {
    const keep = old.match(/^budget:\n(?:  \w+: .*\n)+/m);
    if (keep) head.push(keep[0].trimEnd());
  }
  if (lines.length) head.push("costs:", ...lines);
  head.push("---", "", body.trim(), "");
  writeFileSync(path, head.join("\n"));
  return path;
}
