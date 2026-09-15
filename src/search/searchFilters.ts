/**
 * Shared search filter utilities.
 *
 * Provides a single `matchesSearchFilter` function used by recent-note
 * filtering, lexical browse/search, and any other path where documents
 * need to be tested against a `SearchFilter`.
 */

import { matchesPathPrefix, normalizeVaultPath } from "../utils/pathUtils";
import type { SearchFilter } from "../vectorstore/types";

// ---------------------------------------------------------------------------
// Compiled filter predicate
// ---------------------------------------------------------------------------

/**
 * Pre-compiled representation of a `SearchFilter` for efficient repeated use.
 *
 * When a filter contains many path prefixes (e.g. from a complex view that
 * resolved to individual file paths), a `Set` is built for O(1) exact-path
 * lookups.  Short prefix lists (<= EXACT_SET_THRESHOLD) skip this step and
 * use the original linear scan, which handles folder-prefix matching.
 */
export interface CompiledFilter {
	readonly filter: SearchFilter;
	/** Fast exact-path lookup built when pathPrefixes exceeds the threshold. */
	readonly exactPathSet: ReadonlySet<string> | null;
}

/** Above this count, build an exact-path Set alongside the prefix list. */
const EXACT_SET_THRESHOLD = 20;

export function compileFilter(filter: SearchFilter): CompiledFilter {
	const prefixes = filter.pathPrefixes;
	const exactPathSet =
		prefixes && prefixes.length > EXACT_SET_THRESHOLD ? new Set(prefixes.map(normalizeVaultPath)) : null;
	return { filter, exactPathSet };
}

// ---------------------------------------------------------------------------
// Core filter predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a document at `path` with `docTags` satisfies every
 * constraint in `filter`.
 *
 * • Path prefixes are combined with OR (match any).
 * • Tags default to OR (match any) unless `filter.requireAllTags` is true.
 *
 * Pass a `CompiledFilter` (from `compileFilter`) when calling inside a loop
 * over many documents — it avoids rebuilding the exact-path Set on every call.
 */
/**
 * Path-only half of {@link matchesSearchFilter}, for callers that must narrow a
 * candidate set *before* they have file metadata to read tags from.
 *
 * Deliberately permissive: a filter that also constrains tags returns `true`
 * here for anything whose path qualifies, leaving the authoritative tag check to
 * `matchesSearchFilter` once the cache is available. Being permissive costs a
 * few extra candidates; being strict would silently drop real matches.
 */
export function matchesPathFilter(path: string, filter?: SearchFilter | CompiledFilter): boolean {
	if (!filter) return true;
	const compiled: CompiledFilter | null = "exactPathSet" in filter ? filter : null;
	const sf: SearchFilter = compiled ? compiled.filter : (filter as SearchFilter);

	if (!sf.pathPrefixes?.length) return true;

	if (compiled?.exactPathSet) {
		return compiled.exactPathSet.has(normalizeVaultPath(path));
	}
	return sf.pathPrefixes.some((prefix) => matchesPathPrefix(path, prefix));
}

export function matchesSearchFilter(path: string, docTags: string[], filter?: SearchFilter | CompiledFilter): boolean {
	if (!filter) {
		return true;
	}

	// Unwrap CompiledFilter if provided
	const compiled: CompiledFilter | null = "exactPathSet" in filter ? filter : null;
	const sf: SearchFilter = compiled ? compiled.filter : (filter as SearchFilter);

	if (sf.pathPrefixes?.length) {
		const normalizedPath = normalizeVaultPath(path);
		// O(1) exact-path check when the set is pre-built
		if (compiled?.exactPathSet) {
			if (!compiled.exactPathSet.has(normalizedPath)) {
				return false;
			}
		} else {
			const matchesPath = sf.pathPrefixes.some((prefix) => matchesPathPrefix(path, prefix));
			if (!matchesPath) {
				return false;
			}
		}
	}

	if (sf.tags?.length) {
		const normalizedFilterTags = sf.tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
		const normalizedDocTags = docTags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
		const matchesTag = (filterTag: string) =>
			normalizedDocTags.some((docTag) => docTag === filterTag || docTag.startsWith(`${filterTag}/`));

		if (sf.requireAllTags) {
			return normalizedFilterTags.every(matchesTag);
		}

		return normalizedFilterTags.some(matchesTag);
	}

	return true;
}
