import { describe, expect, it } from "vitest";
import { blobRadius } from "../../src/voice/orbRenderers";

describe("blobRadius", () => {
	it("stays within a bounded band around 1 at every level", () => {
		for (const level of [0, 0.3, 1, 5]) {
			for (let i = 0; i < 200; i++) {
				const r = blobRadius((i / 200) * Math.PI * 2, i * 0.37, level);
				expect(r).toBeGreaterThan(0.6);
				expect(r).toBeLessThan(1.4);
			}
		}
	});

	it("moves more with a louder level", () => {
		const spread = (level: number) => {
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < 200; i++) {
				const r = blobRadius((i / 200) * Math.PI * 2, 1.5, level);
				min = Math.min(min, r);
				max = Math.max(max, r);
			}
			return max - min;
		};
		expect(spread(1)).toBeGreaterThan(spread(0));
	});
});
