import { Logger } from "../../utils/logging";

/**
 * Escapes a string so it can be embedded literally inside a RegExp.
 */
export function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface GrepMatcher {
	/** Test whether a single line/string matches the needle. */
	test(text: string): boolean;
	/**
	 * A fresh global RegExp for replace operations (`String.prototype.replace`).
	 * For literal needles the pattern is escaped; back-references in the
	 * replacement string only apply when the caller passed a real regex.
	 */
	globalRegex(): RegExp;
	/**
	 * A fresh non-global RegExp for single (first-match) replace operations.
	 * Shares the matcher's compiled source/flags so a single-match replace can
	 * never diverge from the `count`/uniqueness gate that authorized it.
	 */
	singleRegex(): RegExp;
	/** Count non-overlapping occurrences of the needle in `text`. */
	count(text: string): number;
	/**
	 * Whether the compiled needle can match the empty string (e.g. `x*`, `a?`).
	 * Such patterns make find-and-replace nonsensical (they "match" at every
	 * position), so callers should reject them rather than count/replace.
	 *
	 * NOTE: this is a *structural* signal (does the pattern match `""`?). It does
	 * NOT catch zero-width patterns that only match at a position inside real
	 * text — `\b`, `(?=x)`, `^`, `$` all have `matchesEmpty === false` for some
	 * flag combinations yet still match *zero characters*, so replacing them
	 * inserts the replacement at every boundary. Use `hasZeroWidthMatch(text)` on
	 * the actual content to gate replace operations; `matchesEmpty` remains only
	 * as the fast structural pre-check that keeps `count` from inflating.
	 */
	readonly matchesEmpty: boolean;
	/**
	 * Whether running this matcher against `text` produces at least one
	 * **zero-length** match — a match that consumes no characters (`\b`, `(?=x)`,
	 * `^`, `$`, `x*`, `a?`, …). Such a match makes find-and-replace nonsensical:
	 * `String.prototype.replace` would insert the replacement at that position
	 * without removing anything, scattering it across every boundary. This is the
	 * exact, content-aware guard that `matchesEmpty` (a structural `""` test)
	 * cannot provide — `\bworld` and `(?=world)world` correctly return `false`
	 * (they consume `world`), while a bare `\b` returns `true`.
	 *
	 * Literal needles never match zero-width (an escaped literal always consumes
	 * its characters, and an empty literal is already rejected upstream), so this
	 * is always `false` for them.
	 */
	hasZeroWidthMatch(text: string): boolean;
	/**
	 * Longest input `test`/`count` will run this matcher against. For a regex
	 * matcher this is the ReDoS backtracking bound (`MAX_REGEX_INPUT_LENGTH`);
	 * for a literal needle it is `Infinity` (literals cannot backtrack). Callers
	 * that operate on whole-note content should check `text.length` against this
	 * and surface a clear "input too large" error instead of running the regex —
	 * `test`/`count` return `false`/`0` for over-length input as a safety
	 * backstop, but that is indistinguishable from a genuine non-match, so the
	 * caller-side check is what keeps the failure visible.
	 */
	readonly maxInputLength: number;
}

export type BuildMatcherResult = { ok: true; matcher: GrepMatcher } | { ok: false; error: string };

/**
 * Longest line `grep_notes` will run a user-supplied regex against. It scans
 * every vault file line-by-line synchronously on the UI thread, so a
 * pathological line length would turn even a screened regex into a visible
 * freeze (backtracking cost scales super-linearly with input length). The
 * caller skips lines longer than this and reports how many were skipped, so the
 * bound is a visible safety limit rather than a silent wrong answer.
 *
 * This is a `grep_notes` line-scan concern only — it is NOT applied inside the
 * matcher. `manage_notes` runs `count`/replace against whole-note content
 * (which routinely exceeds this), and capping there silently dropped valid
 * matches. ReDoS protection for those paths comes from `screenRegexForRedos`.
 */
export const MAX_SCANNED_LINE_LENGTH = 5000;

