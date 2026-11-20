import { requestUrl } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	OPENROUTER_EU_BASE_URL,
	OPENROUTER_US_BASE_URL,
	openRouterBaseUrl,
	openrouterProvider,
} from "../../src/providers/openrouter";

describe("OpenRouter region", () => {
	it("routes globally when no region is chosen", () => {
		expect(openRouterBaseUrl({})).toBe("https://openrouter.ai/api/v1");
		expect(openRouterBaseUrl({ baseUrl: "" })).toBe("https://openrouter.ai/api/v1");
	});

	it("uses the chosen region's host", () => {
		expect(openRouterBaseUrl({ baseUrl: OPENROUTER_EU_BASE_URL })).toBe("https://eu.openrouter.ai/api/v1");
		expect(openRouterBaseUrl({ baseUrl: OPENROUTER_US_BASE_URL })).toBe("https://us.openrouter.ai/api/v1");
	});

	it("offers Global, EU and US in the provider modal", () => {
		const field = openrouterProvider.auth.baseUrl;
		expect(field?.kind).toBe("select");
		expect(field?.required).toBe(false);
		expect(field?.options?.map((o) => o.value)).toEqual(["", OPENROUTER_EU_BASE_URL, OPENROUTER_US_BASE_URL]);
	});

	it("validates the key against the regional host", async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200 } as never);
		await openrouterProvider.validateAuth?.({ apiKey: "sk-or-test", baseUrl: OPENROUTER_EU_BASE_URL });
		expect(vi.mocked(requestUrl).mock.calls[0][0]).toMatchObject({ url: "https://eu.openrouter.ai/api/v1/key" });
	});

	it("lists only the region's models", async () => {
		const fetchSpy = vi
			.spyOn(window, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "mistralai/mistral-large" }] })));
		const models = await openrouterProvider.discoverModels?.({
			apiKey: "sk-or-test",
			baseUrl: OPENROUTER_EU_BASE_URL,
		});
		expect(fetchSpy.mock.calls[0][0]).toBe("https://eu.openrouter.ai/api/v1/models");
		expect(models).toEqual(["mistralai/mistral-large"]);
		fetchSpy.mockRestore();
	});
});
