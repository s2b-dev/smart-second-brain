import { describe, expect, it } from "vitest";
import { getSummarizationTriggerTokens, shouldSummarizeForEstimatedTokens } from "../../src/agent/summarization";

describe("getSummarizationTriggerTokens", () => {
	it("returns null without a known window", () => {
		expect(getSummarizationTriggerTokens(undefined)).toBeNull();
		expect(getSummarizationTriggerTokens(0)).toBeNull();
	});

	it("triggers at 80% of the window", () => {
		expect(getSummarizationTriggerTokens(128_000)).toBe(102_400);
	});

	it("keeps the trigger inside small windows", () => {
		expect(getSummarizationTriggerTokens(8192)).toBe(6553);
		expect(shouldSummarizeForEstimatedTokens(7000, 8192)).toBe(true);
	});
});
