// Shared odds and ends. Kept tiny on purpose.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// …/repo/.claude/skills/icloud-export/lib.mjs → …/repo
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const argv = process.argv.slice(2);
export const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
export const has = (name) => argv.includes(`--${name}`);
export const die = (msg) => { console.error(msg); process.exit(1); };

// CSV fields may be quoted and contain commas; osxphotos writes CRLF.
export const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur.replace(/\r$/, "")); return out;
};

// osxphotos exports under the ORIGINAL filename, and appends "_edited" or
// " (1)" when two photos share one. The stem is what is left.
export const stemOf = (file) =>
  file.replace(/_edited/, "").replace(/\.[^.]+$/, "").replace(/ \(\d+\)$/, "").toLowerCase();
