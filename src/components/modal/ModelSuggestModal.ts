import { SuggestModal, setIcon } from "obsidian";
import type { App } from "obsidian";
import { MODEL_CAPABILITY_ICONS } from "../../lib/modelCapabilityIcons";
import { stripVendorPrefix } from "../../lib/modelMetadataNormalizer";
import { extractVendor } from "../../lib/modelVendorClassification";
import type { UiClassifiableModel } from "../../lib/modelVendorClassification";
import { createVendorLogoElement, VENDOR_CATALOG } from "../../lib/vendorLogoSvg";
import { getProviderDefinition } from "../../providers/index";
import { getData } from "../../stores/dataStore.svelte";
import type { HydratedChatModelMetadata, HydratedEmbeddingModelMetadata } from "../../types/modelMetadata";
import type { ModelType, SelectedModel } from "./ModelSelectionModal";
import { applyPromptSafeArea } from "./promptLayout";

type HydratedModel = HydratedChatModelMetadata | HydratedEmbeddingModelMetadata;

function formatCost(costPer1M?: number): string {
	if (costPer1M === undefined) return "—";
	if (costPer1M === 0) return "Free";
	if (costPer1M < 0.01) return `$${costPer1M.toFixed(4)}`;
	return `$${costPer1M.toFixed(2)}`;
}

function formatTokenLimit(tokens?: number): string {
	if (!tokens) return "—";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return tokens.toString();
}

/**
 * Mobile model picker.
 *
 * On a phone Obsidian styles `SuggestModal` (`.prompt`) natively: the input is
 * pinned directly above the keyboard, results flow upward from it, and the
 * sheet fills the screen. That keyboard tracking is handled by the host — it is
 * the reason this exists as a separate class rather than as more `.is-mobile`
 * overrides on the desktop Svelte modal, which floats mid-screen and cannot
 * follow the keyboard without re-solving the problem in
 * `reference_obsidian_native_keyboard_css_vars`.
 *
 * Search is the primary interaction here (installs routinely discover 400+
 * models), so a search-first surface fits the task better than a scrolling grid.
 * The desktop modal is untouched.
 */
export class ModelSuggestModal extends SuggestModal<HydratedModel> {
	private readonly models: HydratedModel[];
	private readonly currentSelection: SelectedModel | null;
	private readonly onSelectModel: (model: SelectedModel | null) => void;
	private readonly openRouterModels: Map<string, unknown> | null;
	private readonly pluginData = getData();

	/** Active vendor filter, or null for "all". Mirrors the desktop rail. */
	private selectedVendor: string | null = null;
	private showFavorites = false;
	private filterBarEl: HTMLElement | null = null;

	constructor(
		app: App,
		modelType: ModelType,
		models: HydratedModel[],
		currentSelection: SelectedModel | null,
		openRouterModels: Map<string, unknown> | null,
		onSelectModel: (model: SelectedModel | null) => void,
	) {
		super(app);
		this.models = models;
		this.currentSelection = currentSelection;
		this.onSelectModel = onSelectModel;
		this.openRouterModels = openRouterModels;

		this.modalEl.addClass("s2b-model-suggest-modal");
		this.setPlaceholder(modelType === "chat" ? "Search chat models…" : "Search embedding models…");
		this.limit = 200;
	}

	onOpen(): void {
		void super.onOpen();
		this.buildFilterBar();
		applyPromptSafeArea(this.modalEl);
	}

	private toClassifiable(model: HydratedModel): UiClassifiableModel {
		const providerMeta = this.pluginData.getProviderMeta(model.provider);
		const providerAuth = this.pluginData.getResolvedProviderAuth(model.provider);
		return {
			provider: model.provider,
			model: model.variantKey,
			templateId: providerMeta?.templateId,
			baseUrl: providerAuth.baseUrl,
		};
	}

	private vendorOf(model: HydratedModel): string | null {
		return extractVendor(this.toClassifiable(model), this.openRouterModels as Parameters<typeof extractVendor>[1]);
	}

	private getProviderDisplayName(providerId: string): string {
		return getProviderDefinition(providerId, this.pluginData.getAllProviderMeta())?.displayName ?? providerId;
	}

