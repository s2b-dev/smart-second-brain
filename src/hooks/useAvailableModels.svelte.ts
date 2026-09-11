import { Notice } from "obsidian";
import { invalidateAllProviders, type ProviderState, subscribeProviderState } from "../lib/query";
import { hydrateChatModel, hydrateEmbeddingModel } from "../lib/modelMetadataNormalizer";
import { fetchModelsDevData, type ModelsDevApiResponse } from "../providers/modelsDevApi";
import { getOllamaModelsCache, type OllamaModelInfo } from "../providers/ollamaModels";
import { fetchOpenRouterModels, type OpenRouterModelInfo } from "../providers/openrouterModels";
import { getProviderDefinition, isEmbeddingProvider } from "../providers/index";
import { onProvidersChanged } from "../providers/registrySync";
import type { EmbedModelConfig } from "../providers/index";
import type { ChatModel } from "../stores/chatTimeline";
import { getData } from "../stores/dataStore.svelte";
import { getPlugin, requestSettingsTab } from "../stores/state.svelte";
import { ProviderSetupModal } from "../views/provider-setup/ProviderSetup";
import type { HydratedChatModelMetadata, HydratedEmbeddingModelMetadata } from "../types/modelMetadata";

export interface ModelOption {
	value: string;
	label: string;
	chatModel: ChatModel;
}

export interface EmbedModelOption {
	value: string;
	label: string;
	embedModel: EmbedModel;
}

export interface EmbedModel {
	model: string;
	provider: string;
	modelConfig: EmbedModelConfig;
}

/** Default context window when models.dev lookup fails */
const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Heuristic to detect embedding models by name.
 * Embedding models typically have "embed" in their name or follow known patterns.
 */
function isLikelyEmbeddingModel(modelName: string): boolean {
	const lower = modelName.toLowerCase();
	return (
		lower.includes("embed") ||
		lower.includes("bge-") ||
		lower.includes("bge/") ||
		lower.includes("/bge") ||
		lower.includes("voyage") ||
		lower.includes("e5-") ||
		lower.includes("/e5-") ||
		lower.includes("gte-") ||
		lower.includes("/gte-") ||
		lower.includes("nomic-") ||
		lower.includes("titan-text-") || // AWS Titan text embedding
		lower.includes("-embedding") ||
		lower.includes("harrier") // Contextual AI embedding model family
	);
}

/**
 * Class that provides reactive access to available models across all configured providers.
 * Models are auto-discovered from providers - no manual configuration needed.
 */
export class AvailableModels {
	#data = getData();
	#plugin = getPlugin();
	#modelsDevData = $state<ModelsDevApiResponse | null>(null);
	#openRouterData = $state<Map<string, OpenRouterModelInfo> | null>(null);
	#metadataLoadStarted = false;
	/**
	 * Bumped whenever a subscribed provider query emits. The derived model lists read it
	 * so they recompute as results arrive — the `QueryObserver` subscriptions live outside
	 * Svelte's reactive graph, so without this nothing would re-run on new data.
	 */
	#queryEpoch = $state(0);
	/** Live `QueryObserver` subscriptions, keyed by provider id. See the constructor. */
	#subscriptions = new Map<string, () => void>();
	/** Removes this instance's `onProvidersChanged` registration. Set in the constructor. */
	#unsubscribeProvidersChanged: () => void;

	constructor() {
		void this.#loadMetadataSources();

		// Keeps every configured provider's state query active for the whole session.
		//
		// This deliberately does NOT use `createQuery`. A `createQuery` result only
		// subscribes from an `$effect` inside `createBaseQuery` while something actively
		// *reads* it — so a provider configured at runtime got a query object that was
		// never subscribed (`isActive() === false`, `fetchStatus: "idle"`) and therefore
		// never fetched. `isLoadingModels` then stayed true forever and the UI sat on
		// "Loading models…" until a reload. Reading `isPending` does not help either: it
		// goes through `trackResult` and still doesn't subscribe.
		//
		// `subscribeProviderState` uses a bare `QueryObserver`, whose `subscribe()` activates
		// the query and kicks off the fetch immediately, with no dependency on reactive
		// ownership or reads.
		//
		// Reconciliation is driven by `onProvidersChanged` — which fires from the same
		// registry-sync helpers the data store already calls on every provider add, remove,
		// enable/disable and rename — NOT by an `$effect` here. This singleton lives in a
		// bare `$effect.root` with no component driving the scheduler, and an `$effect` in
		// that position was verified not to re-run when the provider set changed: a provider
		// added at runtime kept getting no observer and no fetch, which is what left the UI
		// on "Loading models…" until an Obsidian reload. A direct callback has no such
		// dependency on reactive scheduling.
		this.syncProviderSubscriptions();
		this.#unsubscribeProvidersChanged = onProvidersChanged(() => this.syncProviderSubscriptions());
	}

