/**
 * View filter resolution utilities.
 *
 * Resolves a `ViewFilter` tree against the vault to produce a concrete
 * set of file paths.  Dynamic leaves (folder / tag / extension)
 * re-evaluate each time so saved views stay up-to-date as the vault
 * changes.  Frozen `paths` leaves are checked for existence — any
 * stale (deleted / renamed) paths are reported separately.
 */

import { type App, TFile, getAllTags } from "obsidian";
import type { ViewFilter, ViewFilterGroup, ViewFilterLeaf } from "../types/viewFilter";
import { matchesPathPrefix, normalizeVaultPath } from "../utils/pathUtils";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedView {
	/** File paths that matched the filter */
	paths: Set<string>;
	/** Frozen paths that no longer exist in the vault */
	stalePaths: string[];
}

export type PrivacyMembershipRule =
	| { type: "folder"; value: string }
	| { type: "tag"; value: string }
	| { type: "extension"; value: string }
	| { type: "property"; value: string; values?: string[] };

export interface PrivacyMembershipDraft {
	manualPaths: string[];
	autoIncludeRules: PrivacyMembershipRule[];
	excludedPaths: string[];
}

export interface ParsedPrivacyMembershipDraft {
	draft: PrivacyMembershipDraft;
	isAdvanced: boolean;
}

export interface ResolvedPrivacyMembership extends ResolvedView {
	provenance: Map<string, string[]>;
	excludedPaths: Set<string>;
}

export function cloneViewFilter(filter: ViewFilter): ViewFilter {
	if (isLeaf(filter)) {
		return cloneViewFilterLeaf(filter);
	}

	return {
		type: filter.type,
		conditions: filter.conditions.map((condition) => cloneViewFilter(condition)),
	};
}

/**
 * Rewrite a `ViewFilter` tree to follow a vault rename, so a filter that
 * references a moved file or folder keeps meaning what the user set it up to
 * mean instead of silently going stale.
 *
 * This matters most for a *privacy* filter under `public-by-default`: there,
 * the filter lists what's private, so a stale entry means a note the user
 * marked private silently becomes readable by untrusted providers — a security
 * regression with no corresponding edit. `private-by-default` fails the other
 * way (a stale entry just drops out of what's exposed), but both directions are
 * wrong, so both leaf kinds below are rewritten unconditionally.
 *
 * - `paths` leaves: an entry equal to `oldPath` becomes `newPath`.
 * - `folder` leaves: a value equal to `oldPath` becomes `newPath`. Obsidian
 *   fires a `rename` event for every descendant folder as well as the renamed
 *   item itself (verified: renaming `A` containing `A/Sub` fires events for
 *   both `A → B` and `A/Sub → B/Sub`), so a leaf naming a nested folder gets
 *   its own exact-match event rather than needing prefix rewriting here. The
 *   prefix branch below is kept as a defensive fallback in case a caller ever
 *   invokes this with a coarser-grained rename than Obsidian itself emits.
 * - `property` leaves: values that are wikilinks (`[[Acme Corp]]`) are rewritten
 *   to the renamed note, preserving subpath and alias. Obsidian rewrites the
 *   *frontmatter* on rename, so a filter left alone would drift out of sync with
 *   the very notes it targets. Plain (non-link) values are left alone.
 * - Other leaf types (`tag`, `extension`) don't reference paths and are
 *   returned unchanged.
 *
 * Returns the original `filter` reference when nothing changed, so callers can
 * skip a write (and the resulting save/re-render) with a simple identity check.
 */
/** Strip a path's directory and extension, e.g. `Work/Acme Corp.md` → `Acme Corp`. */
function pathToLinkText(path: string): string {
	const withoutFolder = path.slice(path.lastIndexOf("/") + 1);
	return withoutFolder.replace(/\.md$/i, "");
}