/**
 * Hard ceiling on the input length a *regex* matcher will run against, enforced
 * inside `buildGrepMatcher` so every caller inherits it (no caller can forget).
 *
 * The ReDoS structural screen (`screenRegexForRedos`) is provably incomplete —
 * regex-safety screening is undecidable — so a pattern with catastrophic
 * backtracking can slip through. Without a length bound, such a pattern run
 * against whole-note content (`manage_notes` does exactly this) backtracks
 * super-linearly and freezes the single UI thread. This ceiling caps the worst
 * case regardless of what the screen missed.
 *
 * Chosen large enough that every realistic note passes untouched (a 200k-char
 * note is ~40k words), but small enough that even an exponential pattern can't
 * run long. Literal needles are exempt (they use `String.includes` / an escaped
 * literal regex and cannot backtrack) — their `maxInputLength` is `Infinity`.
 */
export const MAX_REGEX_INPUT_LENGTH = 200_000;

/**
 * Reject regex patterns whose structure is prone to catastrophic backtracking
 * (ReDoS). A user- or agent-supplied pattern is compiled and then `.test()`ed
 * line-by-line across the whole vault on the only UI thread with no timeout, so
 * a pattern like `(a+)+$` against a long non-matching line would hard-lock
 * Obsidian.
 *
 * Detecting ReDoS in general is undecidable and pure syntactic screening can
 * never be exhaustive — so this is defense-in-depth, paired with the input-size
 * cap (`MAX_SCANNED_LINE_LENGTH`) that bounds the worst case even for a pattern
 * that slips through. We reject the well-known dangerous shapes: a quantified
 * group whose body is itself quantified (`(a+)+`), quantified alternations with
 * overlapping branches (`(a|a)*`), large bounded repetitions (`a{5000,}`), and
 * bounded repetition applied to a quantified group (`(a+){10,}`). Returns an
 * error message if the pattern looks unsafe, or `null` if it passes.
 */
const MAX_SAFE_QUANTIFIER_BOUND = 1000;

/**
 * Rewrite a regex source so the ReDoS structural screen only sees genuine
 * structure. Two constructs are collapsed to inert letter placeholders in a
 * single left-to-right pass (a regex-based replace can't do this correctly
 * because `]` at class start is literal and escapes may appear inside a class):
 *
 *  - An escaped shorthand *class* `\d \w \s \D \W \S \p \P` → `E` (a broad atom
 *    that can overlap its neighbours).
 *  - Any other escaped char `\X` (`\)`, `\.`, `\{`, …) → `L` (a narrow literal
 *    atom — it matches exactly one specific character, so it does NOT overlap a
 *    different literal). Keeping this distinct from `E` is what stops `\(a+\)+`
 *    (literal parens around `a+`) from being misread as adjacent overlapping
 *    quantifiers.
 *  - A character class `[...]` → `C` (the whole class is one broad atom; parens,
 *    pipes and braces inside it are literal, not structure).
 *
 * Placeholders are letters, which carry no regex meaning, so quantifiers/groups
 * around them read exactly as they would around any literal character.
 */
const ESCAPED_CLASS_CHARS = new Set(["d", "D", "w", "W", "s", "S", "p", "P"]);

