/**
 * Pixi.js WebGL renderer for the Smart Graph.
 *
 * Encapsulates all Pixi.js display-object management, hit detection,
 * viewport zoom/pan, and theme-aware rendering. The Svelte component
 * (`GraphCanvas.svelte`) remains the orchestrator for the d3-force layout
 * and reactive state.
 */

// Pixi's eval-free code paths (uniform/UBO/shader sync without `new Function`).
// Must run before the first renderer is created; the eval-based originals are
// aliased out of the bundle in vite.config.ts.
import "pixi.js/unsafe-eval";
import { Application, CanvasSource, Container, Graphics, Sprite, Text, TextStyle, Texture, Ticker } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { edgeAlphaZoomLift, nodeDrawRadius, zoomNodeScale } from "../../utils/graphUtils";

// ── Helpers ──────────────────────────────────────────────────

/** Draw a dashed line on a Pixi Graphics object (Pixi has no native setLineDash). */
function drawDashedLine(g: Graphics, x1: number, y1: number, x2: number, y2: number, dash: number, gap: number): void {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	const ux = dx / len;
	const uy = dy / len;
	let drawn = 0;
	let drawing = true;
	while (drawn < len) {
		const seg = drawing ? dash : gap;
		const end = Math.min(drawn + seg, len);
		if (drawing) {
			g.moveTo(x1 + ux * drawn, y1 + uy * drawn);
			g.lineTo(x1 + ux * end, y1 + uy * end);
		}
		drawn = end;
		drawing = !drawing;
	}
}

// ── Color utilities ──────────────────────────────────────────

/**
 * Resolve any CSS color value (including calc(), var(), hsl(), etc.) to a
 * hex string that Pixi.js can understand.  Uses a hidden 2D canvas context
 * to let the browser resolve the value.
 */
let _colorCtx: CanvasRenderingContext2D | null = null;
// Memo for resolved colors: cluster palettes are hsl() strings and node fills
// resolve on the per-frame hot path, so each unique value should hit the canvas
// context exactly once. Only successful resolutions are cached — a failure's
// result depends on the caller's fallback.
const _resolvedColorCache = new Map<string, string>();
function rememberResolvedColor(raw: string, hex: string): string {
	if (_resolvedColorCache.size > 1024) _resolvedColorCache.clear();
	_resolvedColorCache.set(raw, hex);
	return hex;
}
function resolveColor(raw: string, fallback: string): string {
	if (!raw || raw === "none" || raw === "transparent") return fallback;
	// Already a hex color — fast path
	if (raw.startsWith("#")) return raw;
	const cached = _resolvedColorCache.get(raw);
	if (cached !== undefined) return cached;

	try {
		if (!_colorCtx) {
			const c = createEl("canvas");
			c.width = 1;
			c.height = 1;
			// getContext can genuinely return null (no 2D support, or a context already
			// acquired under another type). The assertion here turned that into a
			// TypeError on the next line; this takes the fallback the function already has.
			const ctx = c.getContext("2d");
			if (!ctx) return fallback;
			_colorCtx = ctx;
		}
		_colorCtx.fillStyle = "#000000"; // reset
		_colorCtx.fillStyle = raw;
		const resolved = _colorCtx.fillStyle; // browser-resolved hex or rgb()
		// fillStyle returns a hex string like "#rrggbb" or "rgba(r,g,b,a)"
		if (resolved.startsWith("#")) return rememberResolvedColor(raw, resolved);
		// Parse rgb/rgba → hex
		const m = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		if (m) {
			const r = Number(m[1]).toString(16).padStart(2, "0");
			const g = Number(m[2]).toString(16).padStart(2, "0");
			const b = Number(m[3]).toString(16).padStart(2, "0");
			return rememberResolvedColor(raw, `#${r}${g}${b}`);
		}
		return fallback;
	} catch {
		return fallback;
	}
}

// ── Theme colors ─────────────────────────────────────────────

export interface ThemeColors {
	accent: string;
	textNormal: string;
	textMuted: string;
	textFaint: string;
	textAccent: string;
	graphLine: string;
	graphNode: string;
	/** Fill for tag nodes — Obsidian's own graph colour for them. */
	graphNodeTag: string;
	textOnAccent: string;
	bgPrimary: string;
	font: string;
}

/** Blend fg over bg at the given alpha, returning a fully-opaque hex color.
 *  Prevents semi-transparent edges from stacking into a bright hotspot near nodes. */
