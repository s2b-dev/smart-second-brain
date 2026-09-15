/**
 * Build-time replacements for the Pixi.js modules that generate code with
 * `new Function` (uniform/UBO/shader sync and particle update generators, plus
 * the `unsafeEvalSupported` probe).
 *
 * The graph renderer imports `pixi.js/unsafe-eval`, Pixi's own eval-free
 * implementation, which swaps these generators out at runtime — but the
 * originals would still sit in the bundle as dead code, and the plugin review
 * scans the bundle text for dynamic code execution. `vite.config.ts` therefore
 * aliases each of them here. None of these should ever be called; if one is,
 * the polyfill was not installed and the error says so.
 */

function notInstalled(name: string): never {
	throw new Error(`Pixi ${name} requires eval; import "pixi.js/unsafe-eval" before creating the renderer.`);
}

/** Replaces `utils/browser/unsafeEvalSupported`: the eval-free polyfills make the probe moot. */
export function unsafeEvalSupported(): boolean {
	return true;
}

export function createUboSyncFunction(): never {
	return notInstalled("createUboSyncFunction");
}

/** Pixi ≥ 8.20 renamed `createUboSyncFunction` to `compileBufferSync`. */
export function compileBufferSync(): never {
	return notInstalled("compileBufferSync");
}

export function generateShaderSyncCode(): never {
	return notInstalled("generateShaderSyncCode");
}

export function generateUniformsSync(): never {
	return notInstalled("generateUniformsSync");
}

export function generateParticleUpdateFunction(): never {
	return notInstalled("generateParticleUpdateFunction");
}
