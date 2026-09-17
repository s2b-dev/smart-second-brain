/**
 * Vendored browser bundles inlined into widget frames (see `widgetLibs.ts`). Imported as raw
 * text and injected as an inline `<script>`; a sandboxed frame has no network to load them
 * from, and blob URLs are origin-bound so an opaque-origin frame could not fetch one either.
 */
declare module "*.min.js?raw" {
	const source: string;
	export default source;
}