/**
 * Rewrite a property-filter value that is a wikilink (`[[Acme Corp]]`) to follow a
 * rename, preserving any subpath and alias (`[[Note#Heading|Display]]`).
 *
 * Users filter on link-valued properties by typing the link exactly as it appears
 * in the frontmatter. Obsidian rewrites the *note's* frontmatter on rename, so
 * without this the vault would say `[[New Name]]` while the saved filter still
 * said `[[Old Name]]` — the rule silently stops matching, which under
 * `public-by-default` means a note the user marked private becomes readable.
 *
 * Links may be written by basename (`[[Acme Corp]]`, the common case) or by full
 * vault path (`[[Work/Acme Corp]]`); both are matched. A link carrying its own
 * alias keeps that alias, since the user's chosen display text isn't ours to change.
 * Non-link values are returned unchanged.
 */
function rewriteWikiLinkValue(value: string, normalizedOldPath: string, normalizedNewPath: string): string {
	const match = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
	if (!match) return value;

	const inner = match[1];
	const aliasSplit = inner.indexOf("|");
	const target = aliasSplit === -1 ? inner : inner.slice(0, aliasSplit);
	const alias = aliasSplit === -1 ? "" : inner.slice(aliasSplit);

	const subpathSplit = target.search(/[#^]/);
	const linkPath = subpathSplit === -1 ? target : target.slice(0, subpathSplit);
	const subpath = subpathSplit === -1 ? "" : target.slice(subpathSplit);

	const trimmedLink = linkPath.trim();
	const oldLinkText = pathToLinkText(normalizedOldPath);
	// Match either the bare basename or the full vault path, case-insensitively —
	// Obsidian resolves links case-insensitively too.
	const matchesOld =
		trimmedLink.toLowerCase() === oldLinkText.toLowerCase() ||
		trimmedLink.toLowerCase() === normalizedOldPath.toLowerCase() ||
		trimmedLink.toLowerCase() === normalizedOldPath.replace(/\.md$/i, "").toLowerCase();
	if (!matchesOld) return value;

	// Keep the reference style the user wrote: a basename link stays a basename
	// link, a full-path link stays a full-path link.
	const wroteFullPath = trimmedLink.toLowerCase() !== oldLinkText.toLowerCase();
	const replacement = wroteFullPath ? normalizedNewPath.replace(/\.md$/i, "") : pathToLinkText(normalizedNewPath);

	return `[[${replacement}${subpath}${alias}]]`;
}

export function rewriteViewFilterForRename(filter: ViewFilter, oldPath: string, newPath: string): ViewFilter {
	const normalizedOld = normalizeVaultPath(oldPath);
	const normalizedNew = normalizeVaultPath(newPath);

	if (isLeaf(filter)) {
		if (filter.type === "paths") {
			if (!filter.value.some((p) => normalizeVaultPath(p) === normalizedOld)) return filter;
			return {
				type: "paths",
				value: filter.value.map((p) => (normalizeVaultPath(p) === normalizedOld ? newPath : p)),
			};
		}

		if (filter.type === "folder") {
			const normalizedValue = normalizeVaultPath(filter.value);
			if (normalizedValue === normalizedOld) {
				return { type: "folder", value: newPath };
			}
			if (normalizedValue.startsWith(`${normalizedOld}/`)) {
				return { type: "folder", value: normalizedNew + normalizedValue.slice(normalizedOld.length) };
			}
			return filter;
		}

		if (filter.type === "property" && filter.values) {
			let changedValue = false;
			const values = filter.values.map((value) => {
				const rewritten = rewriteWikiLinkValue(value, normalizedOld, normalizedNew);
				if (rewritten !== value) changedValue = true;
				return rewritten;
			});
			return changedValue ? { type: "property", value: filter.value, values } : filter;
		}

		return filter;
	}

	let changed = false;
	const conditions = filter.conditions.map((condition) => {
		const rewritten = rewriteViewFilterForRename(condition, oldPath, newPath);
		if (rewritten !== condition) changed = true;
		return rewritten;
	});
	return changed ? { type: filter.type, conditions } : filter;
}

export function clonePrivacyMembershipDraft(draft: PrivacyMembershipDraft): PrivacyMembershipDraft {
	return {
		manualPaths: [...draft.manualPaths],
		autoIncludeRules: draft.autoIncludeRules.map((rule) => clonePrivacyMembershipRule(rule)),
		excludedPaths: [...draft.excludedPaths],
	};
}

/**
 * Recursively resolve a `ViewFilter` tree against the current vault state.
 *
 * @param app       - Obsidian `App` instance (provides vault + metadata cache)
 * @param filter    - The filter tree to resolve
 * @param universe  - Optional pre-computed universe of paths to resolve against.
 *                    When omitted, all markdown files in the vault are used.
 */
export function resolveViewFilter(app: App, filter: ViewFilter, universe?: Set<string>): ResolvedView {
	const allPaths = universe ?? getAllMarkdownPaths(app);
	return resolveNode(app, filter, allPaths);
}

export function createEmptyPrivacyFilter(): ViewFilter {
	return { type: "paths", value: [] };
}

export function compilePrivacyMembershipDraft(draft: PrivacyMembershipDraft): ViewFilter {
	const normalized = normalizePrivacyMembershipDraft(draft);
	const includeLeaves: ViewFilterLeaf[] = [];

	if (normalized.manualPaths.length > 0) {
		includeLeaves.push({ type: "paths", value: normalized.manualPaths });
	}

	for (const rule of normalized.autoIncludeRules) {
		includeLeaves.push(clonePrivacyMembershipRule(rule));
	}

	if (includeLeaves.length === 0) {
		return createEmptyPrivacyFilter();
	}

	const includeNode: ViewFilter =
		includeLeaves.length === 1 ? includeLeaves[0] : { type: "any", conditions: includeLeaves };

	if (normalized.excludedPaths.length === 0) {
		return includeNode;
	}

	return {
		type: "all",
		conditions: [includeNode, { type: "none", conditions: [{ type: "paths", value: normalized.excludedPaths }] }],
	};
}

export function buildPrivacyMembershipRulesEditorFilter(rules: PrivacyMembershipRule[]): ViewFilter {
	return {
		type: "any",
		conditions: rules.map((rule) => clonePrivacyMembershipRule(rule)),
	};
}

export function extractPrivacyMembershipRulesFilter(filter: ViewFilter): PrivacyMembershipRule[] | null {
	if (isLeaf(filter)) {
		return isPrivacyMembershipRule(filter) ? [clonePrivacyMembershipRule(filter)] : null;
	}

	if (filter.type !== "any") {
		return null;
	}

	const rules: PrivacyMembershipRule[] = [];
	for (const condition of filter.conditions) {
		if (!isLeaf(condition) || !isPrivacyMembershipRule(condition)) {
			return null;
		}
		rules.push(clonePrivacyMembershipRule(condition));
	}

	return rules;
}

export function parsePrivacyMembershipFilter(filter: ViewFilter): ParsedPrivacyMembershipDraft {
	const draft: PrivacyMembershipDraft = {
		manualPaths: [],
		autoIncludeRules: [],
		excludedPaths: [],
	};

	if (!extractSimplePrivacyMembership(filter, draft)) {
		return {
			draft: {
				manualPaths: [],
				autoIncludeRules: [],
				excludedPaths: [],
			},
			isAdvanced: true,
		};
	}

	return {
		draft: normalizePrivacyMembershipDraft(draft),
		isAdvanced: false,
	};
}

export function resolvePrivacyMembershipDraft(
	app: App,
	draft: PrivacyMembershipDraft,
	universe?: Set<string>,
): ResolvedPrivacyMembership {
	const normalized = normalizePrivacyMembershipDraft(draft);
	const resolvedPaths = new Set<string>();
	const provenance = new Map<string, string[]>();
	const stalePaths = new Set<string>();
	const allPaths = universe ?? getAllMarkdownPaths(app);

	if (normalized.manualPaths.length > 0) {
		const manual = resolveViewFilter(app, { type: "paths", value: normalized.manualPaths }, allPaths);
		mergeResolvedMembership(resolvedPaths, provenance, manual, "Manual", stalePaths);
	}

	for (const rule of normalized.autoIncludeRules) {
		const resolved = resolveViewFilter(app, rule, allPaths);
		mergeResolvedMembership(resolvedPaths, provenance, resolved, describeMembershipRule(rule), stalePaths);
	}

	const excluded =
		normalized.excludedPaths.length > 0
			? resolveViewFilter(app, { type: "paths", value: normalized.excludedPaths }, allPaths)
			: { paths: new Set<string>(), stalePaths: [] };

	for (const path of excluded.paths) {
		resolvedPaths.delete(path);
		provenance.delete(path);
	}

	for (const stalePath of excluded.stalePaths) {
		stalePaths.add(stalePath);
	}

	return {
		paths: resolvedPaths,
		stalePaths: [...stalePaths],
		provenance,
		excludedPaths: excluded.paths,
	};
}

export function matchesPrivacyMembershipDraftPath(app: App, draft: PrivacyMembershipDraft, filePath: string): boolean {
	const normalized = normalizePrivacyMembershipDraft(draft);

	if (normalized.excludedPaths.includes(filePath)) {
		return false;
	}

	if (normalized.manualPaths.includes(filePath)) {
		return true;
	}

	return normalized.autoIncludeRules.some((rule) => matchesPrivacyMembershipRulePath(app, rule, filePath));
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Build the full set of markdown file paths in the vault.
 */
export function getAllMarkdownPaths(app: App): Set<string> {
	const paths = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		paths.add(file.path);
	}
	return paths;
}

/**
 * Describe a `ViewFilter` as a short human-readable string for UI display.
 * Examples: "folder:Work", "tag:#ml", "all(folder:Work, tag:#ml)"
 */
export function describeViewFilter(filter: ViewFilter): string {
	if (isLeaf(filter)) {
		return describeLeaf(filter);
	}
	const inner = filter.conditions.map(describeViewFilter).join(", ");
	return `${filter.type}(${inner})`;
}

function normalizePrivacyMembershipDraft(draft: PrivacyMembershipDraft): PrivacyMembershipDraft {
	return {
		manualPaths: dedupeStrings(draft.manualPaths),
		autoIncludeRules: draft.autoIncludeRules.map((rule) => clonePrivacyMembershipRule(rule)),
		excludedPaths: dedupeStrings(draft.excludedPaths),
	};
}

function extractSimplePrivacyMembership(filter: ViewFilter, draft: PrivacyMembershipDraft): boolean {
	if (isLeaf(filter)) {
		return extractSimpleIncludeNode(filter, draft);
	}

	if (filter.type === "any") {
		return filter.conditions.every((condition) => extractSimpleIncludeNode(condition, draft));
	}

	if (filter.type !== "all") {
		return false;
	}

	let includeCount = 0;
	for (const condition of filter.conditions) {
		if (isSimpleExclusionNode(condition)) {
			draft.excludedPaths.push(...collectExcludedPaths(condition));
			continue;
		}

		includeCount += 1;
		if (includeCount > 1) {
			return false;
		}

		if (!extractSimpleIncludeNode(condition, draft)) {
			return false;
		}
	}

	return includeCount === 1;
}

function extractSimpleIncludeNode(filter: ViewFilter, draft: PrivacyMembershipDraft): boolean {
	if (isLeaf(filter)) {
		if (filter.type === "paths") {
			draft.manualPaths.push(...filter.value);
			return true;
		}

		if (isPrivacyMembershipRule(filter)) {
			draft.autoIncludeRules.push(clonePrivacyMembershipRule(filter));
			return true;
		}

		return false;
	}

	if (filter.type !== "any") {
		return false;
	}

	return filter.conditions.every((condition) => extractSimpleIncludeNode(condition, draft));
}

function isSimpleExclusionNode(filter: ViewFilter): filter is ViewFilterGroup {
	return (
		filter.type === "none" &&
		filter.conditions.every((condition) => isLeaf(condition) && condition.type === "paths")
	);
}

function collectExcludedPaths(filter: ViewFilterGroup): string[] {
	const paths: string[] = [];
	for (const condition of filter.conditions) {
		if (isLeaf(condition) && condition.type === "paths") {
			paths.push(...condition.value);
		}
	}
	return paths;
}

function isPrivacyMembershipRule(filter: ViewFilter): filter is PrivacyMembershipRule {
	return (
		filter.type === "folder" || filter.type === "tag" || filter.type === "extension" || filter.type === "property"
	);
}

function mergeResolvedMembership(
	resolvedPaths: Set<string>,
	provenance: Map<string, string[]>,
	resolved: ResolvedView,
	source: string,
	stalePaths: Set<string>,
): void {
	for (const path of resolved.paths) {
		resolvedPaths.add(path);
		const current = provenance.get(path) ?? [];
		if (!current.includes(source)) {
			provenance.set(path, [...current, source]);
		}
	}

	for (const stalePath of resolved.stalePaths) {
		stalePaths.add(stalePath);
	}
}

function describeMembershipRule(rule: PrivacyMembershipRule): string {
	switch (rule.type) {
		case "folder":
			return `Folder: ${rule.value}`;
		case "tag":
			return `Tag: ${rule.value.startsWith("#") ? rule.value : `#${rule.value}`}`;
		case "extension":
			return `Type: ${rule.value.startsWith(".") ? rule.value.slice(1) : rule.value}`;
		case "property":
			return rule.values && rule.values.length > 0
				? `Property: ${rule.value} = ${rule.values.join(", ")}`
				: `Property: ${rule.value}`;
	}
}

function matchesPrivacyMembershipRulePath(app: App, rule: PrivacyMembershipRule, filePath: string): boolean {
	switch (rule.type) {
		case "folder":
			// See `resolveFolder`: a blank folder is an unfinished condition and
			// must match nothing, not the whole vault.
			return rule.value.trim() ? matchesPathPrefix(filePath, rule.value) : false;
		case "extension": {
			const normalizedExt = rule.value.startsWith(".")
				? rule.value.slice(1).toLowerCase()
				: rule.value.toLowerCase();
			const fileExt = filePath.split(".").pop()?.toLowerCase() ?? "";
			return fileExt === normalizedExt;
		}
		case "tag": {
			const file = app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) return false;
			const cache = app.metadataCache.getFileCache(file);
			const fileTags = cache ? (getAllTags(cache) ?? []) : [];
			const normalizedFilter = rule.value.startsWith("#") ? rule.value : `#${rule.value}`;
			return fileTags.some((tag) => {
				const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
				return normalizedTag === normalizedFilter || normalizedTag.startsWith(`${normalizedFilter}/`);
			});
		}
		case "property":
			return matchesPropertyLeaf(app, filePath, rule.value, rule.values);
	}
}

function clonePrivacyMembershipRule(rule: PrivacyMembershipRule): PrivacyMembershipRule {
	switch (rule.type) {
		case "folder":
			return { type: "folder", value: rule.value };
		case "tag":
			return { type: "tag", value: rule.value };
		case "extension":
			return { type: "extension", value: rule.value };
		case "property":
			return { type: "property", value: rule.value, values: rule.values ? [...rule.values] : undefined };
	}
}

function cloneViewFilterLeaf(filter: ViewFilterLeaf): ViewFilterLeaf {
	switch (filter.type) {
		case "folder":
			return { type: "folder", value: filter.value };
		case "tag":
			return { type: "tag", value: filter.value };
		case "extension":
			return { type: "extension", value: filter.value };
		case "paths":
			return { type: "paths", value: [...filter.value] };
		case "property":
			return { type: "property", value: filter.value, values: filter.values ? [...filter.values] : undefined };
	}
}

function dedupeStrings(values: string[]): string[] {
	return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Internal resolution
// ---------------------------------------------------------------------------

function isLeaf(filter: ViewFilter): filter is ViewFilterLeaf {
	return (
		filter.type === "folder" ||
		filter.type === "tag" ||
		filter.type === "extension" ||
		filter.type === "paths" ||
		filter.type === "property"
	);
}

function resolveNode(app: App, filter: ViewFilter, universe: Set<string>): ResolvedView {
	if (isLeaf(filter)) {
		return resolveLeaf(app, filter, universe);
	}
	return resolveGroup(app, filter, universe);
}

// ── Leaf resolution ─────────────────────────────────────────────────────

function resolveLeaf(app: App, leaf: ViewFilterLeaf, universe: Set<string>): ResolvedView {
	switch (leaf.type) {
		case "folder":
			return resolveFolder(leaf.value, universe);
		case "tag":
			return resolveTag(app, leaf.value, universe);
		case "extension":
			return resolveExtension(leaf.value, universe);
		case "paths":
			return resolvePaths(app, leaf.value);
		case "property":
			return resolveProperty(app, leaf.value, leaf.values, universe);
	}
}

function resolveFolder(folder: string, universe: Set<string>): ResolvedView {
	// An empty/whitespace folder value is an unfinished condition, not "match
	// everything". `matchesPathPrefix` treats a blank prefix as matching every
	// path, which is right for search scoping but wrong here: while the user is
	// still typing a folder name, a half-written filter would briefly select the
	// entire vault — and for the privacy filter that means exposing every note.
	// Match nothing instead, consistent with the extension and property leaves.
	if (!folder.trim()) {
		return { paths: new Set(), stalePaths: [] };
	}

	const paths = new Set<string>();
	for (const p of universe) {
		if (matchesPathPrefix(p, folder)) {
			paths.add(p);
		}
	}
	return { paths, stalePaths: [] };
}

function resolveTag(app: App, tag: string, universe: Set<string>): ResolvedView {
	const normalizedFilter = tag.startsWith("#") ? tag : `#${tag}`;
	const paths = new Set<string>();
	for (const p of universe) {
		const file = app.vault.getAbstractFileByPath(p);
		if (!(file instanceof TFile)) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fileTags = cache ? (getAllTags(cache) ?? []) : [];
		const normalizedDocTags = fileTags.map((t) => (t.startsWith("#") ? t : `#${t}`));
		const matches = normalizedDocTags.some(
			(docTag) => docTag === normalizedFilter || docTag.startsWith(`${normalizedFilter}/`),
		);
		if (matches) {
			paths.add(p);
		}
	}
	return { paths, stalePaths: [] };
}

function resolveExtension(ext: string, universe: Set<string>): ResolvedView {
	const normalizedExt = ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
	const paths = new Set<string>();
	for (const p of universe) {
		const fileExt = p.split(".").pop()?.toLowerCase() ?? "";
		if (fileExt === normalizedExt) {
			paths.add(p);
		}
	}
	return { paths, stalePaths: [] };
}

/**
 * Normalize a frontmatter value to a flat array of comparable strings.
 *
 * YAML gives us strings, numbers, booleans, `null`, or lists of those. Treating a
 * scalar as a one-element list means `exists` and `equals-any` need only one code
 * path and list-valued properties work for free. Dates are deliberately compared as
 * opaque strings — no before/after operators, since a time-relative privacy rule
 * would let a note change visibility with no edit to the vault.
 */
function normalizePropertyValues(raw: unknown): string[] {
	if (raw === null || raw === undefined) return [];
	const items = Array.isArray(raw) ? raw : [raw];
	const out: string[] = [];
	for (const item of items) {
		if (item === null || item === undefined) continue;
		if (typeof item === "object") continue;
		out.push(String(item).trim().toLowerCase());
	}
	return out;
}

/**
 * Match a single file against a `property` leaf.
 *
 * With no `values`, the leaf means "this key is present and non-empty". With
 * `values`, it means "this key equals any of them" (case-insensitive, exact —
 * no substring matching).
 */
function matchesPropertyLeaf(app: App, filePath: string, key: string, values: string[] | undefined): boolean {
	const trimmedKey = key.trim();
	if (!trimmedKey) return false;

	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return false;

	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter) return false;

	// Property keys are matched case-insensitively to mirror how users type them.
	const matchedKey = Object.keys(frontmatter).find((k) => k.toLowerCase() === trimmedKey.toLowerCase());
	if (matchedKey === undefined) return false;

	const actual = normalizePropertyValues(frontmatter[matchedKey]);
	if (actual.length === 0) return false;

	const wanted = (values ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
	if (wanted.length === 0) return true;

	return actual.some((v) => wanted.includes(v));
}

function resolveProperty(app: App, key: string, values: string[] | undefined, universe: Set<string>): ResolvedView {
	const paths = new Set<string>();
	for (const p of universe) {
		if (matchesPropertyLeaf(app, p, key, values)) {
			paths.add(p);
		}
	}
	return { paths, stalePaths: [] };
}

function resolvePaths(app: App, frozenPaths: string[]): ResolvedView {
	const paths = new Set<string>();
	const stalePaths: string[] = [];
	for (const p of frozenPaths) {
		const file = app.vault.getAbstractFileByPath(p);
		if (file) {
			paths.add(p);
		} else {
			stalePaths.push(p);
		}
	}
	return { paths, stalePaths };
}

// ── Group (composite) resolution ────────────────────────────────────────

function resolveGroup(app: App, group: ViewFilterGroup, universe: Set<string>): ResolvedView {
	if (group.conditions.length === 0) {
		// Empty "all" = everything (vacuous truth)
		// Empty "any" = nothing (no child matches)
		// Empty "none" = everything (complement of nothing)
		if (group.type === "any") return { paths: new Set(), stalePaths: [] };
		return { paths: new Set(universe), stalePaths: [] };
	}

	const childResults = group.conditions.map((c) => resolveNode(app, c, universe));
	const allStale = childResults.flatMap((r) => r.stalePaths);

	switch (group.type) {
		case "all":
			return { paths: intersect(childResults.map((r) => r.paths)), stalePaths: allStale };
		case "any":
			return { paths: union(childResults.map((r) => r.paths)), stalePaths: allStale };
		case "none":
			return { paths: difference(universe, union(childResults.map((r) => r.paths))), stalePaths: allStale };
	}
}

// ── Set operations ──────────────────────────────────────────────────────

function intersect(sets: Set<string>[]): Set<string> {
	if (sets.length === 0) return new Set();
	// Start with the smallest set for efficiency
	const sorted = [...sets].sort((a, b) => a.size - b.size);
	const result = new Set(sorted[0]);
	for (let i = 1; i < sorted.length; i++) {
		for (const item of result) {
			if (!sorted[i].has(item)) {
				result.delete(item);
			}
		}
	}
	return result;
}

function union(sets: Set<string>[]): Set<string> {
	const result = new Set<string>();
	for (const s of sets) {
		for (const item of s) {
			result.add(item);
		}
	}
	return result;
}

function difference(base: Set<string>, subtract: Set<string>): Set<string> {
	const result = new Set<string>();
	for (const item of base) {
		if (!subtract.has(item)) {
			result.add(item);
		}
	}
	return result;
}

// ── Description helpers ─────────────────────────────────────────────────

function describeLeaf(leaf: ViewFilterLeaf): string {
	switch (leaf.type) {
		case "folder":
			return `folder:${leaf.value}`;
		case "tag":
			return leaf.value.startsWith("#") ? `tag:${leaf.value}` : `tag:#${leaf.value}`;
		case "extension":
			return `ext:.${leaf.value}`;
		case "paths":
			return `${leaf.value.length} note${leaf.value.length === 1 ? "" : "s"}`;
		case "property":
			return leaf.values && leaf.values.length > 0
				? `prop:${leaf.value}=${leaf.values.join("|")}`
				: `prop:${leaf.value}`;
	}
}
