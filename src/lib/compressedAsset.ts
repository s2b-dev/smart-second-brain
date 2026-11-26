/**
 * Runtime half of the compressed-asset scheme: see `bundling/compressedAssets.ts` for what is
 * compressed and why.
 *
 * Synchronous on purpose. `t()` must answer during module evaluation and first render, long
 * before anything could await a `DecompressionStream`, so this uses pako, which pdf-lib
 * already brings into the bundle (the direct dependency pins the same major so it stays one
 * copy).
 */
import { inflateRaw } from "pako";

/** Inflate a base64 raw-deflate string produced at build time back into its text. */
export function inflateAsset(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return inflateRaw(bytes, { to: "string" });
}

/** A value decoded from a compressed asset on first read and kept from then on. */
export function lazyAsset<T>(decode: () => T): () => T {
	let value: { v: T } | undefined;
	return () => {
		value ??= { v: decode() };
		return value.v;
	};
}