	/**
	 * Filter strip above the input. `SuggestModal` has no slot for this, so it
	 * is inserted after the input container — the same approach the search
	 * modal uses for its mobile action bar.
	 */
	private buildFilterBar(): void {
		const inputContainer = this.modalEl.querySelector<HTMLElement>(".prompt-input-container");
		if (!inputContainer) return;

		const presentVendors = new Set<string>();
		for (const model of this.models) {
			const vendor = this.vendorOf(model);
			if (vendor) presentVendors.add(vendor);
		}

		const bar = createDiv();
		bar.className = "s2b-model-filter-bar";

		const favBtn = createEl("button");
		favBtn.type = "button";
		favBtn.className = "s2b-pill s2b-pill--interactive s2b-model-filter-fav";
		const favIcon = createSpan();
		favIcon.className = "s2b-model-filter-icon";
		setIcon(favIcon, "star");
		favBtn.appendChild(favIcon);
		favBtn.appendChild(document.createTextNode("Favorites"));
		// Favorites and a vendor combine ("my favourite Qwen models"), matching
		// the desktop modal's filter algebra — the two surfaces used to disagree.
		favBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.showFavorites = !this.showFavorites;
			this.refreshFilterBar();
			this.rerunSearch();
		});
		bar.appendChild(favBtn);

		for (const vendor of VENDOR_CATALOG) {
			if (!presentVendors.has(vendor.id)) continue;
			const btn = createEl("button");
			btn.type = "button";
			btn.className = "s2b-pill s2b-pill--interactive";
			btn.dataset.vendorId = vendor.id;
			// Same artwork the rows use. Only the labs in VENDOR_CATALOG have
			// logos, so a miss falls back to the bare name rather than a
			// placeholder glyph — matches `renderSuggestion`. The marks are
			// monochrome `currentColor` glyphs, so they follow the pill's own
			// colour (muted at rest, accent while active) alongside the label.
			const vendorLogo = createVendorLogoElement(vendor.id);
			if (vendorLogo) {
				const logoWrap = createSpan();
				logoWrap.className = "s2b-model-filter-icon s2b-model-filter-icon--vendor";
				logoWrap.appendChild(vendorLogo);
				btn.appendChild(logoWrap);
			}
			btn.appendChild(document.createTextNode(vendor.name));
			btn.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.selectedVendor = this.selectedVendor === vendor.id ? null : vendor.id;
				this.refreshFilterBar();
				this.rerunSearch();
			});
			bar.appendChild(btn);
		}

		inputContainer.insertAdjacentElement("afterend", bar);
		this.filterBarEl = bar;
		this.refreshFilterBar();
	}

	private refreshFilterBar(): void {
		const bar = this.filterBarEl;
		if (!bar) return;
		bar.querySelector(".s2b-model-filter-fav")?.toggleClass("s2b-pill--active", this.showFavorites);
		for (const btn of Array.from(bar.querySelectorAll<HTMLElement>("[data-vendor-id]"))) {
			btn.toggleClass("s2b-pill--active", btn.dataset.vendorId === this.selectedVendor);
		}
	}

	/** Re-run the current query so a filter change takes effect immediately. */
	private rerunSearch(): void {
		const input = this.modalEl.querySelector<HTMLInputElement>(".prompt-input");
		if (input) input.dispatchEvent(new Event("input"));
	}

	getSuggestions(query: string): HydratedModel[] {
		const needle = query.trim().toLowerCase();

		return this.models.filter((model) => {
			if (this.showFavorites && !this.pluginData.isFavoriteModel(model.provider, model.variantKey)) {
				return false;
			}
			if (this.selectedVendor && this.vendorOf(model) !== this.selectedVendor) {
				return false;
			}
			if (!needle) return true;
			return (
				model.displayName.toLowerCase().includes(needle) ||
				model.variantKey.toLowerCase().includes(needle) ||
				this.getProviderDisplayName(model.provider).toLowerCase().includes(needle)
			);
		});
	}

	renderSuggestion(model: HydratedModel, el: HTMLElement): void {
		el.addClass("s2b-model-suggestion");
		const isSelected =
			this.currentSelection?.provider === model.provider && this.currentSelection?.model === model.variantKey;
		el.toggleClass("s2b-model-suggestion--selected", isSelected);

		const header = el.createDiv({ cls: "s2b-model-suggestion-header" });

		// Catalogue names are prefixed with the lab ("Qwen: Qwen3.8 Max"). When
		// we have that lab's artwork the prefix is redundant — show the logo and
		// the bare name. Most labs have no logo, so the prefix stays as text
		// there rather than collapsing them all into one anonymous glyph.
		const vendor = this.vendorOf(model);
		const logo = createVendorLogoElement(vendor);
		const name = logo ? stripVendorPrefix(model.displayName) : model.displayName;

		if (logo) {
			const logoWrap = header.createSpan({ cls: "s2b-model-suggestion-logo" });
			logoWrap.appendChild(logo);
		}

		const info = header.createDiv({ cls: "s2b-model-suggestion-info" });
		info.createDiv({ text: name, cls: "s2b-model-suggestion-name" });

		const actions = header.createDiv({ cls: "s2b-model-suggestion-actions" });
		const isFavorite = this.pluginData.isFavoriteModel(model.provider, model.variantKey);
		// `clickable-icon` is Obsidian's own icon-button class: transparent at
		// rest, `--background-modifier-hover` on press. Without it the bare
		// <button> keeps the host's default background and reads as permanently
		// highlighted.
		const favBtn = actions.createEl("button", { cls: "clickable-icon s2b-model-suggestion-fav" });
		favBtn.type = "button";
		favBtn.toggleClass("is-favorite", isFavorite);
		favBtn.setAttribute("aria-label", isFavorite ? "Remove from favorites" : "Add to favorites");
		favBtn.setAttribute("aria-pressed", String(isFavorite));
		setIcon(favBtn, "star");
		// The row itself selects the model, so the star must not bubble.
		favBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.pluginData.toggleFavoriteModel(model.provider, model.variantKey);
			const nowFavorite = this.pluginData.isFavoriteModel(model.provider, model.variantKey);
			favBtn.toggleClass("is-favorite", nowFavorite);
			favBtn.setAttribute("aria-pressed", String(nowFavorite));
			favBtn.setAttribute("aria-label", nowFavorite ? "Remove from favorites" : "Add to favorites");
		});

		if (isSelected) {
			// A real check icon rather than the "✓" character, which renders
			// differently per platform font.
			const check = actions.createSpan({ cls: "s2b-model-suggestion-check" });
			check.setAttribute("aria-hidden", "true");
			setIcon(check, "check");
		}

		const meta = el.createDiv({ cls: "s2b-model-suggestion-meta" });
		const tag = (text: string, extraCls?: string) =>
			meta.createSpan({ text, cls: `s2b-model-suggestion-tag${extraCls ? ` ${extraCls}` : ""}` });
		const iconTag = (icon: string, label: string) => {
			const span = meta.createSpan({ cls: "s2b-model-suggestion-tag capability" });
			span.setAttribute("title", label);
			span.setAttribute("aria-label", label);
			setIcon(span, icon);
		};

		tag(this.getProviderDisplayName(model.provider), "s2b-model-suggestion-tag--provider");

		if (model.kind === "chat") {
			tag(`${formatTokenLimit(model.contextWindow)} ctx`);
			if (model.pricing?.inputUsdPer1M !== undefined || model.pricing?.outputUsdPer1M !== undefined) {
				tag(`${formatCost(model.pricing?.inputUsdPer1M)}/${formatCost(model.pricing?.outputUsdPer1M)}`);
			}
			if (model.capabilities.toolCalls)
				iconTag(MODEL_CAPABILITY_ICONS.toolCalls.icon, MODEL_CAPABILITY_ICONS.toolCalls.label);
			if (model.capabilities.reasoning)
				iconTag(MODEL_CAPABILITY_ICONS.reasoning.icon, MODEL_CAPABILITY_ICONS.reasoning.label);
			if (model.capabilities.vision)
				iconTag(MODEL_CAPABILITY_ICONS.vision.icon, MODEL_CAPABILITY_ICONS.vision.label);
			if (model.capabilities.structuredOutput)
				iconTag(MODEL_CAPABILITY_ICONS.structuredOutput.icon, MODEL_CAPABILITY_ICONS.structuredOutput.label);
		} else {
			tag(`${formatTokenLimit(model.maxInputTokens)} max input`);
			if (model.pricing?.inputUsdPer1M !== undefined) {
				tag(formatCost(model.pricing.inputUsdPer1M));
			}
		}
	}

	onChooseSuggestion(model: HydratedModel): void {
		this.onSelectModel({ provider: model.provider, model: model.variantKey });
	}
}
