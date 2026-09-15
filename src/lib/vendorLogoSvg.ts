import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import AnthropicLogo from "../components/ui/logos/AnthropicLogo.svelte";
import BaiduLogo from "../components/ui/logos/BaiduLogo.svelte";
import ByteDanceLogo from "../components/ui/logos/ByteDanceLogo.svelte";
import DeepSeekLogo from "../components/ui/logos/DeepSeekLogo.svelte";
import GoogleLogo from "../components/ui/logos/GoogleLogo.svelte";
import KuaishouLogo from "../components/ui/logos/KuaishouLogo.svelte";
import MeituanLogo from "../components/ui/logos/MeituanLogo.svelte";
import MetaLogo from "../components/ui/logos/MetaLogo.svelte";
import MicrosoftLogo from "../components/ui/logos/MicrosoftLogo.svelte";
import MiniMaxLogo from "../components/ui/logos/MiniMaxLogo.svelte";
import MistralLogo from "../components/ui/logos/MistralLogo.svelte";
import MoonshotLogo from "../components/ui/logos/MoonshotLogo.svelte";
import NvidiaLogo from "../components/ui/logos/NvidiaLogo.svelte";
import OpenAILogo from "../components/ui/logos/OpenAILogo.svelte";
import OpenRouterLogo from "../components/ui/logos/OpenRouterLogo.svelte";
import PerplexityLogo from "../components/ui/logos/PerplexityLogo.svelte";
import QwenLogo from "../components/ui/logos/QwenLogo.svelte";
import TencentLogo from "../components/ui/logos/TencentLogo.svelte";
import XAILogo from "../components/ui/logos/XAILogo.svelte";
import XiaomiLogo from "../components/ui/logos/XiaomiLogo.svelte";
import ZaiLogo from "../components/ui/logos/ZaiLogo.svelte";

export type VendorLogoComponent = Component<{ width?: number; height?: number; class?: string }>;

/**
 * Every vendor with artwork, in the display order the filter surfaces use.
 * Single source of truth shared by the desktop modal's vendor rail and the
 * mobile suggest modal's filter strip — the two lists drifted apart when they
 * were maintained separately. Catalogues carry a long tail of labs and
 * community finetuners beyond these (Poolside, Sakana, Cohere, TheDrummer…),
 * so callers must handle a miss rather than assuming a logo exists.
 */
export const VENDOR_CATALOG: ReadonlyArray<{ id: string; name: string; logo: VendorLogoComponent }> = [
	{ id: "openai", name: "OpenAI", logo: OpenAILogo },
	{ id: "anthropic", name: "Anthropic", logo: AnthropicLogo },
	{ id: "google", name: "Google", logo: GoogleLogo },
	{ id: "microsoft", name: "Microsoft", logo: MicrosoftLogo },
	{ id: "meta-llama", name: "Meta", logo: MetaLogo },
	{ id: "deepseek", name: "DeepSeek", logo: DeepSeekLogo },
	{ id: "x-ai", name: "xAI", logo: XAILogo },
	{ id: "mistralai", name: "Mistral", logo: MistralLogo },
	{ id: "qwen", name: "Qwen", logo: QwenLogo },
	{ id: "z-ai", name: "Z.ai", logo: ZaiLogo },
	{ id: "minimax", name: "MiniMax", logo: MiniMaxLogo },
	{ id: "nvidia", name: "NVIDIA", logo: NvidiaLogo },
	{ id: "moonshotai", name: "Moonshot AI", logo: MoonshotLogo },
	{ id: "tencent", name: "Tencent", logo: TencentLogo },
	{ id: "bytedance-seed", name: "ByteDance", logo: ByteDanceLogo },
	{ id: "openrouter", name: "OpenRouter", logo: OpenRouterLogo },
	{ id: "perplexity", name: "Perplexity", logo: PerplexityLogo },
	{ id: "kwaipilot", name: "Kuaishou", logo: KuaishouLogo },
	{ id: "xiaomi", name: "Xiaomi", logo: XiaomiLogo },
	{ id: "meituan", name: "Meituan", logo: MeituanLogo },
	{ id: "baidu", name: "Baidu", logo: BaiduLogo },
];

const VENDOR_LOGO_COMPONENTS: Record<string, VendorLogoComponent> = Object.fromEntries(
	VENDOR_CATALOG.map((vendor) => [vendor.id, vendor.logo]),
);

/**
 * A prototype `<svg>` element per vendor, built on first request.
 *
 * The logos are Svelte components but the mobile model picker is a plain
 * `SuggestModal` that re-renders hundreds of rows per keystroke. Mounting a
 * component per row would be wasteful, so each logo is mounted once into a
 * detached node and the resulting element cached; callers get clones of it.
 *
 * The cache holds the element rather than its serialized markup so handing out
 * a clone never has to reparse a string — `cloneNode` copies the live node
 * directly, and no `innerHTML` write is involved.
 */
const svgCache = new Map<string, SVGElement | null>();

function renderVendorLogoSvg(vendorId: string): SVGElement | null {
	const LogoComponent = VENDOR_LOGO_COMPONENTS[vendorId];
	if (!LogoComponent) return null;

	const host = createDiv();
	const instance = mount(LogoComponent, {
		target: host,
		props: { width: 16, height: 16 },
	});
	const svg = host.querySelector("svg");
	// Detach before unmounting so Svelte's cleanup cannot touch the node we keep.
	svg?.remove();
	void unmount(instance);
	return svg;
}

/**
 * A detached `<svg>` element for the vendor, or null when unknown. Each call
 * returns a fresh clone, so the result can be inserted straight into the DOM.
 */
export function createVendorLogoElement(vendorId: string | null | undefined): SVGElement | null {
	if (!vendorId || !(vendorId in VENDOR_LOGO_COMPONENTS)) return null;

	if (!svgCache.has(vendorId)) {
		svgCache.set(vendorId, renderVendorLogoSvg(vendorId));
	}

	const prototype = svgCache.get(vendorId);
	return prototype ? (prototype.cloneNode(true) as SVGElement) : null;
}