function blendColor(fg: string, bg: string, alpha: number): string {
	const safeAlpha = clampUnitInterval(alpha, 1);
	const [pr, pg, pb] = parseHexColorChannels(fg, [255, 255, 255]);
	const [br, bg_, bb] = parseHexColorChannels(bg, [0, 0, 0]);
	const r = Math.round(br + (pr - br) * safeAlpha);
	const g = Math.round(bg_ + (pg - bg_) * safeAlpha);
	const b = Math.round(bb + (pb - bb) * safeAlpha);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Parsed-channel memo backing the per-node-per-frame tint path.
const _channelCache = new Map<string, [number, number, number]>();
function hexChannels(color: string): [number, number, number] {
	let channels = _channelCache.get(color);
	if (!channels) {
		channels = parseHexColorChannels(color, [255, 255, 255]);
		if (_channelCache.size > 1024) _channelCache.clear();
		_channelCache.set(color, channels);
	}
	return channels;
}

/** Same blend as {@link blendColor}, returned as a Pixi tint number — no string building. */
function blendTint(fg: string, bg: [number, number, number], alpha: number): number {
	const safeAlpha = clampUnitInterval(alpha, 1);
	const [pr, pg, pb] = hexChannels(fg);
	const r = Math.round(bg[0] + (pr - bg[0]) * safeAlpha);
	const g = Math.round(bg[1] + (pg - bg[1]) * safeAlpha);
	const b = Math.round(bg[2] + (pb - bg[2]) * safeAlpha);
	return (r << 16) | (g << 8) | b;
}

function clampUnitInterval(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

function parseHexColorChannels(color: string, fallback: [number, number, number]): [number, number, number] {
	if (!color.startsWith("#") || color.length !== 7) return fallback;
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
		return fallback;
	}
	return [red, green, blue];
}

export function readThemeColors(el: HTMLElement): ThemeColors {
	const style = getComputedStyle(el);
	// Resolve every color through the canvas context so CSS calc(), var(),
	// and other dynamic expressions are converted to hex for Pixi.js.
	const get = (prop: string, fallback: string) => resolveColor(style.getPropertyValue(prop).trim(), fallback);
	return {
		accent: get("--interactive-accent", "#7b6cd9"),
		textNormal: get("--text-normal", "#dcddde"),
		textMuted: get("--text-muted", "#999999"),
		textFaint: get("--text-faint", "#b4b4b4"),
		textAccent: get("--text-accent", "#7b6cd9"),
		graphLine: get("--graph-line", "#969696"),
		graphNode: get("--graph-node", "#999999"),
		graphNodeTag: get("--graph-node-tag", "#08b94e"),
		textOnAccent: get("--text-on-accent", "#ffffff"),
		bgPrimary: get("--background-primary", "#1e1e1e"),
		font: style.getPropertyValue("--font-interface").trim() || "-apple-system, BlinkMacSystemFont, sans-serif",
	};
}

// ── Types ────────────────────────────────────────────────────

/**
 * Backing size of the shared node disc texture. A power of two, so mipmap
 * generation works on every WebGL context — without mipmaps, a 128px disc
 * sampled down to a handful of screen pixels aliases into visibly rough edges
 * on every zoomed-out node.
 */
const NODE_TEXTURE_SIZE = 128;
/**
 * Radius of the disc drawn into that texture. The margin to the texture edge
 * keeps the clamped border pixels transparent, so downsampled mip levels don't
 * pick up edge bleed.
 */
const NODE_TEXTURE_RADIUS = 60;

/**
 * Above this many visible semantic edges, dashes fall back to solid strokes.
 *
 * A dashed edge costs path segments proportional to its screen length (~one
 * per 9px), so a dense zoomed-out graph turns the dash pass into the largest
 * remaining tessellation cost — at exactly the density where the pattern
 * reads as shimmer rather than as dashes. Alpha is reduced to match the ink
 * of the ~55% dash duty cycle, so the fallback carries the same visual
 * weight.
 */
const SEMANTIC_DASH_EDGE_LIMIT = 500;
const SEMANTIC_SOLID_ALPHA_SCALE = 0.6;

/** Hit area info for screen-space cluster pills (stored for click/hover). */
export interface ClusterPillHit {
	x: number;
	y: number;
	w: number;
	h: number;
	cluster: number;
}

// ── Renderer ─────────────────────────────────────────────────

export class PixiRenderer {
	// Pixi core
	private app!: Application;
	private viewport!: Viewport;

	// Layers (world-space, inside viewport)
	private hullLayer!: Container;
	private edgeLayer!: Container;
	private nodeLayer!: Container;
	private labelLayer!: Container;
	private lassoLayer!: Container;

	// Overlay (screen-space, outside viewport)
	private overlayStage!: Container;
	private clusterPillLayer!: Container;
	private tooltipLayer!: Container;

	// Display objects
	private hullGraphics!: Graphics;
	private edgeGraphics!: Graphics;
	private lassoGraphics!: Graphics;

	// Nodes are Sprites sharing one white circle texture, recolored via tint —
	// position, scale, and tint are all uniform updates, so per-frame node sync
	// never tessellates geometry and the whole layer batches into one draw call.
	private nodeTexture!: Texture;
	private nodeSpriteMap: Map<string, Sprite> = new Map();

	// Stroke rings (hover / selection / highlight — a handful of nodes) stay
	// vector Graphics in their own layer above the sprites, so they render
	// crisply at any zoom. Cached per ring to skip rebuilds when unchanged.
	private nodeStrokeLayer!: Container;
	private strokeRingMap: Map<string, Graphics> = new Map();
	private strokeRingCache: Map<string, { radius: number; color: string; width: number }> = new Map();

	// Label pool
	private labelPool: Text[] = [];
	private activeLabelCount = 0;
	private readonly LABEL_POOL_SIZE = 250;
	// Last-written values per pool slot — used to skip redundant property updates
	private labelPoolCache: Array<{
		text: string;
		nodeX: number;
		nodeY: number;
		fontSize: number;
		color: string;
		alpha: number;
		scale: number;
	} | null> = [];

	// Overlay objects
	private clusterPillObjects: Array<{ container: Container; graphics: Graphics; text: Text }> = [];
	private tooltipContainer!: Container;
	private tooltipGraphics!: Graphics;
	private tooltipTexts: Text[] = [];
	// Tooltip layout cache — text rasterization and box measurement rerun only
	// when the content changes; per-frame calls just move the container.
	private _tooltipLayoutKey = "";
	private _tooltipBoxW = 0;
	private _tooltipBoxH = 0;

	// State
	private _theme!: ThemeColors;
	private _width = 0;
	private _height = 0;
	private _destroyed = false;
	private _ready = false;
	/**
	 * Whether `app.init()` has resolved. `this.app` is assigned synchronously by
	 * `new Application()` but is not usable — and must not be destroyed — until its
	 * async `init()` completes. Distinct from `_ready`, which additionally requires
	 * the scene graph to be built.
	 */
	private _appInitialized = false;

	// Callback fired whenever the viewport moves (pan/zoom/pinch)
	private _onViewportMoved: (() => void) | null = null;
	// Shared-ticker callback that polls viewport.dirty (removed on destroy)
	private _viewportDirtyFn: (() => void) | null = null;

	// WebGL context loss (mobile WebViews reclaim the GPU when the app is
	// backgrounded). Pixi's GlContextSystem preventDefault()s the lost event and
	// rebuilds its GPU state on restore, but rendering here is on-demand
	// (autoStart: false) — so without our own hooks the canvas would stay blank
	// until the next user interaction happened to request a frame.
	private _contextLost = false;
	private _onContextRestored: (() => void) | null = null;
	private _contextLostHandler: ((e: Event) => void) | null = null;
	private _contextRestoredHandler: (() => void) | null = null;

	// Public accessors
	get theme(): ThemeColors {
		return this._theme;
	}
	get width(): number {
		return this._width;
	}
	get height(): number {
		return this._height;
	}

	/** Whether the renderer has been fully initialized. */
	get ready(): boolean {
		return this._ready;
	}

	/** Register a callback that fires whenever the viewport moves (pan/zoom). */
	onViewportMoved(cb: () => void): void {
		this._onViewportMoved = cb;
	}

	/**
	 * Register a callback that fires after a lost WebGL context is restored (and
	 * Pixi has rebuilt its GPU state). The owner should schedule a full render
	 * pass; without one the canvas keeps showing the cleared framebuffer.
	 */
	onContextRestored(cb: () => void): void {
		this._onContextRestored = cb;
	}

	// ── Lifecycle ──────────────────────────────────────────

	async init(containerEl: HTMLElement, theme: ThemeColors): Promise<void> {
		this._theme = theme;

		const rect = containerEl.getBoundingClientRect();
		this._width = rect.width;
		this._height = rect.height;

		this.app = new Application();
		await this.app.init({
			width: this._width,
			height: this._height,
			antialias: true,
			backgroundAlpha: 0,
			resolution: window.devicePixelRatio || 1,
			autoDensity: true,
			preference: "webgl",
			// Rendering is on demand: the owner calls renderFrame() when something
			// actually changed, so a settled graph costs no GPU work at idle.
			autoStart: false,
		});

		// `app.init()` creates a WebGL context — a real async gap, longer on a cold
		// GPU. If the owner tore us down inside it, `destroy()` already ran and found
		// nothing to release (`_appInitialized` was still false). Undo the context we
		// just finished creating and stop, rather than building a full scene graph and
		// registering a shared-ticker callback that nothing will ever remove.
		if (this._destroyed) {
			this.app.destroy(true, { children: true });
			return;
		}
		this._appInitialized = true;

		// Style the canvas
		const canvas = this.app.canvas;
		canvas.addClass("s2b-graph-canvas");
		containerEl.prepend(canvas);

		// Context-loss hooks. Pixi's GlContextSystem registered its listeners during
		// app.init(), so they run first: on loss it preventDefault()s (which is what
		// makes the browser willing to restore the context at all), and on restore it
		// re-runs its contextChange runners to rebuild GPU state before our handler
		// fires. Ours only tracks the lost window (renderFrame is skipped while the
		// context is gone) and asks the owner for a full repaint once it's back.
		this._contextLostHandler = (e: Event) => {
			// Redundant with Pixi's own preventDefault, but kept as a guard against
			// listener-order surprises: without it the context is never restored.
			e.preventDefault();
			this._contextLost = true;
		};
		this._contextRestoredHandler = () => {
			this._contextLost = false;
			if (this._destroyed) return;
			// Text textures cannot survive a restore (see rebuildTextObjects) —
			// swap in fresh Text objects before anything renders.
			this.rebuildTextObjects();
			if (this._onContextRestored) this._onContextRestored();
			else this.renderFrame();
		};
		canvas.addEventListener("webglcontextlost", this._contextLostHandler);
		canvas.addEventListener("webglcontextrestored", this._contextRestoredHandler);

		// Viewport (zoom, pan, pinch)
		// worldWidth/worldHeight must be set so the internal hit-area is non-zero;
		// otherwise wheel and pointer events are silently dropped.
		this.viewport = new Viewport({
			screenWidth: this._width,
			screenHeight: this._height,
			worldWidth: this._width * 10,
			worldHeight: this._height * 10,
			events: this.app.renderer.events,
			passiveWheel: true,
		});
		this.app.stage.addChild(this.viewport);

		this.viewport
			.drag()
			.pinch()
			.wheel({ smooth: 5, trackpadPinch: true })
			.decelerate({ friction: 0.92 })
			.animate({})
			.clampZoom({
				minScale: 0.05,
				maxScale: 10,
			});

		// The viewport updates its plugins (wheel smoothing, decelerate, animate)
		// on the shared ticker, so the camera can move without any pointer event
		// firing. Its `dirty` flag is set by that update loop for every movement
		// source — polling it here is the one signal that catches them all. The
		// viewport's own update runs first on the same ticker (it registered
		// earlier), so a movement is observed the tick it happens.
		this._viewportDirtyFn = () => {
			if (this.viewport.dirty) {
				this.viewport.dirty = false;
				this._onViewportMoved?.();
			}
		};
		Ticker.shared.add(this._viewportDirtyFn);

		// World-space layers (inside viewport). Hulls sit at the bottom so topic
		// regions read as background, never over edges or nodes.
		this.hullLayer = new Container();
		this.edgeLayer = new Container();
		this.nodeLayer = new Container();
		this.nodeStrokeLayer = new Container();
		this.labelLayer = new Container();
		this.lassoLayer = new Container();
		this.viewport.addChild(this.hullLayer);
		this.viewport.addChild(this.edgeLayer);
		this.viewport.addChild(this.nodeLayer);
		this.viewport.addChild(this.nodeStrokeLayer);
		this.viewport.addChild(this.labelLayer);
		this.viewport.addChild(this.lassoLayer);

		// Shared node texture: one antialiased white disc every node sprite
		// scales and tints. Drawn on a 2D canvas rather than via generateTexture:
		// the canvas upload path generates mipmaps (autoGenerateMipmaps), which
		// is what keeps far-zoomed-out nodes reading as smooth circles instead
		// of aliased blobs — render textures only mipmap on explicit request.
		// Extreme zoom-ins upscale past the texture, where the vector stroke
		// ring on the hovered node carries the sharp edge anyway.
		const disc = createEl("canvas");
		disc.width = NODE_TEXTURE_SIZE;
		disc.height = NODE_TEXTURE_SIZE;
		const discCtx = disc.getContext("2d");
		if (discCtx) {
			discCtx.fillStyle = "#ffffff";
			discCtx.beginPath();
			discCtx.arc(NODE_TEXTURE_SIZE / 2, NODE_TEXTURE_SIZE / 2, NODE_TEXTURE_RADIUS, 0, Math.PI * 2);
			discCtx.fill();
		}
		this.nodeTexture = new Texture({
			source: new CanvasSource({ resource: disc, autoGenerateMipmaps: true }),
		});

		// Hull graphics (single batched)
		this.hullGraphics = new Graphics();
		this.hullLayer.addChild(this.hullGraphics);

		// Edge graphics (single batched)
		this.edgeGraphics = new Graphics();
		this.edgeLayer.addChild(this.edgeGraphics);

		// Lasso graphics
		this.lassoGraphics = new Graphics();
		this.lassoLayer.addChild(this.lassoGraphics);

		// Screen-space overlay (outside viewport)
		this.overlayStage = new Container();
		this.app.stage.addChild(this.overlayStage);

		this.clusterPillLayer = new Container();
		this.tooltipLayer = new Container();
		this.overlayStage.addChild(this.clusterPillLayer);
		this.overlayStage.addChild(this.tooltipLayer);

		// Pre-allocate label pool
		this.buildLabelPool();

		// Tooltip setup
		this.tooltipContainer = new Container();
		this.tooltipContainer.visible = false;
		this.tooltipGraphics = new Graphics();
		this.tooltipContainer.addChild(this.tooltipGraphics);
		this.buildTooltipTexts();
		this.tooltipLayer.addChild(this.tooltipContainer);

		this._ready = true;
	}

	/** Fill the (empty) label pool with fresh Text objects attached to the label layer. */
	private buildLabelPool(): void {
		for (let i = 0; i < this.LABEL_POOL_SIZE; i++) {
			const t = new Text({
				text: "",
				style: new TextStyle({
					fontFamily: this._theme.font,
					fontSize: 12,
					fill: this._theme.textNormal,
				}),
			});
			t.anchor.set(0.5, 1); // center-bottom
			t.visible = false;
			this.labelLayer.addChild(t);
			this.labelPool.push(t);
			this.labelPoolCache.push(null);
		}
	}

	/** Create the tooltip's three text lines inside the (existing) tooltip container. */
	private buildTooltipTexts(): void {
		for (let i = 0; i < 3; i++) {
			const t = new Text({
				text: "",
				style: new TextStyle({
					fontFamily: this._theme.font,
					fontSize: 11,
					fill: i === 0 ? this._theme.textNormal : this._theme.textMuted,
					fontWeight: i === 0 ? "bold" : "normal",
				}),
			});
			t.anchor.set(0, 0);
			this.tooltipContainer.addChild(t);
			this.tooltipTexts.push(t);
		}
	}

	/**
	 * Destroy and recreate every Text object this renderer owns.
	 *
	 * Needed after a WebGL context restore: Pixi's WebGL text system uploads each
	 * rasterized glyph canvas to the GPU and immediately returns the canvas to a
	 * shared pool (`GpuTextSystem` passes `retainCanvasContext: false`), so unlike
	 * sprite/canvas textures there is no CPU-side copy left to re-upload from — a
	 * restored context comes back with every text texture permanently blank. And
	 * re-setting the same string doesn't help: the text-texture cache is keyed by
	 * content+style, so an unchanged key hands the dead texture straight back.
	 * Destroying the Text objects drops those cache entries (refcount → 0), and
	 * the fresh ones rasterize on the live context.
	 */
	private rebuildTextObjects(): void {
		if (!this._ready) return;

		// Node labels: rebuild the pool in place.
		for (const t of this.labelPool) t.destroy();
		this.labelPool = [];
		this.labelPoolCache = [];
		this.activeLabelCount = 0;
		this.buildLabelPool();

		// Cluster pills: drop the pool entirely; drawClusterPills re-creates
		// pill objects on demand on the next overlay pass.
		for (const obj of this.clusterPillObjects) obj.container.destroy({ children: true });
		this.clusterPillObjects = [];

		// Tooltip lines: recreate, and clear the layout cache so the next
		// showNodeTooltip re-rasterizes instead of reusing the cached layout.
		for (const t of this.tooltipTexts) t.destroy();
		this.tooltipTexts = [];
		this.buildTooltipTexts();
		this._tooltipLayoutKey = "";
	}

	destroy(): void {
		if (this._destroyed) return;
		this._destroyed = true;
		this._ready = false;
		if (this._viewportDirtyFn) {
			Ticker.shared.remove(this._viewportDirtyFn);
			this._viewportDirtyFn = null;
		}
		// Sprites share this render texture, so it isn't covered by the
		// children-destroy below.
		this.nodeTexture?.destroy(true);
		// Only tear down a pixi Application whose async `init()` actually resolved.
		// `new Application()` assigns `this.app` synchronously, so a destroy during
		// init would otherwise call `destroy()` on a renderer that was never created
		// — which throws, aborting the caller's remaining cleanup. `init()` checks
		// `_destroyed` after its await and releases the context itself in that case.
		if (this._appInitialized) {
			// The context-loss listeners were only registered once init() got past
			// the same gate, so they exist exactly when the app does.
			const canvas = this.app.canvas;
			if (this._contextLostHandler) canvas.removeEventListener("webglcontextlost", this._contextLostHandler);
			if (this._contextRestoredHandler) {
				canvas.removeEventListener("webglcontextrestored", this._contextRestoredHandler);
			}
			this._contextLostHandler = null;
			this._contextRestoredHandler = null;
			this.app.destroy(true, { children: true });
		}
	}

	/**
	 * Render one frame to the canvas. The application ticker is disabled
	 * (`autoStart: false`), so nothing draws unless the owner asks for it —
	 * GraphCanvas calls this once at the end of each coalesced render pass.
	 */
	renderFrame(): void {
		if (this._destroyed || !this._ready) return;
		// GL calls against a lost context are no-ops at best; skip the draw and let
		// the contextrestored handler request the repaint.
		if (this._contextLost) return;
		this.app.renderer.render(this.app.stage);
	}

	// ── Canvas access ──────────────────────────────────────

	get canvas(): HTMLCanvasElement {
		return this.app.canvas;
	}

	// ── Resize ─────────────────────────────────────────────

	resize(width: number, height: number): void {
		this._width = width;
		this._height = height;
		this.app.renderer.resize(width, height);
		this.viewport.resize(width, height, width * 10, height * 10);
	}

	// ── Theme ──────────────────────────────────────────────

	updateTheme(theme: ThemeColors): void {
		this._theme = theme;
		// Invalidate label cache so font/color changes are picked up on the next draw
		this.labelPoolCache.fill(null);
		// Tooltip box and text colors are baked into its cached layout
		this._tooltipLayoutKey = "";
		// Update tooltip text styles
		for (let i = 0; i < this.tooltipTexts.length; i++) {
			this.tooltipTexts[i].style.fontFamily = theme.font;
			this.tooltipTexts[i].style.fill = i === 0 ? theme.textNormal : theme.textMuted;
		}
		// Node colors are refreshed on the next updateNodes() call
	}

	// ── Viewport / camera ──────────────────────────────────

	/** Convert screen coords to world (graph) coords. */
	screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
		const pt = this.viewport.toWorld(screenX, screenY);
		return { x: pt.x, y: pt.y };
	}

	/** Get current viewport transform in the same format as the old code. */
	getTransform(): { x: number; y: number; scale: number } {
		return {
			x: this.viewport.x,
			y: this.viewport.y,
			scale: this.viewport.scaled,
		};
	}

	/** Set the viewport transform directly (for animation). */
	setTransform(x: number, y: number, scale: number): void {
		this.viewport.moveCenter(-x / scale + this._width / 2 / scale, -y / scale + this._height / 2 / scale);
		this.viewport.setZoom(scale, true);
	}

	/** Move the viewport to center on a world point at a given scale. */
	moveCenter(worldX: number, worldY: number, scale?: number): void {
		this.viewport.moveCenter(worldX, worldY);
		if (scale != null) {
			this.viewport.setZoom(scale, true);
		}
	}

	/** Animate the viewport to frame a bounding box. */
	animateToFrame(centerX: number, centerY: number, scale: number, duration: number): void {
		this.viewport.animate({
			position: { x: centerX, y: centerY },
			scale: scale,
			time: duration,
			ease: "easeOutCubic",
			callbackOnComplete: () => {},
		});
	}

	/** Snap the viewport to frame a bounding box without animation. */
	snapToFrame(centerX: number, centerY: number, scale: number): void {
		this.viewport.moveCenter(centerX, centerY);
		this.viewport.setZoom(scale, true);
	}

	/** Get the current viewport scale. */
	get scale(): number {
		return this.viewport.scaled;
	}

	/** Cancel any running camera animation (e.g. when the user starts panning). */
	abortAnimation(): void {
		this.viewport.plugins.remove("animate");
	}

	// Pause/resume viewport interaction (e.g. during node drag)
	pauseViewport(): void {
		this.viewport.plugins.pause("drag");
		this.viewport.plugins.pause("decelerate");
	}

	resumeViewport(): void {
		this.viewport.plugins.resume("drag");
		this.viewport.plugins.resume("decelerate");
	}

	// ── Node management ────────────────────────────────────

	/**
	 * Sync node display objects with the current simNodes array.
	 * Fast path: only updates positions + alpha when geometry hasn't changed.
	 * Slow path: rebuilds circles/strokes only when visual state differs.
	 */
	syncNodes(
		nodes: Array<{
			id: string;
			x: number;
			y: number;
			color?: string;
			degree?: number;
			highlighted?: boolean;
			/** "topic" for a collapsed topic node — sized on its own curve. */
			kind?: string;
		}>,
		nodeSize: number,
		opts: {
			selectedNodes: Set<string>;
			hoveredNodeId: string | null;
			draggedNodeId: string | null;
			focusedClusters: Set<number>;
			isForceMode: boolean;
			hoverAlphas: Map<string, number>;
			nodeClusterMap: Map<string, number | undefined>;
			/**
			 * Per-node radius multiplier for spawn animations (grow-in on
			 * collapse/expand and live additions). Absent or 1 = full size.
			 */
			spawnScales?: Map<string, number> | null;
		},
	): void {
		const nodeIds = new Set(nodes.map((n) => n.id));
		const c = this._theme;
		const scale = this.viewport.scaled || 1;

		// Remove stale nodes and rings
		for (const [id, sprite] of this.nodeSpriteMap) {
			if (!nodeIds.has(id)) {
				this.nodeLayer.removeChild(sprite);
				sprite.destroy();
				this.nodeSpriteMap.delete(id);
			}
		}
		for (const [id, ring] of this.strokeRingMap) {
			if (!nodeIds.has(id)) {
				this.nodeStrokeLayer.removeChild(ring);
				ring.destroy();
				this.strokeRingMap.delete(id);
				this.strokeRingCache.delete(id);
			}
		}

		const bgChannels = hexChannels(c.bgPrimary);

		// Create or update nodes
		for (const node of nodes) {
			let sprite = this.nodeSpriteMap.get(node.id);
			if (!sprite) {
				sprite = new Sprite(this.nodeTexture);
				sprite.anchor.set(0.5);
				// Hit-testing happens in GraphCanvas (findNodeAt), not in Pixi's
				// event system — keeping nodes out of it avoids making every node
				// a hit candidate on every pointer event the viewport processes.
				sprite.eventMode = "none";
				this.nodeLayer.addChild(sprite);
				this.nodeSpriteMap.set(node.id, sprite);
			}

			const alpha = opts.hoverAlphas.get(node.id) ?? 0.85;
			const spawnScale = opts.spawnScales?.get(node.id) ?? 1;
			// Shared formula — must agree with GraphCanvas's getNodeRadius or hover
			// targets drift off the drawn circles. The zoom counter-scale keeps
			// nodes visible when the camera is far out (GraphCanvas applies the
			// same factor to hit-testing and label anchoring).
			const radius = nodeDrawRadius(node, nodeSize) * spawnScale * zoomNodeScale(scale);
			// A tag never joins a topic, so it has no segment colour to carry; it
			// takes the theme's tag colour instead, which is how the eye tells a
			// tag hub from a hub note.
			const rawFill = node.highlighted
				? c.accent
				: node.kind === "tag"
					? c.graphNodeTag
					: (node.color ?? c.graphNode);
			// Resolve hsl()/calc() colors to hex so Pixi.js can parse them
			const resolvedFillColor = rawFill.startsWith("#") ? rawFill : resolveColor(rawFill, c.graphNode);

			// Position, size and color are all uniform updates on the sprite.
			// Blending the tint toward the background rather than using real
			// alpha keeps nodes opaque, so overlapping nodes and the edges
			// underneath don't show through during hover fades.
			sprite.position.set(node.x, node.y);
			sprite.scale.set(radius / NODE_TEXTURE_RADIUS);
			sprite.tint = blendTint(resolvedFillColor, bgChannels, alpha);

			const isSelected = opts.selectedNodes.has(node.id);
			const isHovered = opts.hoveredNodeId === node.id;
			let strokeColor: string | null = null;
			let strokeWidth = 0;
			if (isSelected) {
				strokeColor = c.accent;
				// Same weight as the hover/highlight ring below: the dimming of
				// everything unselected already carries the selection, so this ring
				// only has to confirm it. Heavier, it read as a crust on the node
				// rather than a marker on it, and a large lasso became a wall of rings.
				strokeWidth = 2 / scale;
			} else if (node.highlighted || isHovered) {
				// Accent, matching selection — `textNormal` used to draw this ring, but
				// that's the theme's *maximum* contrast: near-white on dark themes and
				// near-black (#222) on light ones, where it read as a hard black
				// outline rather than a highlight.
				//
				// The exception is hovering an already-highlighted node, which is a
				// normal state rather than a rare one (bridge/isolated highlighting is
				// a persistent property, not a transient). Those nodes are *filled*
				// with accent, so an accent ring on them would vanish into the fill —
				// they take `textMuted`, which contrasts on either theme polarity.
				strokeColor = isHovered && node.highlighted ? c.textMuted : c.accent;
				strokeWidth = 2 / scale;
			}

			let ring = this.strokeRingMap.get(node.id);
			if (strokeColor === null) {
				if (ring) {
					this.nodeStrokeLayer.removeChild(ring);
					ring.destroy();
					this.strokeRingMap.delete(node.id);
					this.strokeRingCache.delete(node.id);
				}
				continue;
			}

			const blendedStrokeColor = alpha < 1 ? blendColor(strokeColor, c.bgPrimary, alpha) : strokeColor;
			if (!ring) {
				ring = new Graphics();
				ring.eventMode = "none";
				this.nodeStrokeLayer.addChild(ring);
				this.strokeRingMap.set(node.id, ring);
			}
			ring.position.set(node.x, node.y);

			const cached = this.strokeRingCache.get(node.id);
			if (
				!cached ||
				cached.radius !== radius ||
				cached.color !== blendedStrokeColor ||
				cached.width !== strokeWidth
			) {
				ring.clear();
				ring.circle(0, 0, radius).stroke({ color: blendedStrokeColor, width: strokeWidth });
				this.strokeRingCache.set(node.id, { radius, color: blendedStrokeColor, width: strokeWidth });
			}
		}
	}

	// ── Hull rendering ─────────────────────────────────────

	/**
	 * Draw a tinted region behind each topic.
	 *
	 * Colour alone makes grouping hard to read once topics interleave — a region
	 * gives each one a visible extent, so hierarchy is legible at any zoom rather
	 * than inferred from dot colours.
	 *
	 * Paths arrive already smoothed and padded in world space
	 * ({@link buildTopicRegion}); this only fills and strokes them.
	 */
	drawHulls(
		hulls: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }>,
		opts: {
			focusedClusters: Set<number>;
			fadeAlpha: number;
			/**
			 * Hull shapes from the previous topic grouping, drawn underneath at
			 * `outgoingAlpha`. Granularity changes reassign every cluster id at once, so
			 * there is no stable identity to tween between — cross-fading the two
			 * sets turns that hard cut into a dissolve.
			 */
			outgoing?: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }>;
			outgoingAlpha?: number;
		},
	): void {
		const g = this.hullGraphics;
		g.clear();

		const outgoing = opts.outgoing ?? [];
		const outgoingAlpha = clampUnitInterval(opts.outgoingAlpha ?? 0, 0);
		if (hulls.length === 0 && outgoing.length === 0) return;

		const c = this._theme;
		const scale = this.viewport.scaled || 1;
		const fade = clampUnitInterval(opts.fadeAlpha, 1);

		const paint = (
			set: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }>,
			multiplier: number,
		) => {
			if (multiplier <= 0) return;
			for (const hull of set) {
				if (hull.path.length < 3) continue;

				// Dim topics outside the focus, matching how nodes and edges behave.
				const isFocused = opts.focusedClusters.size === 0 || opts.focusedClusters.has(hull.cluster);
				const fillAlpha = (isFocused ? 0.1 : 0.02) * fade * multiplier;
				const strokeAlpha = (isFocused ? 0.35 : 0.08) * fade * multiplier;
				if (fillAlpha <= 0 && strokeAlpha <= 0) continue;

				const color = hull.color.startsWith("#") ? hull.color : resolveColor(hull.color, c.accent);

				g.moveTo(hull.path[0].x, hull.path[0].y);
				for (let i = 1; i < hull.path.length; i++) {
					g.lineTo(hull.path[i].x, hull.path[i].y);
				}
				g.closePath();
				g.fill({ color, alpha: fillAlpha });
				// Counter-scale so the outline keeps a constant on-screen weight.
				g.stroke({ color, width: 1.5 / scale, alpha: strokeAlpha });
			}
		};

		// Outgoing first so the incoming grouping reads on top as it resolves.
		paint(outgoing, outgoingAlpha);
		paint(hulls, 1 - outgoingAlpha);
	}

	// ── Edge rendering ─────────────────────────────────────

	/**
	 * Redraw all edges. Called when edges change or hover state changes.
	 */
	drawEdges(
		edges: Array<{
			source: { id: string; x: number; y: number; kind?: string };
			target: { id: string; x: number; y: number; kind?: string };
			type: string;
			weight?: number;
			/**
			 * True when this edge appeared in the latest data change. Only new
			 * edges take the fade-in (`edgeFadeAlpha`) — fading the whole graph on
			 * every change made a one-topic fold flash every edge on screen.
			 */
			isNew?: boolean;
		}>,
		opts: {
			showWikiLinks: boolean;
			showSemanticLinks?: boolean;
			/**
			 * Draw inferred edges in the accent colour rather than `graphLine`, so
			 * the inferred layer can be told from the authored one at overview zoom
			 * (where the dash pattern is too fine to read). Width and alpha are
			 * unchanged — this is a hue swap, not extra emphasis.
			 */
			highlightSemanticLinks?: boolean;
			directedWikiEdges?: boolean;
			hoveredNodeId: string | null;
			adjacency: Map<string, Set<string>>;
			focusedClusters: Set<number>;
			selectedNodes: Set<string>;
			hoverAlphas: Map<string, number>;
			edgeFadeAlpha: number;
			baseEdgeAlpha: number;
			nodeClusterMap: Map<string, number | undefined>;
			/**
			 * World-space rect (view + margin) outside which edges are skipped.
			 * Tessellation is the priciest CPU step of a frame, and when zoomed
			 * into a corner of a large graph most edges land nowhere near the
			 * screen. The caller re-triggers a draw when panning leaves the
			 * margin, so culled edges reappear before scrolling into view.
			 */
			cullRect?: { minX: number; minY: number; maxX: number; maxY: number } | null;
		},
	): void {
		const g = this.edgeGraphics;
		g.clear();

		const showWiki = opts.showWikiLinks;
		const showSemantic = opts.showSemanticLinks !== false;
		// Tag edges are drawn whenever tag nodes are (they only exist then): a
		// tag with no lines to its notes would be a floating label.
		if (!showWiki && !showSemantic && !edges.some((edge) => edge.type === "tag")) return;

		const c = this._theme;
		const scale = this.viewport.scaled || 1;
		const normalWidth = 1.2 / scale;
		const highlightWidth = 1.6 / scale;
		// Inferred edges carry the same colour weight as authored ones — same
		// width, same alpha, same `c.graphLine`. The dash pattern already tells the
		// two apart, so dimming them as well (they were 0.9px at 0.45 alpha) only
		// made them hard to see at all; the inferred structure is worth reading,
		// not just hinting at.
		const semanticWidth = normalWidth;
		// Opt-in (Display → "Highlight inferred links"). Only the colour changes:
		// the inferred layer is often the larger half of the edges, so widening or
		// brightening it as well would bury the authored links it is drawn against.
		const semanticColor = opts.highlightSemanticLinks ? c.accent : c.graphLine;
		const dash = 5 / scale;
		const dashGap = 4 / scale;

		// Dashed segments can't share the batched line buckets (each needs its own
		// sub-path walk), so they collect separately and draw underneath.
		const semanticLineBuckets = new Map<string, Array<{ sx: number; sy: number; tx: number; ty: number }>>();
		// Hovered inferred edges, kept apart so the density fallback below can leave
		// them dashed while the bulk layer goes solid.
		const highlightSemanticLineBuckets = new Map<
			string,
			Array<{ sx: number; sy: number; tx: number; ty: number }>
		>();

		// Loop-invariant: the base alpha is tuned for the overview, lifted as the
		// camera zooms in (where few edges are on screen to crowd each other).
		const safeBaseEdgeAlpha = clampUnitInterval(opts.baseEdgeAlpha * edgeAlphaZoomLift(scale), 0.25);

		// Batch edges by style bucket to minimize draw calls.
		// Key: "color|width|alpha" → list of segments
		const normalLineBuckets = new Map<string, Array<{ sx: number; sy: number; tx: number; ty: number }>>();
		const highlightLineBuckets = new Map<string, Array<{ sx: number; sy: number; tx: number; ty: number }>>();
		const normalArrowBuckets = new Map<
			string,
			Array<{ ax: number; ay: number; lx: number; ly: number; rx: number; ry: number }>
		>();
		const highlightArrowBuckets = new Map<
			string,
			Array<{ ax: number; ay: number; lx: number; ly: number; rx: number; ry: number }>
		>();

		for (const edge of edges) {
			const isSemantic = edge.type === "semantic";
			const isTag = edge.type === "tag";
			const hidden = isSemantic ? !showSemantic : !isTag && !showWiki;
			if (hidden) continue;

			const sx = edge.source.x;
			const sy = edge.source.y;
			const tx = edge.target.x;
			const ty = edge.target.y;
			if (sx == null || sy == null || tx == null || ty == null) continue;

			// Conservative AABB rejection: only skip when the whole segment is
			// on one far side of the rect, so nothing that could touch the view
			// is ever dropped.
			const cull = opts.cullRect;
			if (
				cull &&
				((sx < cull.minX && tx < cull.minX) ||
					(sx > cull.maxX && tx > cull.maxX) ||
					(sy < cull.minY && ty < cull.minY) ||
					(sy > cull.maxY && ty > cull.maxY))
			) {
				continue;
			}

			const sourceCluster = opts.nodeClusterMap.get(edge.source.id);
			const targetCluster = opts.nodeClusterMap.get(edge.target.id);

			const inFocus =
				opts.focusedClusters.size === 0 ||
				(sourceCluster != null && opts.focusedClusters.has(sourceCluster)) ||
				(targetCluster != null && opts.focusedClusters.has(targetCluster));

			const inSelection =
				opts.selectedNodes.size === 0 ||
				(opts.selectedNodes.has(edge.source.id) && opts.selectedNodes.has(edge.target.id));

			const isHighlighted =
				opts.hoveredNodeId != null &&
				(edge.source.id === opts.hoveredNodeId || edge.target.id === opts.hoveredNodeId);

			const edgeHoverAlpha = opts.hoveredNodeId
				? clampUnitInterval(
						Math.max(
							opts.hoverAlphas.get(edge.source.id) ?? 0.85,
							opts.hoverAlphas.get(edge.target.id) ?? 0.85,
						),
						0.85,
					)
				: 1;
			// Pre-existing edges stay at full opacity through a data change; only
			// edges born in it fade in, so the eye is drawn to what changed.
			const safeEdgeFadeAlpha = edge.isNew ? clampUnitInterval(opts.edgeFadeAlpha, 1) : 1;

			const rawAlpha =
				(!inFocus ? 0.05 : !inSelection ? 0.05 : isHighlighted ? 0.9 : safeBaseEdgeAlpha) *
				safeEdgeFadeAlpha *
				(isHighlighted ? 1 : edgeHoverAlpha / 0.85);

			// Quantize alpha to reduce unique buckets (round to nearest 0.05)
			const alpha = clampUnitInterval(Math.round(rawAlpha * 20) / 20, 0);
			if (alpha <= 0) continue;

			const color = isHighlighted ? c.accent : isSemantic ? semanticColor : c.graphLine;
			const baseWidth = isHighlighted ? highlightWidth : isSemantic ? semanticWidth : normalWidth;
			// A collapsed topic edge's weight counts how many note-level links cross
			// between the two topics, so thickness is the at-a-glance read of which
			// areas of the vault are actually coupled. Log-scaled: crossing counts
			// are heavy-tailed and a linear map would leave weak pairs invisible.
			const isTopicEdge = edge.source.kind === "topic" || edge.target.kind === "topic";
			const weightScale = isTopicEdge ? Math.min(4, 1 + Math.log2(Math.max(1, edge.weight ?? 1)) * 0.45) : 1;
			const width = baseWidth * weightScale;
			const key = `${color}|${width.toFixed(4)}|${alpha.toFixed(2)}`;

			if (isSemantic) {
				// Hovered inferred edges keep their dashes even when the rest of the
				// layer has fallen back to solid: a hover reveals a handful of edges,
				// so the per-dash cost is trivial there, and it's the one moment the
				// user is asking "authored or inferred?" about a specific connection.
				const target = isHighlighted ? highlightSemanticLineBuckets : semanticLineBuckets;
				let semanticBucket = target.get(key);
				if (!semanticBucket) {
					semanticBucket = [];
					target.set(key, semanticBucket);
				}
				semanticBucket.push({ sx, sy, tx, ty });
				// Arrowheads denote authored direction; an inferred similarity has none.
				continue;
			}

			const targetLineBuckets = isHighlighted ? highlightLineBuckets : normalLineBuckets;
			let bucket = targetLineBuckets.get(key);
			if (!bucket) {
				bucket = [];
				targetLineBuckets.set(key, bucket);
			}
			bucket.push({ sx, sy, tx, ty });

			// Arrowheads mark an authored link's direction; carrying a tag has none.
			if (opts.directedWikiEdges && !isTag) {
				const dx = tx - sx;
				const dy = ty - sy;
				const len = Math.hypot(dx, dy);
				if (len > 0.0001) {
					const ux = dx / len;
					const uy = dy / len;
					const arrowLength = isHighlighted ? Math.max(7 / scale, width * 5) : 11;
					const arrowWidth = isHighlighted ? Math.max(4 / scale, width * 2.6) : 5.5;
					const tipInset = isHighlighted ? Math.max(width * 1.5, 2 / scale) : 3;
					const ax = tx - ux * tipInset;
					const ay = ty - uy * tipInset;
					const baseX = ax - ux * arrowLength;
					const baseY = ay - uy * arrowLength;
					const perpX = -uy;
					const perpY = ux;
					const targetArrowBuckets = isHighlighted ? highlightArrowBuckets : normalArrowBuckets;
					let arrows = targetArrowBuckets.get(key);
					if (!arrows) {
						arrows = [];
						targetArrowBuckets.set(key, arrows);
					}
					arrows.push({
						ax,
						ay,
						lx: baseX + perpX * arrowWidth,
						ly: baseY + perpY * arrowWidth,
						rx: baseX - perpX * arrowWidth,
						ry: baseY - perpY * arrowWidth,
					});
				}
			}
		}

		const drawLineBuckets = (buckets: Map<string, Array<{ sx: number; sy: number; tx: number; ty: number }>>) => {
			for (const [key, segments] of buckets) {
				const [color, widthStr, alphaStr] = key.split("|");
				const width = Number(widthStr);
				const alpha = Number(alphaStr);

				for (const seg of segments) {
					g.moveTo(seg.sx, seg.sy);
					g.lineTo(seg.tx, seg.ty);
				}
				g.stroke({ color, width, alpha });
			}
		};

		const drawArrowBuckets = (
			buckets: Map<string, Array<{ ax: number; ay: number; lx: number; ly: number; rx: number; ry: number }>>,
		) => {
			for (const [key, arrows] of buckets) {
				const [color, , alphaStr] = key.split("|");
				const alpha = Number(alphaStr);
				for (const arrow of arrows) {
					g.moveTo(arrow.ax, arrow.ay);
					g.lineTo(arrow.lx, arrow.ly);
					g.lineTo(arrow.rx, arrow.ry);
					g.closePath();
				}
				g.fill({ color, alpha });
			}
		};

		const drawDashedBuckets = (
			buckets: Map<string, Array<{ sx: number; sy: number; tx: number; ty: number }>>,
			/** Draw dashes regardless of density — used for the few hovered edges. */
			alwaysDash = false,
		) => {
			// Past the limit, dashes cost more than they communicate — draw the
			// whole inferred layer as quieter solid strokes instead (see
			// SEMANTIC_DASH_EDGE_LIMIT).
			let totalEdges = 0;
			for (const segments of buckets.values()) totalEdges += segments.length;
			const asSolid = !alwaysDash && totalEdges > SEMANTIC_DASH_EDGE_LIMIT;

			for (const [key, segments] of buckets) {
				const [color, widthStr, alphaStr] = key.split("|");
				const width = Number(widthStr);
				const alpha = Number(alphaStr);

				if (asSolid) {
					for (const seg of segments) {
						g.moveTo(seg.sx, seg.sy);
						g.lineTo(seg.tx, seg.ty);
					}
					g.stroke({ color, width, alpha: alpha * SEMANTIC_SOLID_ALPHA_SCALE });
					continue;
				}

				for (const seg of segments) {
					drawDashedLine(g, seg.sx, seg.sy, seg.tx, seg.ty, dash, dashGap);
				}
				g.stroke({ color, width, alpha });
			}
		};

		// Inferred edges sit underneath, then authored links, then hovered connections
		// last so dim edges/arrows never sit on top of them.
		drawDashedBuckets(semanticLineBuckets);
		drawLineBuckets(normalLineBuckets);
		if (opts.directedWikiEdges) {
			drawArrowBuckets(normalArrowBuckets);
		}
		drawLineBuckets(highlightLineBuckets);
		// Hovered inferred edges join the highlighted tier, still dashed.
		drawDashedBuckets(highlightSemanticLineBuckets, true);
		if (opts.directedWikiEdges) {
			drawArrowBuckets(highlightArrowBuckets);
		}
	}

	// ── Label rendering ────────────────────────────────────

	/**
	 * Update visible labels using the object pool.
	 * Caller provides the list of nodes that should have labels, already
	 * sorted by priority and filtered by occlusion.
	 */
	drawLabels(
		labels: Array<{
			nodeX: number;
			nodeY: number;
			text: string;
			color: string;
			alpha: number;
			fontSize: number;
		}>,
	): void {
		const scale = this.viewport.scaled || 1;
		const invScale = 1 / scale;
		const font = this._theme.font;
		let i = 0;

		for (const label of labels) {
			if (i >= this.LABEL_POOL_SIZE) break;
			const t = this.labelPool[i];
			const prev = this.labelPoolCache[i];

			// Position and scale change every force-tick — always update these
			t.position.set(label.nodeX, label.nodeY);
			t.scale.set(invScale);
			t.alpha = label.alpha;
			t.visible = true;

			// Text and style only change when the label itself changes
			if (
				prev === null ||
				prev.text !== label.text ||
				prev.fontSize !== label.fontSize ||
				prev.color !== label.color
			) {
				t.text = label.text;
				t.style.fontSize = label.fontSize;
				t.style.fill = label.color;
				t.style.fontFamily = font;
			}

			this.labelPoolCache[i] = {
				text: label.text,
				nodeX: label.nodeX,
				nodeY: label.nodeY,
				fontSize: label.fontSize,
				color: label.color,
				alpha: label.alpha,
				scale: invScale,
			};
			i++;
		}

		// Hide pool slots that were active last frame but aren't needed now
		const prevActive = this.activeLabelCount;
		for (let j = i; j < prevActive; j++) {
			this.labelPool[j].visible = false;
			this.labelPoolCache[j] = null;
		}
		this.activeLabelCount = i;
	}

	// ── Lasso rendering ────────────────────────────────────

	drawLasso(points: Array<{ x: number; y: number }>): void {
		const g = this.lassoGraphics;
		g.clear();
		if (points.length < 2) return;

		const c = this._theme;
		const scale = this.viewport.scaled || 1;

		// Fill
		const flatPoints = points.flatMap((p) => [p.x, p.y]);
		g.poly(flatPoints, true).fill({ color: c.accent, alpha: 0.08 });

		// Dashed stroke
		const dash = 4 / scale;
		const gap = 4 / scale;
		for (let i = 0; i < points.length; i++) {
			const a = points[i];
			const b = points[(i + 1) % points.length];
			drawDashedLine(g, a.x, a.y, b.x, b.y, dash, gap);
		}
		g.stroke({ color: c.accent, width: 2 / scale, alpha: 0.6 });
	}

	clearLasso(): void {
		this.lassoGraphics.clear();
	}

	// ── Cluster anchor pills (screen-space) ────────────────

	drawClusterPills(
		placements: Array<{
			cluster: number;
			nodeScreenX: number;
			nodeScreenY: number;
			x: number;
			y: number;
			pillW: number;
			pillH: number;
			text: string;
			color: string;
			isFocused: boolean;
		}>,
	): ClusterPillHit[] {
		const c = this._theme;
		const hitAreas: ClusterPillHit[] = [];

		// Ensure we have enough pill objects
		while (this.clusterPillObjects.length < placements.length) {
			const container = new Container();
			const graphics = new Graphics();
			const text = new Text({
				text: "",
				style: new TextStyle({
					fontFamily: c.font,
					fontSize: 11,
					fontWeight: "600",
					fill: c.textNormal,
				}),
			});
			text.anchor.set(0, 0.5);
			container.addChild(graphics);
			container.addChild(text);
			this.clusterPillLayer.addChild(container);
			this.clusterPillObjects.push({ container, graphics, text });
		}

		// Hide excess
		for (let i = placements.length; i < this.clusterPillObjects.length; i++) {
			this.clusterPillObjects[i].container.visible = false;
		}

		for (let i = 0; i < placements.length; i++) {
			const p = placements[i];
			const obj = this.clusterPillObjects[i];
			obj.container.visible = true;
			// Dim the whole pill — background, border and text together — so an
			// unfocused label stays readable enough to Shift-click without competing
			// with the selection. Per-element alpha would leave the text at full
			// strength, which is the part that actually reads.
			obj.container.alpha = p.isFocused ? 1 : 0.45;

			const g = obj.graphics;
			g.clear();

			// Resolve cluster color to hex for Pixi
			const pillColor = p.color.startsWith("#") ? p.color : resolveColor(p.color, c.accent);

			// Leader line (dashed) if pill drifted from node
			const pillCenterX = p.x + p.pillW / 2;
			const pillCenterY = p.y + p.pillH / 2;
			const dist = Math.sqrt((pillCenterX - p.nodeScreenX) ** 2 + (pillCenterY - p.nodeScreenY) ** 2);
			if (dist > p.pillW * 0.6) {
				drawDashedLine(g, pillCenterX, pillCenterY, p.nodeScreenX, p.nodeScreenY, 3, 3);
				g.stroke({ color: pillColor, width: 0.75, alpha: p.isFocused ? 0.5 : 0.25 });
			}

			// Pill background
			g.roundRect(p.x, p.y, p.pillW, p.pillH, 999);
			g.fill({ color: c.bgPrimary, alpha: p.isFocused ? 0.96 : 0.88 });
			g.stroke({ color: pillColor, width: p.isFocused ? 1.75 : 1 });

			// Text
			obj.text.text = p.text;
			obj.text.style.fill = c.textNormal;
			obj.text.style.fontFamily = c.font;
			obj.text.position.set(p.x + 8, p.y + p.pillH / 2 + 0.5);

			// Truncate text if needed
			const maxTextW = p.pillW - 16;
			if (obj.text.width > maxTextW) {
				// Simple truncation via Pixi — adjust text
				let txt = p.text;
				while (txt.length > 1) {
					txt = txt.slice(0, -1);
					obj.text.text = `${txt}…`;
					if (obj.text.width <= maxTextW) break;
				}
			}

			hitAreas.push({ x: p.x, y: p.y, w: p.pillW, h: p.pillH, cluster: p.cluster });
		}

		return hitAreas;
	}

	// ── Node tooltip (screen-space) ────────────────────────

	showNodeTooltip(
		node: {
			label: string;
			cluster?: number;
			degree?: number;
			id: string;
			x: number;
			y: number;
			kind?: string;
			memberPaths?: string[];
		},
		clusterLabels: Record<number, string>,
		isPinned: boolean,
		isForceMode: boolean,
	): void {
		const c = this._theme;
		const screen = this.viewport.toScreen(node.x, node.y);

		const lines: string[] = [node.label];
		if (node.kind === "topic") {
			// A collapsed topic's size says how many notes it holds; its `degree`
			// is the number of note-level links crossing its boundary (set by
			// buildCollapsedGraph). Report both — the bubble encodes only the first.
			const notes = node.memberPaths?.length ?? 0;
			const links = node.degree ?? 0;
			lines.push(
				`${notes.toLocaleString()} ${notes === 1 ? "note" : "notes"}  ·  ${links.toLocaleString()} ${links === 1 ? "link" : "links"}`,
			);
		} else if (node.kind === "tag") {
			const notes = node.degree ?? 0;
			lines.push(`${notes.toLocaleString()} ${notes === 1 ? "note" : "notes"}`);
		} else if (node.cluster != null) {
			const clusterLabel = clusterLabels[node.cluster] ?? `Cluster ${node.cluster}`;
			lines.push(`${clusterLabel}  ·  ${node.degree ?? 0} connections`);
		} else {
			lines.push(`${node.degree ?? 0} connections`);
		}
		if (isForceMode && isPinned) {
			lines.push("📌 Pinned");
		}

		const fontSize = 11;
		const lineH = 16;
		const padX = 10;
		const padY = 8;

		// Re-rasterize text and remeasure the box only when the content changed.
		// While hovering, this runs every frame with identical lines, so the
		// steady-state cost is just moving the container. Contents are drawn at
		// the container's origin so position updates never touch the layout.
		const layoutKey = lines.join("\n");
		if (layoutKey !== this._tooltipLayoutKey) {
			this._tooltipLayoutKey = layoutKey;

			let maxW = 0;
			for (let i = 0; i < lines.length && i < this.tooltipTexts.length; i++) {
				this.tooltipTexts[i].text = lines[i];
				this.tooltipTexts[i].style.fontSize = fontSize;
				this.tooltipTexts[i].style.fontWeight = i === 0 ? "bold" : "normal";
				this.tooltipTexts[i].style.fill = i === 0 ? c.textNormal : c.textMuted;
				this.tooltipTexts[i].visible = true;
				this.tooltipTexts[i].position.set(padX, padY + i * lineH);
				const w = this.tooltipTexts[i].width;
				if (w > maxW) maxW = w;
			}
			// Hide unused lines
			for (let i = lines.length; i < this.tooltipTexts.length; i++) {
				this.tooltipTexts[i].visible = false;
			}

			this._tooltipBoxW = maxW + padX * 2;
			this._tooltipBoxH = lines.length * lineH + padY * 2;

			this.tooltipGraphics.clear();
			this.tooltipGraphics.roundRect(0, 0, this._tooltipBoxW, this._tooltipBoxH, 6);
			this.tooltipGraphics.fill({ color: c.bgPrimary, alpha: 0.92 });
			this.tooltipGraphics.stroke({ color: c.textFaint, width: 0.5 });
		}

		// Position: right of node, flip if near edge
		let bx = screen.x + 14;
		if (bx + this._tooltipBoxW > this._width - 8) bx = screen.x - this._tooltipBoxW - 14;
		this.tooltipContainer.position.set(bx, screen.y - this._tooltipBoxH / 2);
		this.tooltipContainer.visible = true;
	}

	hideTooltip(): void {
		this.tooltipContainer.visible = false;
	}

	// ── World-to-screen conversion ─────────────────────────

	worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
		const pt = this.viewport.toScreen(worldX, worldY);
		return { x: pt.x, y: pt.y };
	}
}
