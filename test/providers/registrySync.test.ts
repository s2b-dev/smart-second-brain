/**
 * Tests for registry synchronization.
 *
 * These cover the two leaks the sync helpers exist to close: a deleted provider staying
 * live (and usable) in the runtime registry, and a newly added provider not being usable
 * until the next Obsidian reload.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuthObject, ProviderInstanceMeta } from "../../src/types/provider/index.ts";
import { getRegistry, resetRegistry } from "../../src/providers/registry.ts";
import {
	type ProviderConfigSource,
	ensureProviderRegistered,
	onProvidersChanged,
	syncAllProviders,
	syncProvider,
	unsyncProvider,
} from "../../src/providers/registrySync.ts";

/** Minimal stand-in for the data store, holding only what the sync helpers read. */
class FakeConfigSource implements ProviderConfigSource {
	configured = new Set<string>();
	auth = new Map<string, AuthObject>();
	meta: Record<string, ProviderInstanceMeta> = {};

	getConfiguredProviders(): string[] {
		return Array.from(this.configured);
	}

	getResolvedAuthState(providerId: string): AuthObject | undefined {
		return this.auth.get(providerId);
	}

	getAllProviderMeta(): Record<string, ProviderInstanceMeta> {
		return this.meta;
	}

	/** Configures a provider the way a completed Setup modal would. */
	add(providerId: string, auth: AuthObject = { apiKey: "sk-test" }): void {
		this.configured.add(providerId);
		this.auth.set(providerId, auth);
	}

	/** Removes a provider the way `deleteProvider` would (config + secret both gone). */
	remove(providerId: string): void {
		this.configured.delete(providerId);
		this.auth.delete(providerId);
	}
}

