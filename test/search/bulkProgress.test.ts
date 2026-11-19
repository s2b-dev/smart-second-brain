import { describe, expect, it } from "vitest";

import { describeBulkProgress, formatEta } from "../../src/search/bulkProgress";

describe("formatEta", () => {
	it("formats sub-minute durations in seconds", () => {
		expect(formatEta(5_000)).toBe("5s");
		expect(formatEta(59_000)).toBe("59s");
	});

	it("rounds up so in-flight work never reads as 0s", () => {
		expect(formatEta(200)).toBe("1s");
		expect(formatEta(0)).toBe("1s");
	});

	it("formats minutes and hours", () => {
		expect(formatEta(90_000)).toBe("2m");
		expect(formatEta(60 * 60_000)).toBe("1h");
		expect(formatEta(72 * 60_000)).toBe("1h 12m");
	});
});

describe("describeBulkProgress", () => {
	it("reports a plain count when the run has no extraction tail", () => {
		expect(describeBulkProgress({ processed: 40, total: 100 })).toEqual({ status: "40/100", percentage: 40 });
	});

	it("announces the PDFs still to come during the notes phase", () => {
		const text = describeBulkProgress({
			processed: 980,
			total: 1000,
			etaMs: 30_000,
			extraction: { done: 0, total: 20, active: false },
		});
		expect(text.status).toBe("980/1000 · then 20 PDFs (~30s left)");
		expect(text.percentage).toBe(98);
	});

	it("shows the extraction phase on its own scale, so the bar moves instead of sitting at 99%", () => {
		const text = describeBulkProgress({
			processed: 985,
			total: 1000,
			skipped: 2,
			extraction: { done: 5, total: 20, active: true },
			currentFile: "Papers/Attention.pdf",
		});
		expect(text.status).toBe("PDFs 5/20 · Attention.pdf (2 skipped)");
		expect(text.percentage).toBe(25);
	});

	it("uses the singular for one PDF", () => {
		expect(
			describeBulkProgress({ processed: 1, total: 2, extraction: { done: 0, total: 1, active: false } }).status,
		).toBe("1/2 · then 1 PDF");
	});
});