	/**
	 * Tear down everything this instance holds outside the reactive graph: the
	 * provider-change registration and every live `QueryObserver` (each of whose queryFns
	 * resolves provider credentials on fetch). Called via {@link resetAvailableModels} on
	 * plugin unload — module state survives a disable/enable cycle, so without this the
	 * observers would keep fetching with the unloaded plugin's auth, and the next enable
	 * would reuse a singleton bound to the previous plugin's data store.
	 */
	dispose(): void {
		this.#unsubscribeProvidersChanged();
		for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
		this.#subscriptions.clear();
	}

	/**
	 * Bring the live provider subscriptions in line with the configured providers:
	 * subscribe anything new, drop anything removed, leave the rest untouched (so adding
	 * one provider doesn't disturb the others' observers or cached data).
	 *
	 * Safe to call repeatedly — it's a no-op when nothing changed.
	 */
	syncProviderSubscriptions(): void {
		const providerIds = this.#data.getConfiguredProviders();

		for (const [providerId, unsubscribe] of this.#subscriptions) {
			if (!providerIds.includes(providerId)) {
				unsubscribe();
				this.#subscriptions.delete(providerId);
			}
		}
		for (const providerId of providerIds) {
			if (this.#subscriptions.has(providerId)) continue;
			this.#subscriptions.set(
				providerId,
				subscribeProviderState(providerId, () => {
					// Nudge the reactive graph so `#availableModels` and friends recompute
					// as each provider's models arrive.
					this.#queryEpoch++;
				}),
			);
		}
	}