describe("registrySync", () => {
	let data: FakeConfigSource;

	beforeEach(() => {
		resetRegistry();
		data = new FakeConfigSource();
	});

	describe("syncProvider", () => {
		it("registers a configured built-in provider", () => {
			data.add("openai");

			expect(syncProvider(data, "openai")).toBe(true);
			expect(getRegistry().has("openai")).toBe(true);
			expect(getRegistry().getAuth("openai")).toEqual({ apiKey: "sk-test" });
		});

		it("registers a template provider using its instance meta", () => {
			data.meta = { "my-custom": { templateId: "openai-compatible", displayName: "My Custom" } };
			data.add("my-custom", { apiKey: "sk-custom", baseUrl: "https://example.test/v1" });

			expect(syncProvider(data, "my-custom")).toBe(true);
			expect(getRegistry().get("my-custom")?.displayName).toBe("My Custom");
		});

		it("refreshes cached auth when a key is edited", () => {
			data.add("openai", { apiKey: "sk-old" });
			syncProvider(data, "openai");

			data.auth.set("openai", { apiKey: "sk-new" });
			syncProvider(data, "openai");

			expect(getRegistry().getAuth("openai")).toEqual({ apiKey: "sk-new" });
		});

		it("drops a stale entry when auth can no longer be resolved", () => {
			data.add("openai");
			syncProvider(data, "openai");

			// e.g. the underlying secret was cleared.
			data.auth.delete("openai");

			expect(syncProvider(data, "openai")).toBe(false);
			expect(getRegistry().has("openai")).toBe(false);
		});

		it("returns false for an unknown provider ID", () => {
			data.add("does-not-exist");

			expect(syncProvider(data, "does-not-exist")).toBe(false);
			expect(getRegistry().has("does-not-exist")).toBe(false);
		});
	});

	describe("unsyncProvider", () => {
		it("removes the provider so it is no longer usable", () => {
			data.add("openai");
			syncProvider(data, "openai");
			expect(getRegistry().has("openai")).toBe(true);

			unsyncProvider("openai");

			expect(getRegistry().has("openai")).toBe(false);
			expect(getRegistry().getAuth("openai")).toBeUndefined();
			expect(() => getRegistry().createChatInstance("openai", "gpt-4o")).toThrow();
		});

		it("is a no-op for a provider that was never registered", () => {
			expect(() => unsyncProvider("openai")).not.toThrow();
		});
	});

	describe("syncAllProviders", () => {
		it("registers everything configured", () => {
			data.add("openai");
			data.add("anthropic");

			syncAllProviders(data);

			expect(getRegistry().list().sort()).toEqual(["anthropic", "openai"]);
		});

		it("unregisters providers that are no longer configured", () => {
			data.add("openai");
			data.add("anthropic");
			syncAllProviders(data);

			data.remove("anthropic");
			syncAllProviders(data);

			expect(getRegistry().list()).toEqual(["openai"]);
		});

		it("notifies listeners when the last configured provider is removed", () => {
			data.add("openai");
			syncAllProviders(data);

			let notified = 0;
			const unsubscribe = onProvidersChanged(() => notified++);
			data.remove("openai");
			syncAllProviders(data);
			unsubscribe();

			expect(getRegistry().list()).toEqual([]);
			expect(notified).toBe(1);
		});

		it("handles a rename: old ID dropped, new ID registered", () => {
			data.meta = { "custom-old": { templateId: "openai-compatible", displayName: "Custom" } };
			data.add("custom-old");
			syncAllProviders(data);
			expect(getRegistry().has("custom-old")).toBe(true);

			// Rename, as `renameProvider` rewrites it.
			data.remove("custom-old");
			// A rename must actually remove the key: assigning undefined would leave
			// `"custom-old" in meta` true, which is not what renameProvider produces.
			// biome-ignore lint/performance/noDelete: see above
			delete data.meta["custom-old"];
			data.meta["custom-new"] = { templateId: "openai-compatible", displayName: "Custom" };
			data.add("custom-new");
			syncAllProviders(data);

			expect(getRegistry().has("custom-old")).toBe(false);
			expect(getRegistry().has("custom-new")).toBe(true);
		});
	});

	describe("ensureProviderRegistered", () => {
		it("registers on demand when the provider is missing", () => {
			data.add("openai");

			expect(getRegistry().has("openai")).toBe(false);
			expect(ensureProviderRegistered(data, "openai")).toBe(true);
			expect(getRegistry().has("openai")).toBe(true);
		});

		it("leaves an already-registered provider untouched", () => {
			data.add("openai", { apiKey: "sk-registered" });
			syncProvider(data, "openai");

			// A stale store value must not overwrite the live entry on the fast path.
			data.auth.set("openai", { apiKey: "sk-stale" });

			expect(ensureProviderRegistered(data, "openai")).toBe(true);
			expect(getRegistry().getAuth("openai")).toEqual({ apiKey: "sk-registered" });
		});

		it("returns false for a deleted provider so callers can surface the error", () => {
			expect(ensureProviderRegistered(data, "openai")).toBe(false);
			expect(getRegistry().has("openai")).toBe(false);
		});
	});

	/**
	 * The generation counter is what lets caches whose entries embed resolved
	 * credentials (notably `Agent`'s runnable cache) notice a key rotation. Without
	 * it, editing an API key produced an unchanged cache key, a cache hit, and
	 * requests that kept using the old credential until Obsidian restarted.
	 */
	describe("auth generation", () => {
		it("bumps when a provider's credentials are edited", () => {
			data.add("openai", { apiKey: "sk-old" });
			syncProvider(data, "openai");
			const before = getRegistry().getAuthGeneration();

			// What `setProviderAuthField` does after writing the new secret.
			data.auth.set("openai", { apiKey: "sk-new" });
			syncProvider(data, "openai");

			expect(getRegistry().getAuthGeneration()).toBeGreaterThan(before);
			expect(getRegistry().getAuth("openai")).toEqual({ apiKey: "sk-new" });
		});

		it("bumps when a provider is removed", () => {
			data.add("openai");
			syncProvider(data, "openai");
			const before = getRegistry().getAuthGeneration();

			unsyncProvider("openai");

			expect(getRegistry().getAuthGeneration()).toBeGreaterThan(before);
		});

		it("does not bump when unregistering a provider that was never registered", () => {
			const before = getRegistry().getAuthGeneration();
			unsyncProvider("never-registered");
			expect(getRegistry().getAuthGeneration()).toBe(before);
		});

		/**
		 * The generation is the shared invalidation signal for every cache whose values
		 * embed resolved credentials. Two consumers rely on it today — the agent's
		 * runnable cache and VectorStoreService's per-index embeddings instance — and
		 * both compare a stored generation against the live one. Pin the property they
		 * both depend on: a credential edit must make a previously-captured generation
		 * compare unequal, while an unrelated read must not.
		 */
		it("makes a captured generation stale after a credential edit", () => {
			data.add("openai", { apiKey: "sk-old" });
			syncProvider(data, "openai");

			// What a cache stores alongside the instance it just built.
			const capturedAtBuild = getRegistry().getAuthGeneration();
			// A plain read must not invalidate anything.
			expect(getRegistry().getAuthGeneration()).toBe(capturedAtBuild);

			data.auth.set("openai", { apiKey: "sk-new" });
			syncProvider(data, "openai");

			// The cache's reuse check now fails, so it rebuilds against the new key.
			expect(getRegistry().getAuthGeneration()).not.toBe(capturedAtBuild);
		});

		it("survives a baseUrl-only edit (no key change)", () => {
			data.add("my-local", { apiKey: "sk", baseUrl: "http://localhost:1234" });
			data.meta = { "my-local": { templateId: "openai-compatible", displayName: "Local" } };
			syncProvider(data, "my-local");
			const captured = getRegistry().getAuthGeneration();

			// Repointing at a different endpoint invalidates cached instances just as a
			// rotated key does — same provider id, entirely different destination.
			data.auth.set("my-local", { apiKey: "sk", baseUrl: "http://localhost:9999" });
			syncProvider(data, "my-local");

			expect(getRegistry().getAuthGeneration()).not.toBe(captured);
		});
	});
});
