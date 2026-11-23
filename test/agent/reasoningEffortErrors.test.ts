import { describe, expect, it } from "vitest";
import { isReasoningEffortRejection } from "../../src/agent/reasoningEffortErrors";

describe("isReasoningEffortRejection", () => {
	it("matches the refusals seen live and their siblings", () => {
		for (const message of [
			'400 {"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}',
			'400 {"message":"adaptive thinking is not supported on this model"}',
			"output_config.effort: Extra inputs are not permitted",
			"The effort parameter is not supported for this model",
			"Reasoning is not supported for this model",
		]) {
			expect(isReasoningEffortRejection(message), message).toBe(true);
		}
	});

	it("ignores unrelated failures", () => {
		for (const message of [
			undefined,
			"",
			"401 Invalid API key",
			"This model's maximum context length is 128000 tokens",
			"Rate limit exceeded",
		]) {
			expect(isReasoningEffortRejection(message), String(message)).toBe(false);
		}
	});
});