	async #loadMetadataSources(): Promise<void> {
		if (this.#metadataLoadStarted) {
			return;
		}
		this.#metadataLoadStarted = true;
		const [modelsDevData, openRouterData] = await Promise.all([fetchModelsDevData(), fetchOpenRouterModels()]);
		this.#modelsDevData = modelsDevData;
		this.#openRouterData = openRouterData;
	}

	#getOllamaData(): Map<string, OllamaModelInfo> | null {
		const auth = this.#data.getResolvedProviderAuth("ollama");
		if (!auth?.baseUrl) {
			return null;
		}
		return getOllamaModelsCache(auth.baseUrl);
	}

	// Reactive providers list - reads from reactive $state in dataStore
	#providers = $derived(this.#data.getConfiguredProviders());

	/**
	 * Current state for each configured provider, aligned with `#providers` by index.
	 *
	 * Read straight from the query cache rather than from `createQuery` results.
	 * `syncProviderSubscriptions` keeps a `QueryObserver` subscribed per provider, so the
	 * cache is the authoritative, always-current copy; `#queryEpoch` (bumped by those
	 * observers) is what makes this recompute when new data lands. Going through
	 * `createQuery` here is what caused the "Loading models…" hang — see the constructor.
	 */
	#providerStates = $derived.by<(ProviderState | undefined)[]>(() => {
		void this.#queryEpoch;
		return this.#providers.map((provider) =>
			this.#plugin.queryClient.getQueryData<ProviderState>(["provider", provider]),
		);
	});

	/**
	 * True while at least one configured provider's first fetch is still in flight.
	 *
	 * Checked via query *status*, not data presence: the queryFn is written to return
	 * failure objects rather than throw, but its outer strips (secret resolution, auth
	 * plumbing) can still reject, landing the query in `error` status with no data.
	 * Treating "no data" as "loading" would then pin the UI on "Loading models…"
	 * permanently — the exact hang this store exists to avoid. An errored query is
	 * settled, not loading; the provider simply contributes no models.
	 */
	#isLoading = $derived.by(() => {
		void this.#queryEpoch;
		return this.#providers.some((provider) => {
			const state = this.#plugin.queryClient.getQueryState(["provider", provider]);
			return state === undefined || state.status === "pending";
		});
	});

	// Compute available models from all providers - excludes embedding models
	#availableModels = $derived.by(() => {
		const out: ChatModel[] = [];
		this.#providers.forEach((provider, idx) => {
			const state = this.#providerStates[idx];
			// Get all discovered models from the provider
			const discoveredModels = state?.models ?? [];

			const ollamaData = provider === "ollama" ? this.#getOllamaData() : null;
			for (const modelName of discoveredModels) {
				// Skip embedding models - they shouldn't appear in chat model selection
				const ollamaInfo = ollamaData?.get(modelName);
				const hasEmbeddingCapability = ollamaInfo?.capabilities?.includes("embedding");
				if (hasEmbeddingCapability || isLikelyEmbeddingModel(modelName)) {
					continue;
				}

				// Use default config - will be enriched from models.dev at runtime
				out.push({
					model: modelName,
					provider,
					modelConfig: { contextWindow: DEFAULT_CONTEXT_WINDOW },
				});
			}
		});
		return out;
	});

	// Compute available embedding models from embedding-capable providers only
	#availableEmbedModels = $derived.by(() => {
		const out: EmbedModel[] = [];
		this.#providers.forEach((provider, idx) => {
			// Check if this provider supports embeddings
			const providerDef = getProviderDefinition(provider, this.#data.getAllProviderMeta());
			if (!providerDef || !isEmbeddingProvider(providerDef)) {
				return; // Skip non-embedding providers
			}

			if (!this.#data.isProviderEmbeddingAvailable(provider)) {
				return;
			}

			const state = this.#providerStates[idx];

			// Use dedicated embedding models if provider supports discoverEmbeddingModels
			// Otherwise, fall back to heuristic filtering on all models
			const embeddingModelNames = state?.embeddingModels;
			if (embeddingModelNames && embeddingModelNames.length > 0) {
				// Provider has dedicated embedding model discovery
				for (const modelName of embeddingModelNames) {
					out.push({
						model: modelName,
						provider,
						modelConfig: { similarityThreshold: 0.7 },
					});
				}
			} else {
				// Fall back to heuristic filtering, augmented by Ollama capabilities metadata
				const ollamaData = provider === "ollama" ? this.#getOllamaData() : null;
				const discoveredModels = state?.models ?? [];
				for (const modelName of discoveredModels) {
					const ollamaInfo = ollamaData?.get(modelName);
					const hasEmbeddingCapability = ollamaInfo?.capabilities?.includes("embedding");
					if (hasEmbeddingCapability || isLikelyEmbeddingModel(modelName)) {
						out.push({
							model: modelName,
							provider,
							modelConfig: { similarityThreshold: 0.7 },
						});
					}
				}
			}
		});
		return out;
	});

	// Providers that are configured but not available (auth failed)
	#unavailableProviders = $derived.by(() => {
		const unavailable: string[] = [];
		this.#providers.forEach((provider, idx) => {
			const state = this.#providerStates[idx];
			if (state && !state.auth.success) {
				unavailable.push(provider);
			}
		});
		return unavailable;
	});

	#hydratedChatModels = $derived.by(() => {
		const ollamaData = this.#getOllamaData();
		return this.#availableModels.map((model) =>
			hydrateChatModel(model.provider, model.model, {
				modelsDevData: this.#modelsDevData,
				openRouterData: this.#openRouterData,
				ollamaData,
				temperature: model.modelConfig.temperature,
				modelContextOverrides: this.#data.modelContextOverrides,
			}),
		);
	});

	#hydratedChatModelsByKey = $derived.by(() => {
		const out = new Map<string, HydratedChatModelMetadata>();
		for (const model of this.#hydratedChatModels) {
			out.set(`${model.provider}:${model.variantKey}`, model);
		}
		return out;
	});

	#hydratedEmbeddingModels = $derived.by(() => {
		const ollamaData = this.#getOllamaData();
		return this.#availableEmbedModels.map((model) =>
			hydrateEmbeddingModel(model.provider, model.model, {
				modelsDevData: this.#modelsDevData,
				openRouterData: this.#openRouterData,
				ollamaData,
				similarityThresholdDefault: model.modelConfig.similarityThreshold,
			}),
		);
	});

	#hydratedEmbeddingModelsByKey = $derived.by(() => {
		const out = new Map<string, HydratedEmbeddingModelMetadata>();
		for (const model of this.#hydratedEmbeddingModels) {
			out.set(`${model.provider}:${model.variantKey}`, model);
		}
		return out;
	});

	// Model options formatted for dropdowns/selects
	#modelOptions = $derived.by(() =>
		this.#availableModels.map((m) => ({
			value: `${m.provider}:${m.model}`,
			label: this.#hydratedChatModelsByKey.get(`${m.provider}:${m.model}`)?.displayName ?? m.model,
			chatModel: m,
		})),
	);

	// Embed model options formatted for dropdowns/selects
	#embedModelOptions = $derived.by(() =>
		this.#availableEmbedModels.map((m) => ({
			value: `${m.provider}::${m.model}`,
			label: this.#hydratedEmbeddingModelsByKey.get(`${m.provider}:${m.model}`)?.displayName ?? m.model,
			embedModel: m,
		})),
	);

	get providers(): string[] {
		return this.#providers;
	}

	get hasProviders(): boolean {
		return this.#providers.length > 0;
	}

	get availableModels(): ChatModel[] {
		return this.#availableModels;
	}

	get hasModels(): boolean {
		return this.#availableModels.length > 0;
	}

	get isLoadingModels(): boolean {
		return this.#isLoading;
	}

	get modelOptions(): ModelOption[] {
		return this.#modelOptions;
	}

	get hydratedChatModels(): HydratedChatModelMetadata[] {
		return this.#hydratedChatModels;
	}

	get hydratedChatModelsByKey(): Map<string, HydratedChatModelMetadata> {
		return this.#hydratedChatModelsByKey;
	}

	get availableEmbedModels(): EmbedModel[] {
		return this.#availableEmbedModels;
	}

	get hasEmbedModels(): boolean {
		return this.#availableEmbedModels.length > 0;
	}

	get embedModelOptions(): EmbedModelOption[] {
		return this.#embedModelOptions;
	}

	get hydratedEmbeddingModels(): HydratedEmbeddingModelMetadata[] {
		return this.#hydratedEmbeddingModels;
	}

	get hydratedEmbeddingModelsByKey(): Map<string, HydratedEmbeddingModelMetadata> {
		return this.#hydratedEmbeddingModelsByKey;
	}

	get openRouterModels(): Map<string, OpenRouterModelInfo> | null {
		return this.#openRouterData;
	}

	getOllamaModelInfo(modelId: string): OllamaModelInfo | undefined {
		const ollamaData = this.#getOllamaData();
		return ollamaData?.get(modelId);
	}

	getOllamaModelFamilies(modelId: string): string[] {
		const info = this.getOllamaModelInfo(modelId);
		const families = new Set<string>();
		if (info?.family) {
			families.add(info.family);
		}
		for (const family of info?.families ?? []) {
			if (family) {
				families.add(family);
			}
		}
		// Fallback to the variant base when Ollama details are missing.
		// This still relies on OpenRouter data for lab inference.
		const variantBase = modelId.split(":")[0]?.trim();
		if (variantBase) {
			families.add(variantBase);
			const withoutNumericSuffix = variantBase.replace(/-\d+[a-z]*$/i, "");
			if (withoutNumericSuffix && withoutNumericSuffix !== variantBase) {
				families.add(withoutNumericSuffix);
			}
			const [firstSegment] = variantBase.split("-", 1);
			if (firstSegment && firstSegment !== variantBase) {
				families.add(firstSegment);
			}
		}
		return Array.from(families);
	}

	get unavailableProviders(): string[] {
		return this.#unavailableProviders;
	}

	get hasUnavailableProviders(): boolean {
		return this.#unavailableProviders.length > 0;
	}

	// Use arrow functions to preserve `this` context when passed as callbacks
	refetchModels = () => {
		invalidateAllProviders();
	};

	refetchProviders = () => {
		invalidateAllProviders();
	};

	/**
	 * Take the user to whatever actually unblocks model selection.
	 *
	 * Callers are "Configure Provider"/"Configure Models" buttons that already state the
	 * problem inline (see `unavailableHint` on ModelSettingControl), so this does the thing
	 * the button names rather than narrating it: with no provider configured, the only
	 * possible next step is creating one, so open `ProviderSetupModal` directly instead of
	 * dropping the user on a settings tab with a notice repeating the hint they just read.
	 * Same reasoning — and the same modal — as ChatRecommendations.openModelPicker.
	 *
	 * The remaining cases are genuinely ambiguous (a provider exists but exposes no models,
	 * or is unreachable), so those still land on the General tab where every provider can be
	 * inspected, with a notice saying what was wrong — otherwise the tab looks unremarkable
	 * and the button reads as a no-op.
	 *
	 * `dismiss` MUST be passed when calling from inside a modal. Obsidian's settings window is
	 * itself a modal at the same z-index, so opening it from a modal that stays put just stacks it
	 * underneath the caller — on mobile it is fully occluded and the tap reads as a dead button.
	 * Closing the caller first is the only way the settings window actually becomes visible.
	 */
	openSettings = (dismiss?: () => void, { needsEmbedding = false }: { needsEmbedding?: boolean } = {}) => {
		const app = this.#plugin.app as unknown as {
			setting?: { open: () => void; openTabById: (id: string) => void };
		};

		// Nothing to configure yet: go straight to creating a provider. Closing the caller
		// first for the same z-index reason the settings path needs it.
		if (!this.hasProviders) {
			dismiss?.();
			new ProviderSetupModal(this.#plugin, {}).open();
			return;
		}

		// A provider exists but doesn't offer what's needed. Which provider is at fault isn't
		// knowable here, so the General tab (listing all of them) is the honest destination —
		// and the notice is what stops that tab from looking like nothing happened.
		if (needsEmbedding && !this.hasEmbedModels) {
			new Notice("No embedding models found for your providers. Check that one exposes embeddings.");
		} else if (!needsEmbedding && !this.hasModels) {
			new Notice("No models found. Check that your provider is running and reachable.");
		}

		dismiss?.();

		requestSettingsTab("general");
		app.setting?.open();
		app.setting?.openTabById("smart-second-brain");
	};
}

