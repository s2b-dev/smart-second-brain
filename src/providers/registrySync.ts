/**
 * Registry synchronization
 *
 * Keeps the runtime `ProviderRegistry` in step with the persisted provider config in
 * `dataStore`. The registry used to be written exactly once, during
 * `AgentManager.runInitialize()` at `onLayoutReady` — so adding a provider left it
 * unregistered until the next Obsidian reload (the chat path threw `ProviderNotFoundError`
 * and cleared the agent's model), and deleting one left its entry (including the resolved
 * API key) live in memory and still usable.
 *
 * These helpers are deliberately standalone rather than methods on AgentManager: the data
 * store performs the mutations and must not depend on the agent layer, and
 * `VectorStoreService` needs the same on-demand registration before the agent exists.
 */

import type { AuthObject, ProviderInstanceMeta } from "../types/provider/index";
import { getProviderDefinition } from "./index";
import { getRegistry } from "./registry";

/**
 * The slice of the data store these helpers read. Declared structurally so this module
 * doesn't import the store (which imports this one).
 */
export interface ProviderConfigSource {
	getConfiguredProviders(): string[];
	getResolvedAuthState(providerId: string): AuthObject | undefined;
	getAllProviderMeta(): Record<string, ProviderInstanceMeta>;
}

/**
 * Listeners notified whenever the set of usable providers changes.
 *
 * The model store (`AvailableModels`) uses this to keep a `QueryObserver` subscribed per
 * configured provider. It can't do that from an `$effect`: it lives in a bare
 * `$effect.root` with no component driving the scheduler, so its effects were verified not
 * to re-run on provider changes — a provider added at runtime never got subscribed and its
 * models never loaded. These hooks fire from the same places the registry is reconciled,
 * which is exactly when the configured set can change.
 */
type ProvidersChangedListener = () => void;
const providersChangedListeners = new Set<ProvidersChangedListener>();

/** Subscribe to provider-set changes. Returns an unsubscribe function. */
export function onProvidersChanged(listener: ProvidersChangedListener): () => void {
	providersChangedListeners.add(listener);
	return () => providersChangedListeners.delete(listener);
}

function notifyProvidersChanged(): void {
	for (const listener of providersChangedListeners) listener();
}

/**
 * Registers a single provider, or refreshes its auth if already registered.
 *
 * @returns true if the provider is registered and usable afterwards.
 */
export function syncProvider(data: ProviderConfigSource, providerId: string): boolean {
	const registry = getRegistry();
	const auth = data.getResolvedAuthState(providerId);
	if (!auth) {
		// Configured but unresolvable (e.g. its secret was cleared) — drop any stale entry
		// rather than leaving the previous credentials live.
		registry.unregister(providerId);
		notifyProvidersChanged();
		return false;
	}

	const definition = getProviderDefinition(providerId, data.getAllProviderMeta());
	if (!definition) {
		registry.unregister(providerId);
		notifyProvidersChanged();
		return false;
	}

	// `register` overwrites, so this covers both first registration and an auth edit.
	// Going through it (rather than `updateAuth`) also refreshes the definition, which
	// matters for template providers whose meta feeds `createTemplateDefinition`.
	registry.register(providerId, definition, auth);
	notifyProvidersChanged();
	return true;
}

/**
 * Removes a provider from the registry. Call on delete, and on the old ID of a rename.
 */
export function unsyncProvider(providerId: string): void {
	getRegistry().unregister(providerId);
	notifyProvidersChanged();
}

/**
 * Reconciles the whole registry against the configured providers: registers/refreshes
 * everything configured, and unregisters anything the registry still holds that no longer
 * is. Cheap (a handful of map writes, no network), so it's safe to call after any provider
 * mutation whose blast radius isn't a single ID — e.g. a rename, which changes two.
 */
export function syncAllProviders(data: ProviderConfigSource): void {
	const registry = getRegistry();
	const configured = new Set(data.getConfiguredProviders());

	let removed = false;
	for (const providerId of registry.list()) {
		if (!configured.has(providerId)) {
			registry.unregister(providerId);
			removed = true;
		}
	}

	for (const providerId of configured) {
		syncProvider(data, providerId);
	}

	// `syncProvider` notifies per configured provider, so when none remain, removals alone
	// would never reach the listeners and their model subscriptions would outlive the provider.
	if (removed && configured.size === 0) notifyProvidersChanged();
}

/**
 * Ensures a provider is registered, registering it on demand if not.
 *
 * A safety net for callers that may run before/independently of the mutation hooks above.
 * Returns false when the provider can't be registered (unknown, or no resolvable auth).
 */
export function ensureProviderRegistered(data: ProviderConfigSource, providerId: string): boolean {
	if (getRegistry().has(providerId)) return true;
	return syncProvider(data, providerId);
}
