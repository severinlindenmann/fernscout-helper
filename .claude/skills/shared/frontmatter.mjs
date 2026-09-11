// The YAML that a Fernscout file's frontmatter actually uses, and no more.
//
// There is no dependency here on purpose — see AGENTS.md, "Scripts are plain
// Node with no dependencies". What the content model needs is a small subset:
// scalars, quoted strings, numbers, booleans, nested maps, lists of scalars,
// lists of maps, and the inline `{ label: "Dinner", amount: 62 }` form that
// `costs:` lines are written in.
//
// It is a READER. Nothing here writes YAML — `quoteScalar` on the server is
// the authority on that, and a second writer is how two escapes drift apart.
//
// ponytail: hand-rolled over that subset. `|`/`>` block scalars are read
// (B1401), losing their interior indentation in the process — see the
// comment beside BLOCK_SCALAR. If a journal ever needs anchors, flow
// sequences or a block scalar's whitespace preserved exactly, take a real
// YAML parser rather than growing this a clause at a time. `problems` below
// is what tells you: anything it cannot read is reported, never guessed at,
// and a stopped parse says how much it could not reach rather than only
// naming the first line of it (B1401).

/** Split `---\n…\n---\n` off the front. Body is everything after. */
export function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { yaml: null, body: text };
  return { yaml: match[1], body: match[2] };
}

const NUMBER = /^-?\d+(\.\d+)?$/;

// `|` (literal) or `>` (folded), with an optional chomping indicator
// (`-`/`+`) and an optional explicit indent digit, in either order —
// e.g. `|`, `|-`, `>2`, `|-2`. B1401's concrete trigger.
const BLOCK_SCALAR = /^[|>][+-]?\d?[+-]?$/;

/** One scalar: `"a"`, `'a'`, `12`, `true`, `null`, or a bare word. */
function scalar(raw) {
  const value = raw.trim();
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
    const inner = value.slice(1, -1);
    return value[0] === '"'
      ? inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : inner;
  }
  if (NUMBER.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return splitInline(value.slice(1, -1)).map(scalar);
  if (value.startsWith("{") && value.endsWith("}")) return inlineMap(value.slice(1, -1));
  return value;
}