// Module-level singleton instance (lazy initialized)
let instance: AvailableModels | null = null;
let disposeRoot: (() => void) | null = null;

/**
 * Returns the singleton AvailableModels instance.
 * All components share the same reactive state.
 *
 * The instance is created inside an `$effect.root` so construction always happens in a
 * stable reactive owner. Without this, the first `useAvailableModels()` call from inside
 * a consumer's `$derived` (e.g. the model-selection modal reading `hydratedChatModels`
 * during onboarding) constructs the singleton in an unowned reactive context and Svelte
 * throws `effect_in_unowned_derived`. Note the fetching itself deliberately does NOT rely
 * on this root: `$effect`s inside a bare root without a component driving the scheduler
 * were verified never to re-run, so the per-provider fetch lifecycle is handled by plain
 * `QueryObserver` subscriptions instead (see the constructor).
 *
 * The singleton lives until {@link resetAvailableModels} (plugin unload); `main.ts` also
 * calls this eagerly at layout-ready so provider fetching is independent of which views
 * happen to mount.
 */
export function useAvailableModels(): AvailableModels {
	if (!instance) {
		disposeRoot = $effect.root(() => {
			instance = new AvailableModels();
		});
	}
	// biome-ignore lint/style/noNonNullAssertion: the $effect.root callback runs synchronously, so `instance` is set here.
	return instance!;
}

/**
 * Dispose the singleton (observers, listener registration, reactive root) and clear it so
 * the next `useAvailableModels()` builds a fresh instance against the *current* plugin and
 * data store. Must be called from the plugin's `onunload`: the module (and therefore
 * `instance`) survives a disable/enable cycle, and a stale instance keeps dead references
 * and live credential-fetching observers.
 */
export function resetAvailableModels(): void {
	instance?.dispose();
	disposeRoot?.();
	instance = null;
	disposeRoot = null;
}
