/**
 * Browser libraries a view can ask for with `libs:` in its frontmatter.
 *
 * A view frame has no network and an opaque origin, so a library can reach it only one
 * way: inlined whole as a `<script>` in the frame's document. That makes every entry
 * here a per-view cost (the source is parsed once per frame that requests it) and a
 * bundle cost (the source ships inside main.js as a string), which is why the set is
 * small, opt-in, and each entry is a single self-contained UMD/IIFE build.
 *
 * Adding one: vendor a browser build that defines a global, import it `?raw`, add an
 * entry, and document the global and its scope in the `views` skill.
 */

import plotlySource from "plotly.js-gl3d-dist-min/plotly-gl3d.min.js?raw";

export interface ViewLib {
	/** The id a view writes under `libs:`. */
	id: string;
	/** Shown in notices. */
	displayName: string;
	/** The global the inlined build defines, for the skill's documentation. */
	global: string;
	/** The build's source text, injected verbatim (after inline-script escaping). */
	source: string;
}

/**
 * Plotly's "gl3d" partial bundle: the 2D basics (scatter, bar, pie) plus every WebGL 3D
 * trace (scatter3d, surface, mesh3d, cone, streamtube, isosurface, volume). Chosen over the
 * full bundle because it is less than half its size and covers both study plots and 3D.
 */
export const VIEW_LIBS: Readonly<Record<string, ViewLib>> = {
	plotly: {
		id: "plotly",
		displayName: "Plotly",
		global: "Plotly",
		source: plotlySource,
	},
};

/** Resolve requested ids (deduplicated, in order) to sources; unknown ids are reported, not dropped silently. */
export function resolveViewLibs(ids: readonly string[]): { sources: string[]; unknown: string[] } {
	const sources: string[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		const lib = VIEW_LIBS[id];
		if (lib) sources.push(lib.source);
		else unknown.push(id);
	}
	return { sources, unknown };
}
