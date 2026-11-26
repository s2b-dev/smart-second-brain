/**
 * Imports served by the build plugin in `bundling/compressedAssets.ts`. Both resolve to base64
 * raw-deflate text; decode with `inflateAsset` from `lib/compressedAsset.ts`.
 */
declare module "*?deflate" {
	const deflated: string;
	export default deflated;
}

declare module "virtual:s2b-locale-packs" {
	/** Every non-English locale: `{ <locale>: deflated JSON of { <namespace>: catalog } }`. */
	const packs: Record<string, string>;
	export default packs;
}
