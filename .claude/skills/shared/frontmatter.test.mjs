#!/usr/bin/env node
// Regression coverage for B1401 — a stopped YAML parse used to drop every
// key after the first unreadable row, silently, with only the first row
// named. Two things fixed together here:
//
//   C — block scalars (`|` and `>`) are read rather than truncating the
//       parse, which was the concrete trigger seen in the wild (a `costs:`
//       or `gallery:` key sitting after a multi-line field went missing).
//   B — a floor for every OTHER unmodelled shape: a stopped parse now says
//       how many rows it never reached and, best-effort, which top-level
//       keys are among them, on a machine-checkable `truncated`/`unreadKeys`
//       pair rather than only naming the first unread row.
//
//   node .claude/skills/shared/frontmatter.test.mjs
import { parseYaml } from "./frontmatter.mjs";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// ── the subset this parser already reads, still works ──────────────────────
{
  const { data, problems } = parseYaml('title: "Hello"\ncount: 3\nflag: true\n');
  check("a plain map still parses with no problems",
    problems.length === 0 && data.title === "Hello" && data.count === 3 && data.flag === true,
    JSON.stringify({ data, problems }));
}

// ── C: literal block scalar (`|`) ───────────────────────────────────────────
{
  const yaml = 'title: "Hello"\nsummary: |\n  line one\n  line two\ncosts: [1, 2]\ngallery: [3]\n';
  const { data, problems } = parseYaml(yaml);
  check("a `|` block scalar is read as its lines, joined with newlines",
    data.summary === "line one\nline two\n", JSON.stringify(data.summary));
  check("keys after a `|` block scalar are still reached",
    JSON.stringify(data.costs) === "[1,2]" && JSON.stringify(data.gallery) === "[3]",
    JSON.stringify(data));
  check("no problem is reported for a block scalar this parser now reads",
    problems.length === 0, JSON.stringify(problems));
}

// ── C: folded block scalar (`>`), with a chomping indicator ────────────────
{
  const yaml = 'note: >-\n  first\n  second\nafter: 1\n';
  const { data, problems } = parseYaml(yaml);
  check("a `>-` folded block scalar joins its lines with spaces and strips the trailing newline",
    data.note === "first second", JSON.stringify(data.note));
  check("a key after a folded block scalar is still reached",
    data.after === 1, JSON.stringify(data));
  check("no problem is reported for a folded block scalar",
    problems.length === 0, JSON.stringify(problems));
}

// ── B: any other unmodelled shape still stops the parse, but explicitly ────
{
  // Mismatched indentation inside `nested` is not a shape this parser
  // follows — the point of this case is not that it recovers, but that it
  // says so rather than quietly dropping `costs` and `gallery`.
  const yaml = 'title: "Hello"\nnested:\n  a: 1\n   b: 2\ncosts: [1, 2]\ngallery: [3]\n';
  const { data, problems } = parseYaml(yaml);
  check("what was read before the stop is still there",
    data.title === "Hello" && JSON.stringify(data.nested) === '{"a":1}', JSON.stringify(data));
  check("exactly one problem is reported for the whole stopped parse",
    problems.length === 1, JSON.stringify(problems));
  const [problem] = problems;
  check("the problem is machine-checkably marked as a truncated parse, not an ordinary bad row",
    problem?.truncated === true, JSON.stringify(problem));
  check("the problem names the keys that come after the stop, so a caller does not have to guess",
    Array.isArray(problem?.unreadKeys) &&
      problem.unreadKeys.includes("costs") && problem.unreadKeys.includes("gallery"),
    JSON.stringify(problem));
  check("the problem's own wording also says how much went unread",
    /\d+ more lines? unread/.test(problem?.why ?? ""), JSON.stringify(problem?.why));
}

if (failed > 0) {
  console.log(`\n${failed} frontmatter.mjs check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
