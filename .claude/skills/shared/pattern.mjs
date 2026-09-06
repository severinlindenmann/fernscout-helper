// A regular expression, but only the part of one a hostile document is
// allowed to hand this repository.
//
// `content-model.json` is fetched from wherever `FERNSCOUT_URL` names and its
// `pattern` assertions are matched against a file on somebody's own laptop.
// W41 draws the line plainly: "a hostile or broken instance must be able to
// produce wrong findings … and never wrong behaviour." A `pattern` handed to
// `new RegExp()` and run with `.test()` is exactly wrong behaviour waiting to
// happen — `^(a+)+$` against a long string of `a`s with no trailing match is
// the textbook way a regex engine backtracks its way to hanging a process,
// and nothing about a manifest's `pattern` field says it cannot contain that.
//
// So this file does not call `RegExp` on anything it did not write itself.
// It parses the closed subset of regex syntax below into a small NFA
// (Thompson's construction — the classic answer to "match untrusted
// patterns safely": https://swtch.com/~rsc/regexp/regexp1.html) and matches
// by simulating every live state at once, one input character at a time.
// That walk is `O(states × length)` NO MATTER WHAT THE PATTERN IS — there is
// no backtracking to blow up, because there is no backtracking.
//
// What is deliberately NOT supported, and rejected at compile time rather
// than silently ignored: backreferences (`\1`), lookahead/lookbehind
// (`(?=`, `(?!`, `(?<=`, `(?<!`), lazy quantifiers (`*?`), and anything else
// this parser does not recognise. All of those either require backtracking
// or executable semantics this file refuses to have. A pattern using them is
// a pattern this client cannot run — reported as a rejected rule, never
// attempted.
//
// `pattern` must additionally be *anchored* (`^…$`, the whole value) — this
// module refuses to compile anything else — and both the source text and the
// compiled machine are length-capped, so a manifest cannot make this file do
// unbounded work even at compile time.

const MAX_PATTERN_LENGTH = 200;
const MAX_INSTRUCTIONS = 2000;
const MAX_REPEAT = 50;

class PatternError extends Error {}

