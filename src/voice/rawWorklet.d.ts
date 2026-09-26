/**
 * The voice-mode capture worklet is shipped as raw text and loaded through a blob
 * URL at runtime (`audioCapture.ts`): `audioWorklet.addModule` wants a URL, and the
 * `?worker&inline` route the other workers use yields a constructor instead.
 */
declare module "*.worklet.js?raw" {
	const source: string;
	export default source;
}