/** Split on commas that are not inside quotes or brackets. */
function splitInline(text) {
  const out = [];
  let depth = 0, quote = null, current = "";
  for (const ch of text) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) { out.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

function inlineMap(text) {
  const out = {};
  for (const pair of splitInline(text)) {
    const at = pair.indexOf(":");
    if (at < 0) continue;
    out[pair.slice(0, at).trim().replace(/^["']|["']$/g, "")] = scalar(pair.slice(at + 1));
  }
  return out;
}

/** Strip a trailing `# comment`, unless it is inside quotes. */
function uncomment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * Parse the subset. Returns `{ data, problems }` — a line it cannot read is a
 * problem with its number, never a silently dropped key. That is the whole
 * reason this exists rather than a regex per field: the failure this repository
 * keeps hitting is a value that was sent and never arrived.
 */
export function parseYaml(yaml) {
  const problems = [];
  const rows = [];
  yaml.split(/\r?\n/).forEach((raw, index) => {
    const line = uncomment(raw).replace(/\s+$/, "");
    if (line.trim() === "") return;
    const indent = line.length - line.trimStart().length;
    rows.push({ indent, text: line.trim(), line: index + 1 });
  });

  let at = 0;
  function block(indent) {
    // A list, or a map — decided by the first row at this indent.
    if (at < rows.length && rows[at].indent === indent && rows[at].text.startsWith("- ")) {
      const list = [];
      while (at < rows.length && rows[at].indent === indent && rows[at].text.startsWith("- ")) {
        const row = rows[at];
        const rest = row.text.slice(2).trim();
        at += 1;
        if (/^[A-Za-z_][\w.-]*:/.test(rest) && !rest.startsWith("{")) {
          // `- src: "…"` — a map whose first key shares the dash's line.
          const item = {};
          const key = rest.slice(0, rest.indexOf(":")).trim();
          const value = rest.slice(rest.indexOf(":") + 1).trim();
          item[key] = value === "" ? block(indent + 2) : scalar(value);
          while (at < rows.length && rows[at].indent > indent && !rows[at].text.startsWith("- ")) {
            const child = rows[at];
            const childKey = child.text.slice(0, child.text.indexOf(":")).trim();
            const childValue = child.text.slice(child.text.indexOf(":") + 1).trim();
            at += 1;
            item[childKey] = childValue === "" ? block(child.indent + 2) : scalar(childValue);
          }
          list.push(item);
        } else {
          list.push(scalar(rest));
        }
      }
      return list;
    }
    const map = {};
    while (at < rows.length && rows[at].indent === indent) {
      const row = rows[at];
      const colon = row.text.indexOf(":");
      if (colon < 0) {
        problems.push({ line: row.line, text: row.text, why: "not a key, a list item or a comment" });
        at += 1;
        continue;
      }
      const key = row.text.slice(0, colon).trim();
      const value = row.text.slice(colon + 1).trim();
      at += 1;
      if (BLOCK_SCALAR.test(value)) {
        // ponytail: rows are stored fully trimmed (see the row-building loop
        // above), so any indentation *within* the block beyond its own line
        // is already gone by the time it gets here — every content line
        // collapses to its bare text. Good enough for the prose this
        // repository's frontmatter actually carries; a real YAML parser is
        // the upgrade if a block ever needs its interior whitespace kept.
        const folded = value.startsWith(">");
        const clip = !value.includes("-") && !value.includes("+"); // default chomping
        const lines = [];
        while (at < rows.length && rows[at].indent > indent) {
          lines.push(rows[at].text);
          at += 1;
        }
        const joined = folded ? lines.join(" ") : lines.join("\n");
        map[key] = joined && clip ? `${joined}\n` : joined;
        continue;
      }
      if (value === "") {
        const next = rows[at];
        map[key] = next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))
          ? block(next.indent)
          : null;
      } else {
        map[key] = scalar(value);
      }
    }
    return map;
  }

  const data = rows.length ? block(rows[0].indent) : {};
  // B1401 — anything left unconsumed is a shape this parser could not
  // follow, and everything past that point is unread rather than genuinely
  // absent. That distinction has to survive as far as the caller: a required
  // field this parser never reached is not the same finding as one the file
  // truly lacks, and reporting them alike is how "costs: missing" gets
  // printed about a file that has a costs: line the parser just never got
  // to. So this is the one place that can tell the difference, and it says
  // so explicitly — how much went unread, and, best-effort, which top-level
  // keys among it may be among the missing ones — rather than naming only
  // the first unread row and leaving every key after it silently absent.
  if (at < rows.length) {
    const unread = rows.slice(at);
    const topIndent = rows[0].indent;
    const unreadKeys = [...new Set(
      unread
        .filter((row) => row.indent === topIndent)
        .map((row) => row.text.match(/^([A-Za-z_][\w.-]*):/)?.[1])
        .filter(Boolean),
    )];
    const why = "parsing stopped here — " + unread.length + " more line" + (unread.length === 1 ? "" : "s") + " unread" +
      (unreadKeys.length ? (", so these keys may be missing rather than absent: " + unreadKeys.join(", ")) : "");
    problems.push({
      line: unread[0].line,
      text: unread[0].text,
      why,
      // Machine-checkable: a caller (validate.mjs) can tell "the file lacks
      // this key" apart from "the parser did not get that far" by checking
      // this rather than parsing the sentence above.
      truncated: true,
      unreadKeys,
    });
  }
  return { data, problems };
}

/** `{ data, body, problems }` for one markdown file. */
export function parseFrontmatter(text) {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === null) return { data: {}, body, problems: [{ line: 1, text: "", why: "no --- frontmatter block" }] };
  const { data, problems } = parseYaml(yaml);
  return { data, body, problems };
}