/** A predicate over one UTF-16 code unit. Character classes compose these. */
function classPredicate(kind) {
  switch (kind) {
    case "d": return (c) => c >= 48 && c <= 57;
    case "D": return (c) => !(c >= 48 && c <= 57);
    case "w": return (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    case "W": return (c) => !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95);
    case "s": return (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    case "S": return (c) => !(c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12);
    default: return null;
  }
}

const ESCAPABLE_LITERALS = new Set("^$.*+?()[]{}|/\\-".split(""));

/** Recursive-descent parser for the supported subset, producing a tiny AST. */
function parse(source) {
  let i = 0;
  const peek = () => source[i];
  const eof = () => i >= source.length;

  function error(message) {
    throw new PatternError(`${message} at offset ${i} in ${JSON.stringify(source)}`);
  }

  function parseAlt() {
    const branches = [parseConcat()];
    while (!eof() && peek() === "|") { i += 1; branches.push(parseConcat()); }
    return branches.length === 1 ? branches[0] : { type: "alt", branches };
  }

  function parseConcat() {
    const parts = [];
    while (!eof() && peek() !== "|" && peek() !== ")") parts.push(parseRepeat());
    return parts.length === 1 ? parts[0] : { type: "concat", parts };
  }

  function parseRepeat() {
    const atom = parseAtom();
    if (eof()) return atom;
    const c = peek();
    if (c === "*") { i += 1; return { type: "repeat", child: atom, min: 0, max: Infinity }; }
    if (c === "+") { i += 1; return { type: "repeat", child: atom, min: 1, max: Infinity }; }
    if (c === "?") { i += 1; return { type: "repeat", child: atom, min: 0, max: 1 }; }
    if (c === "{") {
      const match = /^\{(\d{1,3})(,(\d{1,3})?)?\}/.exec(source.slice(i));
      if (!match) error("'{' not followed by a supported repeat count");
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === undefined ? Infinity : Number(match[3]);
      if (min > MAX_REPEAT || (Number.isFinite(max) && max > MAX_REPEAT)) {
        error(`repeat count above ${MAX_REPEAT} is not accepted, to keep the compiled machine bounded`);
      }
      if (max < min) error("repeat maximum is smaller than its minimum");
      i += match[0].length;
      return { type: "repeat", child: atom, min, max };
    }
    return atom;
  }

  function parseAtom() {
    if (eof()) error("expected something to match, found the end of the pattern");
    const c = peek();
    if (c === "(") {
      i += 1;
      if (peek() === "?") error("'(?' — grouping variants (non-capturing, lookaround) are not supported");
      const inner = parseAlt();
      if (peek() !== ")") error("unmatched '('");
      i += 1;
      return inner;
    }
    if (c === ".") { i += 1; return { type: "char", test: () => true }; }
    if (c === "[") return parseClass();
    if (c === "\\") return parseEscape();
    if ("^$*+?)|{}".includes(c)) error(`'${c}' is not valid here`);
    i += 1;
    return { type: "char", test: (code) => code === c.charCodeAt(0) };
  }

  function parseEscape() {
    i += 1; // consume backslash
    if (eof()) error("dangling '\\' at the end of the pattern");
    const c = source[i];
    const predicate = classPredicate(c);
    if (predicate) { i += 1; return { type: "char", test: predicate }; }
    if (/[0-9]/.test(c)) error("backreferences ('\\1' and friends) are not supported");
    if (c === "b" || c === "B") error("word-boundary escapes ('\\b', '\\B') are not supported");
    if (!ESCAPABLE_LITERALS.has(c)) error(`'\\${c}' is not a recognised escape`);
    i += 1;
    return { type: "char", test: (code) => code === c.charCodeAt(0) };
  }

  function parseClassMember() {
    if (peek() === "\\") {
      i += 1;
      const c = source[i];
      const predicate = classPredicate(c);
      if (predicate) { i += 1; return { predicate }; }
      if (!ESCAPABLE_LITERALS.has(c)) error(`'\\${c}' is not a recognised escape inside [ ]`);
      i += 1;
      return { code: c.charCodeAt(0) };
    }
    const code = source.charCodeAt(i);
    i += 1;
    return { code };
  }

  function parseClass() {
    i += 1; // consume '['
    let negate = false;
    if (peek() === "^") { negate = true; i += 1; }
    const members = [];
    if (eof()) error("unmatched '['");
    while (peek() !== "]") {
      if (eof()) error("unmatched '['");
      const first = parseClassMember();
      if (first.predicate) { members.push(first.predicate); continue; }
      if (peek() === "-" && source[i + 1] !== "]" && !eof()) {
        i += 1; // consume '-'
        const second = parseClassMember();
        if (second.predicate) error("a class range cannot end at an escape class like \\d");
        const lo = first.code, hi = second.code;
        if (hi < lo) error("a class range is written smallest-first, like a-z");
        members.push((code) => code >= lo && code <= hi);
        continue;
      }
      const code = first.code;
      members.push((code2) => code2 === code);
    }
    i += 1; // consume ']'
    const test = (code) => members.some((m) => m(code));
    return { type: "char", test: negate ? (code) => !test(code) : test };
  }

  const ast = parseAlt();
  if (!eof()) error("unexpected trailing characters");
  return ast;
}

/** Thompson's construction: AST → a flat list of instructions, matched by
 * `run()` below without ever backtracking. */
function compile(ast) {
  const prog = [];
  const emit = (instr) => {
    if (prog.length >= MAX_INSTRUCTIONS) {
      throw new PatternError(`pattern compiles to more than ${MAX_INSTRUCTIONS} instructions`);
    }
    prog.push(instr);
    return prog.length - 1;
  };
  const patch = (dangling, target) => {
    for (const [idx, field] of dangling) prog[idx][field] = target;
  };

  function node(n) {
    switch (n.type) {
      case "char": {
        const idx = emit({ op: "char", test: n.test, next: -1 });
        return { start: idx, dangling: [[idx, "next"]] };
      }
      case "concat": {
        if (n.parts.length === 0) {
          const idx = emit({ op: "jmp", next: -1 });
          return { start: idx, dangling: [[idx, "next"]] };
        }
        let start = null, prev = null;
        for (const part of n.parts) {
          const c = node(part);
          if (start === null) start = c.start; else patch(prev, c.start);
          prev = c.dangling;
        }
        return { start, dangling: prev };
      }
      case "alt": {
        function altFrom(list) {
          if (list.length === 1) return node(list[0]);
          const first = node(list[0]);
          const split = emit({ op: "split", a: first.start, b: -1 });
          const rest = altFrom(list.slice(1));
          prog[split].b = rest.start;
          return { start: split, dangling: [...first.dangling, ...rest.dangling] };
        }
        return altFrom(n.branches);
      }
      case "repeat": {
        // Bounded repetition is unrolled rather than counted at match time —
        // `min` mandatory copies, then `max - min` optional ones, or one
        // `*`-style loop when `max` is unbounded. The AST node is reused, not
        // mutated, so compiling it more than once is safe.
        const copies = [];
        for (let k = 0; k < n.min; k += 1) copies.push(n.child);
        let start = null, prev = null;
        for (const child of copies) {
          const c = node(child);
          if (start === null) start = c.start; else patch(prev, c.start);
          prev = c.dangling;
        }
        let tail;
        if (n.max === Infinity) {
          // The `*`-style loop after the mandatory copies: `a` re-enters the
          // body, `b` leaves. The body's own dangling ends feed back into the
          // split, exactly like a `while` that re-checks before each pass.
          const split = emit({ op: "split", a: -1, b: -1 });
          const body = node(n.child);
          prog[split].a = body.start;
          patch(body.dangling, split);
          tail = { start: split, dangling: [[split, "b"]] };
        } else {
          // The `max - min` optional copies, built from the inside out: each
          // one either runs and falls into the next optional copy, or is
          // skipped straight to the end. Recursion threads that "end" through
          // naturally — the same `patch()` used everywhere else, one layer at
          // a time — rather than an iterative rebuild that has to fake it.
          const optionalChain = (remaining) => {
            if (remaining === 0) {
              const idx = emit({ op: "jmp", next: -1 });
              return { start: idx, dangling: [[idx, "next"]] };
            }
            const split = emit({ op: "split", a: -1, b: -1 });
            const body = node(n.child);
            prog[split].a = body.start;
            const nested = optionalChain(remaining - 1);
            patch(body.dangling, nested.start);
            return { start: split, dangling: [[split, "b"], ...nested.dangling] };
          };
          tail = optionalChain(n.max - n.min);
        }
        if (start === null) { start = tail.start; } else { patch(prev, tail.start); }
        return { start, dangling: tail.dangling };
      }
      default:
        throw new PatternError(`internal: unknown AST node ${n.type}`);
    }
  }

  const top = node(ast);
  const matchIdx = emit({ op: "match" });
  patch(top.dangling, matchIdx);
  return { prog, start: top.start };
}

/**
 * Every live NFA state at once, one character at a time — Pike's VM without
 * the capture groups this file has no use for. `visited` collapses duplicate
 * states reached by different epsilon paths, which is what keeps this a
 * single pass over the input rather than a tree of possibilities: the set of
 * live states can only grow to the size of the program, never beyond it.
 */
function run(machine, input) {
  const { prog, start } = machine;
  function addState(list, visited, idx) {
    if (visited.has(idx)) return;
    visited.add(idx);
    const instr = prog[idx];
    if (instr.op === "jmp") { addState(list, visited, instr.next); return; }
    if (instr.op === "split") { addState(list, visited, instr.a); addState(list, visited, instr.b); return; }
    list.push(idx);
  }
  let visited = new Set();
  let current = [];
  addState(current, visited, start);
  for (let pos = 0; pos < input.length; pos += 1) {
    const code = input.charCodeAt(pos);
    const nextVisited = new Set();
    const next = [];
    for (const idx of current) {
      const instr = prog[idx];
      if (instr.op === "char" && instr.test(code)) addState(next, nextVisited, instr.next);
    }
    current = next;
    visited = nextVisited;
    if (current.length === 0) return false;
  }
  return current.some((idx) => prog[idx].op === "match");
}

/**
 * Compile a manifest's `pattern` into something with a `.test(string)`
 * method, so it drops into `checkValue()` in `validate.mjs` exactly the way
 * a hand-written `RegExp` from `model.mjs` already does — the caller cannot
 * tell the two apart, which is the point: the interpreter's output has to be
 * a value `validate.mjs`'s existing code already knows how to use.
 *
 * Throws `PatternError` for anything outside the supported subset, or not
 * anchored the way W41 requires. The caller turns that into a named,
 * reported rejection rather than a crash — see `contentModel.mjs`.
 */
export function compileSafePattern(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new PatternError("pattern must be a non-empty string");
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!source.startsWith("^") || !source.endsWith("$")) {
    throw new PatternError("pattern must be anchored with '^' … '$' — the whole value, not a search");
  }
  const body = source.slice(1, -1);
  const ast = parse(body);
  const machine = compile(ast);
  return { source, test: (value) => run(machine, value) };
}

export { PatternError };