function neutralizeLiterals(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "\\") {
			// Escaped shorthand class (\d,\w,\s,…) is a broad atom (`E`); any other
			// escaped char (or a trailing lone backslash) is one narrow literal (`L`).
			const next = pattern[i + 1];
			out += next !== undefined && ESCAPED_CLASS_CHARS.has(next) ? "E" : "L";
			i += 2;
			continue;
		}
		if (ch === "[") {
			// Consume a full character class. A `]` immediately after `[` or `[^`
			// is a literal member, not the terminator; escapes are skipped whole.
			let j = i + 1;
			if (pattern[j] === "^") j++;
			if (pattern[j] === "]") j++; // leading literal ']'
			while (j < pattern.length && pattern[j] !== "]") {
				if (pattern[j] === "\\") j += 2;
				else j++;
			}
			// j is at the closing ']' (or end of string if unterminated).
			out += "C";
			i = j + 1;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Detect two unbounded quantifiers (`*`/`+`) applied to *adjacent, overlapping*
 * atoms in a neutralized pattern — e.g. `a+a+`, `.+.+`, `\d+\d+` (→ `E+E+`),
 * `[a-z]+[a-z]+` (→ `C+C+`). This is the sequential-quantifier ReDoS shape the
 * nested-quantifier check misses because there is no enclosing group.
 *
 * "Adjacent" means the second quantified atom starts exactly where the first
 * ended (no separator between them). "Overlapping" means the two atoms can match
 * the same characters — approximated as: the atoms are identical, OR either is a
 * broad atom (`.`, a character class `C`, or an escaped shorthand class `\d`/`\w`
 * → `E`). A narrow literal placeholder (`L`, from an escaped literal like `\)`)
 * only overlaps an identical `L`. Because neutralization collapses all escaped
 * shorthand classes to `E`, a safe disjoint pair like `\w+\s+` (→ `E+E+`) is
 * conservatively rejected too; that is an accepted false-positive — such a
 * pattern is trivially rewritten (`\w+\s`), and erring toward rejection keeps the
 * UI thread safe.
 *
 * Distinct literals with quantifiers (`a+b+`), a required separator (`\d+-\d+`),
 * or escaped literal parens around a quantifier (`\(a+\)+` → `La+L+`) are NOT
 * flagged — they cannot backtrack catastrophically.
 */
function hasAdjacentOverlappingQuantifiers(neutralized: string): boolean {
	// Match each `<atom><*|+>`; an atom is a single ordinary char, `.`, or a
	// neutralization placeholder (`C` = char class, `E` = escaped class, `L` =
	// escaped literal).
	const atomQuantifier = /([A-Za-z0-9._]|C|E|L)([*+])/g;
	// Broad atoms overlap (almost) anything; a narrow literal `L` overlaps only an
	// identical `L`, handled by the `atom === prevAtom` check.
	const BROAD = new Set([".", "C", "E"]);
	let match: RegExpExecArray | null;
	let prevAtom: string | null = null;
	let prevEnd = -1;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
	while ((match = atomQuantifier.exec(neutralized))) {
		const atom = match[1];
		const start = match.index;
		if (prevAtom !== null && start === prevEnd) {
			// The two quantified atoms are directly adjacent (no separator).
			if (atom === prevAtom || BROAD.has(atom) || BROAD.has(prevAtom)) {
				return true;
			}
		}
		prevAtom = atom;
		prevEnd = atomQuantifier.lastIndex;
	}
	return false;
}

/**
 * Index of the `)` that closes the group whose `(` is at `open`, tracking paren
 * depth so nested groups are handled correctly. Returns -1 if unbalanced.
 * Operates on a *neutralized* pattern, so every `(`/`)` is real group structure
 * (literal parens are already `L`, class contents are `C`).
 */
function matchingParen(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Strip a leading group prefix — `?:`, `?=`, `?!`, `?<name>`, `?<=`, `?<!`. */
function stripGroupPrefix(body: string): string {
	return body.replace(/^\?[:=!]|^\?<[=!]|^\?<[^>]*>/, "");
}

/**
 * Whether a quantified group's *body* is "unfenced" — i.e. it reduces to a
 * single unbounded-quantified unit (`a+`, `(a+)`, `((a+))`, …) with nothing else
 * at the top level to fence a repetition. This is the property that makes an
 * outer unbounded quantifier catastrophic: `(a+)+` and `((a+))+` explode, but
 * `(a+b)+` (fenced by `b`), `(a(b)c)+` (no top-level quantifier), and
 * `(?:\(a+\))+` → `(?:La+L)+` (fenced by literal `L`) do not.
 *
 * Verified empirically: `((a+))+$` is exponential (>1s at ~24 chars) while every
 * fenced form stays linear. Recurses through redundant group wrappers so
 * `(((a+)))+` is still caught. Operates on a neutralized pattern.
 */
function bodyIsUnfenced(body: string): boolean {
	const tokens = splitTopLevel(body);
	// More than one top-level token means something fences the repetition (a
	// sibling atom, a separator, an alternation) — not the catastrophic shape.
	if (tokens.length !== 1) return false;
	const t = tokens[0];
	if (t.kind === "atom") return t.unbounded;
	if (t.kind === "group") {
		// A single nested group: dangerous if the group's own unbounded quantifier
		// wraps an unfenced body, or (an unquantified wrapper) its body is unfenced.
		if (t.unbounded) return bodyIsUnfenced(t.inner);
		if (!t.quantified) return bodyIsUnfenced(t.inner);
	}
	return false;
}

type TopLevelToken =
	| { kind: "atom"; quantified: boolean; unbounded: boolean }
	| { kind: "group"; quantified: boolean; unbounded: boolean; inner: string }
	| { kind: "alt" };

/**
 * Split a neutralized regex body into its top-level tokens (depth 0 only):
 * ordinary atoms, groups (with their inner text), and `|` alternation markers.
 * Each atom/group carries whether it is quantified and, if so, whether by an
 * unbounded quantifier (`*`/`+`, not `?` and not a bounded `{n,m}`).
 */
function splitTopLevel(body: string): TopLevelToken[] {
	const tokens: TopLevelToken[] = [];
	let i = 0;
	while (i < body.length) {
		const c = body[i];
		if (c === "|") {
			tokens.push({ kind: "alt" });
			i++;
			continue;
		}
		if (c === "(") {
			const close = matchingParen(body, i);
			if (close === -1) {
				i++;
				continue;
			}
			const inner = stripGroupPrefix(body.slice(i + 1, close));
			const after = body[close + 1];
			if (after === "*" || after === "+") {
				tokens.push({ kind: "group", quantified: true, unbounded: true, inner });
				i = close + 2;
			} else if (after === "?") {
				tokens.push({ kind: "group", quantified: true, unbounded: false, inner });
				i = close + 2;
			} else if (after === "{") {
				const end = body.indexOf("}", close);
				tokens.push({ kind: "group", quantified: true, unbounded: false, inner });
				i = end === -1 ? close + 1 : end + 1;
			} else {
				tokens.push({ kind: "group", quantified: false, unbounded: false, inner });
				i = close + 1;
			}
			continue;
		}
		// Ordinary atom (one neutralized char). Read its trailing quantifier.
		const after = body[i + 1];
		if (after === "*" || after === "+") {
			tokens.push({ kind: "atom", quantified: true, unbounded: true });
			i += 2;
		} else if (after === "?") {
			tokens.push({ kind: "atom", quantified: true, unbounded: false });
			i += 2;
		} else if (after === "{") {
			const end = body.indexOf("}", i);
			tokens.push({ kind: "atom", quantified: true, unbounded: false });
			i = end === -1 ? i + 1 : end + 1;
		} else {
			tokens.push({ kind: "atom", quantified: false, unbounded: false });
			i++;
		}
	}
	return tokens;
}

/**
 * Depth-aware scan for the two catastrophic quantified-group shapes that a flat
 * `[^)]*` regex cannot see because it can't balance parens:
 *
 *  - An unbounded-quantified group with an unfenced body: `(a+)+`, `((a+))+`,
 *    `(C+)+` (from `([^)]+)+`). The old `\([^)]*[*+][^)]*\)[*+]` regex stopped at
 *    the first inner `)`, so `((a+))+` slipped through.
 *  - A quantified group containing a top-level alternation: `(a|a)*`, `(a|b)+`.
 *
 * Returns a reason string if the neutralized pattern contains either shape.
 */
function findDangerousQuantifiedGroup(neutralized: string): string | null {
	for (let i = 0; i < neutralized.length; i++) {
		if (neutralized[i] !== "(") continue;
		const close = matchingParen(neutralized, i);
		if (close === -1) break;
		const after = neutralized[close + 1];
		if (after !== "*" && after !== "+") continue; // only unbounded group quantifiers here
		const body = stripGroupPrefix(neutralized.slice(i + 1, close));
		if (bodyIsUnfenced(body)) {
			return "quantifier applied to a group whose body is itself unbounded (e.g. `(a+)+`, `((a+))+`)";
		}
		// A quantified group with a top-level alternation backtracks badly when the
		// branches overlap: `(a|a)*`, `(\w|\d)+`.
		if (splitTopLevel(body).some((t) => t.kind === "alt")) {
			return "quantifier applied to an alternation group (e.g. `(a|a)*`) — prone to catastrophic backtracking";
		}
	}
	return null;
}

function screenRegexForRedos(pattern: string): string | null {
	// The structural checks below look for real regex *structure* — group parens,
	// quantifiers, braces, alternation. Two things masquerade as structure but are
	// not, and are neutralized first (see `neutralizeLiterals`) so the screen
	// neither misses real dangers nor rejects safe patterns:
	//
	//  1. Escaped metacharacters (`\)`, `\(`, `\{`, `\|`) are literals → `L`/`E`,
	//     so `\(a+\)+` → `La+L+` (not a group) is correctly safe.
	//  2. Character-class contents (`[...]`) are a single atom → `C`, so
	//     `([^)]+)+$` → `(C+)+$` presents its real `(…+)+` shape.
	//
	// After neutralization every `(`/`)` is genuine group structure, which lets
	// the depth-aware `findDangerousQuantifiedGroup` scan balance parens correctly
	// — catching nested shapes like `((a+))+` that a flat `[^)]*` regex misses.
	const stripped = neutralizeLiterals(pattern);

	// Catastrophic quantified-group shapes (nested/unfenced body, or quantified
	// alternation), detected with real paren balancing rather than a flat regex.
	const dangerousGroup = findDangerousQuantifiedGroup(stripped);
	if (dangerousGroup) {
		return dangerousGroup;
	}

	// A group followed by a bounded repetition, e.g. (a+){10,} or (ab){50,100} —
	const boundedQuantifiedGroup = /\)\s*\{\d+(?:,\d*)?\}/;
	if (boundedQuantifiedGroup.test(stripped)) {
		return "bounded repetition applied to a group (e.g. `(a+){10,}`) — prone to catastrophic backtracking";
	}

	// Two unbounded quantifiers applied back-to-back to overlapping atoms, e.g.
	// `a+a+`, `.+.+`, `\d+\d+`, `\w+\w+`. When adjacent greedy quantifiers can both
	// consume the same characters, the number of ways to split the input explodes
	// (super-linear/exponential) — the classic `a+a+a+X`-against-`"aaaa…"` freeze,
	// which is NOT caught by the nested-quantifier check (there is no group). This
	// is distinct from safe adjacency like `a+b+` (disjoint literals) or `\d+-\d+`
	// (a required separator between them), which are not flagged.
	if (hasAdjacentOverlappingQuantifiers(stripped)) {
		return "adjacent unbounded quantifiers on overlapping atoms (e.g. `a+a+`, `\\d+\\d+`) — prone to catastrophic backtracking";
	}

	// A single large bounded repetition, e.g. a{5000} / .{2000,} — even without
	// nesting, a huge explicit bound makes each scan O(bound). Reject bounds
	// above a conservative ceiling.
	for (const m of stripped.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
		const lower = Number(m[1]);
		const upper = m[2] === undefined ? lower : m[2] === "" ? Number.POSITIVE_INFINITY : Number(m[2]);
		if (lower > MAX_SAFE_QUANTIFIER_BOUND || upper > MAX_SAFE_QUANTIFIER_BOUND) {
			return `repetition bound greater than ${MAX_SAFE_QUANTIFIER_BOUND} (e.g. \`a{${m[1]}}\`) — too expensive to scan`;
		}
	}

	return null;
}

/**
 * Build a shared literal/regex matcher used by both `grep_notes` (line-level
 * search) and the `manage_notes` replace paths (find-and-replace). Compiling in
 * one place keeps flag handling and invalid-regex reporting consistent.
 *
 * - Literal needles are matched with `String.includes` for `test`, and a
 *   RegExp built from an escaped pattern for `globalRegex`/`count` so replace
 *   can operate on all occurrences.
 * - Regex needles are validated here; an invalid pattern returns an error
 *   string rather than throwing.
 */
export function buildGrepMatcher(pattern: string, isRegex: boolean, caseSensitive: boolean): BuildMatcherResult {
	if (isRegex) {
		const redosReason = screenRegexForRedos(pattern);
		if (redosReason) {
			Logger.debug("[grepMatcher] Rejected potentially catastrophic regex:", pattern, redosReason);
			return {
				ok: false,
				error: `Error: Regular expression "${pattern}" was rejected: ${redosReason}. Simplify the pattern.`,
			};
		}

		let source: RegExp;
		try {
			source = new RegExp(pattern, caseSensitive ? "" : "i");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Logger.debug("[grepMatcher] Invalid regex pattern:", pattern, message);
			return { ok: false, error: `Error: Invalid regular expression "${pattern}": ${message}` };
		}

		const globalFlags = `g${caseSensitive ? "" : "i"}`;
		const singleFlags = source.flags.replace("g", "");
		// A pattern matches empty if it can succeed against "". Such patterns make
		// find-and-replace meaningless (they match at every position).
		const matchesEmpty = new RegExp(source.source, singleFlags).test("");
		return {
			ok: true,
			matcher: {
				// A non-global clone avoids the stateful `lastIndex` trap when reusing `.test()` in a loop.
				// The length guard is a backstop for patterns the ReDoS screen missed:
				// refusing to run against over-length input caps worst-case backtracking.
				// Callers should check `maxInputLength` and surface a clear error;
				// returning false here is only a last-resort safety net.
				test: (text: string) =>
					text.length <= MAX_REGEX_INPUT_LENGTH && new RegExp(source.source, singleFlags).test(text),
				globalRegex: () => new RegExp(source.source, globalFlags),
				singleRegex: () => new RegExp(source.source, singleFlags),
				count: (text: string) => {
					// Count non-overlapping matches. `matchAll` advances past
					// zero-length matches correctly (unlike `String.match(/g/)`,
					// which for an empty-matchable pattern returns one entry per
					// character and inflates the count).
					if (matchesEmpty) return 0;
					if (text.length > MAX_REGEX_INPUT_LENGTH) return 0;
					let n = 0;
					const matches = text.matchAll(new RegExp(source.source, globalFlags));
					while (!matches.next().done) n++;
					return n;
				},
				hasZeroWidthMatch: (text: string) => {
					// A zero-length match means replace would insert without consuming
					// — nonsensical. Detected against the actual content because it is
					// input-dependent (`\bworld` consumes text; a bare `\b` does not).
					// The length backstop mirrors count/test: over-ceiling input is not
					// scanned, and reporting "no zero-width match" there is safe because
					// the caller has already refused the over-length note.
					if (matchesEmpty) return true;
					if (text.length > MAX_REGEX_INPUT_LENGTH) return false;
					const g = new RegExp(source.source, globalFlags);
					let m: RegExpExecArray | null;
					// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
					while ((m = g.exec(text)) !== null) {
						if (m[0].length === 0) return true;
						// Guard against an infinite loop should a non-empty match ever
						// report length 0 via flags; advance past a zero-width position.
						if (m.index === g.lastIndex) g.lastIndex++;
					}
					return false;
				},
				matchesEmpty,
				maxInputLength: MAX_REGEX_INPUT_LENGTH,
			},
		};
	}

	const escaped = escapeRegExp(pattern);
	const globalFlags = `g${caseSensitive ? "" : "i"}`;
	const singleFlags = caseSensitive ? "" : "i";
	const needle = caseSensitive ? pattern : pattern.toLowerCase();
	// A literal needle matches empty only when the pattern itself is empty.
	const matchesEmpty = pattern.length === 0;
	return {
		ok: true,
		matcher: {
			test: (text: string) => (caseSensitive ? text : text.toLowerCase()).includes(needle),
			globalRegex: () => new RegExp(escaped, globalFlags),
			singleRegex: () => new RegExp(escaped, singleFlags),
			count: (text: string) => {
				if (matchesEmpty) return 0;
				const matches = text.match(new RegExp(escaped, globalFlags));
				return matches ? matches.length : 0;
			},
			// A non-empty literal always consumes its characters; an empty literal
			// is rejected upstream. Either way a literal never matches zero-width.
			hasZeroWidthMatch: () => matchesEmpty,
			matchesEmpty,
			// A literal needle is matched by `String.includes` / an escaped-literal
			// regex with no quantifiers — it cannot backtrack, so no length bound.
			maxInputLength: Number.POSITIVE_INFINITY,
		},
	};
}
