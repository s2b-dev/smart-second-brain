<script lang="ts">
import PickerPopover from "../ui/PickerPopover.svelte";
import Button from "../ui/Button.svelte";
import type { ContextUsageBreakdown } from "../../utils/tokenEstimator";
import { getSummarizationTriggerTokens } from "../../agent/summarization";

/**
 * Displays estimated context usage as a small circular progress indicator.
 * Designed to fit in the Input.svelte action row.
 */

interface Props {
	usagePercent: number; // 0-100
	used: number; // Tokens used (for tooltip)
	limit?: number; // Context window limit (for tooltip)
	breakdown: ContextUsageBreakdown;
	canSummarizeNow?: boolean;
	onSummarizeNow?: () => void | Promise<void>;
}

const { usagePercent, used, limit, breakdown, canSummarizeNow = false, onSummarizeNow }: Props = $props();

// Geometry in a 100-unit viewBox. The ring is sized so its outer edge (radius +
// half the stroke) fills ~73% of the 36px trigger, close to the 28px send button
// beside it: a ring that small next to a solid disc read as an ornament.
const radius = 33;
const strokeWidth = 8;
const circumference = 2 * Math.PI * radius;

// The ring is always rendered on desktop, so its low-usage state has to read as
// a gauge at rest rather than an idle spinner. Two things do that: the arc never
// drops below this floor (a round-capped pip at 12 o'clock, clearly "a little"
// rather than "nothing"), and the track behind it is fainter than the arc so the
// arc, not the track, is the shape the eye lands on.
const MIN_ARC_PERCENT = 4;
const arcPercent = $derived(Math.max(usagePercent, MIN_ARC_PERCENT));
const strokeDashoffset = $derived(circumference - (arcPercent / 100) * circumference);
const hasKnownLimit = $derived(limit !== undefined && limit > 0);

// Arc colour by usage level, via Obsidian's palette variables so themes can
// restyle it. The unknown-limit state is monochrome: there is no level to encode.
const arcClass = $derived.by(() => {
	if (!hasKnownLimit) return "s2b-context-ring-arc-unknown";
	if (usagePercent >= 95) return "s2b-context-ring-arc-critical";
	if (usagePercent >= 80) return "s2b-context-ring-arc-warning";
	return "s2b-context-ring-arc-normal";
});

const centerLabel = $derived.by(() => {
	if (!hasKnownLimit) return "?";
	return `${usagePercent.toFixed(0)}%`;
});

// Every percentage in the panel shares one denominator: the context limit when it
// is known, so the header, the bar and the rows all agree on what 100% means and
// the bar reads like a storage gauge (how full, and who is using it). Without a
// limit the denominator is what is in the window now, and the bar degrades to a
// composition view.
const scaleTokens = $derived(limit !== undefined && limit > 0 ? limit : Math.max(breakdown.totalTokens, 1));

// Rows in a fixed order so a category keeps its colour whether or not its
// neighbours are present (an empty category is dropped, never recoloured).
// Draft & pending is part of the total, so it is a row like the others rather
// than a footnote; its neutral swatch says "not sent yet".
const usageRows = $derived.by(() => {
	return [
		{ id: "system", label: "System prompt", tokens: breakdown.systemPromptTokens },
		{ id: "human", label: "Your messages", tokens: breakdown.humanTokens },
		{ id: "assistant", label: "Assistant", tokens: breakdown.assistantTokens },
		{ id: "tool", label: "Tool results", tokens: breakdown.toolTokens },
		{ id: "draft", label: "Draft & pending", tokens: breakdown.draftAndPendingTokens },
	]
		.filter((row) => row.tokens > 0)
		.map((row) => ({ ...row, share: (row.tokens / scaleTokens) * 100 }));
});

// Where automatic compaction kicks in, as a position on the bar. Omitted when the
// limit is unknown.
const compactionTickPercent = $derived.by(() => {
	const trigger = getSummarizationTriggerTokens(limit);
	if (trigger === null || limit === undefined) return null;
	return (trigger / limit) * 100;
});

// A category can be real but tiny against a 200k window; "<1%" says so without
// rounding it away to "0%".
function formatShare(share: number): string {
	return share >= 1 ? `${share.toFixed(0)}%` : "<1%";
}

// Format tooltip text
const tooltipText = $derived.by(() => {
	const percent = usagePercent.toFixed(0);
	if (limit === undefined) {
		const usedK = Math.round(used / 1000);
		return `Context usage (est.): ${usedK}k tokens (limit unknown)`;
	}
	const usedK = Math.round(used / 1000);
	const limitK = Math.round(limit / 1000);
	return `Context usage (est.): ${percent}% (${usedK}k / ${limitK}k)`;
});

function formatNumber(value: number): string {
	return value.toLocaleString();
}

const usageLine = $derived.by(() => {
	// Tested directly rather than via `hasKnownLimit`: narrowing does not flow through a
	// derived boolean, which is the only reason this needed an assertion. Same condition.
	if (limit === undefined || limit <= 0) return `${formatNumber(breakdown.totalTokens)} tokens · limit unknown`;
	return `${formatNumber(breakdown.totalTokens)} of ${formatNumber(limit)} tokens`;
});

// The trigger as a token count beside its share of the window. The footer
// carries the short form beside the Summarize button (the note and the button are
// the same concern: automatic vs manual); the full sentence is its tooltip.
const compaction = $derived.by(() => {
	const trigger = getSummarizationTriggerTokens(limit);
	if (trigger === null || limit === undefined) {
		return {
			short: "Auto-compaction needs a known limit",
			long: "Automatic summarization needs a model with a known context limit.",
		};
	}
	const withPercent = ` (${Math.round((trigger / limit) * 100)}%)`;
	return {
		short: `Auto-compacts at ${formatCompact(trigger)}${withPercent}`,
		long: `Older messages are summarized automatically at ${formatNumber(trigger)} tokens${withPercent}.`,
	};
});

function formatCompact(value: number): string {
	return value >= 1000 ? `${Math.round(value / 1000)}k` : formatNumber(value);
}
</script>

<PickerPopover
  triggerStyles="context-usage-trigger"
  triggerClass="s2b-group s2b-relative s2b-w-9 s2b-h-9 s2b-flex s2b-items-center s2b-justify-center s2b-rounded-md s2b-p-0 s2b-appearance-none"
  contentClass="context-usage-popover"
  tooltip={tooltipText}
  align="end"
  sideOffset={6}
>
  {#snippet trigger()}
    <svg class="s2b-w-full s2b-h-full -s2b-rotate-90" viewBox="0 0 100 100" aria-label="Open context token distribution">
      <!-- Track -->
      <circle class="s2b-context-ring-track" fill="none" stroke-width={strokeWidth} cx="50" cy="50" r={radius} />
      <!-- Usage arc -->
      <circle
        class="s2b-context-ring-arc s2b-transition-all s2b-duration-300 {arcClass}"
        fill="none"
        stroke-width={strokeWidth}
        stroke-linecap="round"
        cx="50"
        cy="50"
        r={radius}
        stroke-dasharray={circumference}
        style="stroke-dashoffset: {strokeDashoffset};"
      />
    </svg>
    <!-- Live value in the centre: the number is what makes the ring a gauge
         rather than a decoration, and at this size a quiet muted label costs
         nothing visually. Brightens on hover with the rest of the control. -->
    <div
      class="s2b-context-ring-label s2b-absolute s2b-font-semibold s2b-tabular-nums s2b-transition-colors s2b-duration-150"
      class:s2b-context-ring-label-wide={centerLabel.length > 3}
    >
      {centerLabel}
    </div>
  {/snippet}

  <div class="context-usage-panel">
    <div class="context-usage-header">
      <span class="context-usage-heading">Context usage (est.)</span>
      <span class="context-usage-percent">{hasKnownLimit ? centerLabel : "—"}</span>
    </div>
    <div class="context-usage-line">{usageLine}</div>

    <!-- The bar is the context window: segments are each category's share of the
         limit, on a faint track, with a tick where automatic compaction starts.
         A non-empty category keeps a minimum width so it still registers against
         a large window. -->
    <div class="context-usage-bar" aria-hidden="true">
      {#each usageRows as row (row.id)}
        <span class="context-usage-segment context-usage-swatch-{row.id}" style="width: {row.share}%;"></span>
      {/each}
      {#if compactionTickPercent !== null}
        <span class="context-usage-tick" style="left: {compactionTickPercent}%;"></span>
      {/if}
    </div>

    <div class="context-usage-rows">
      {#each usageRows as row (row.id)}
        <div class="context-usage-row">
          <span class="context-usage-swatch context-usage-swatch-{row.id}"></span>
          <span class="context-usage-row-label">{row.label}</span>
          <span class="context-usage-row-tokens">{formatNumber(row.tokens)}</span>
          <span class="context-usage-row-percent">{formatShare(row.share)}</span>
        </div>
      {/each}
    </div>

    <div class="context-usage-footer">
      <span class="context-usage-note" aria-label={compaction.long}>{compaction.short}</span>
      <Button
        buttonText="Summarize now"
        disabled={!canSummarizeNow}
        tooltip={canSummarizeNow ? "Summarize older messages now" : "Nothing to summarize yet"}
        onClick={() => onSummarizeNow?.()}
      />
    </div>
  </div>
</PickerPopover>

<style>
  :global(.context-usage-trigger),
  :global(.context-usage-trigger:hover),
  :global(.context-usage-trigger:active),
  :global(.context-usage-trigger:focus),
  :global(.context-usage-trigger:focus-visible),
  :global(.context-usage-trigger[data-state="open"]) {
    background: transparent !important;
    box-shadow: none !important;
    border: none !important;
  }

  .s2b-context-ring-track {
    /* Fainter than the arc: `--background-modifier-border` at full strength is
       the same grey as a spinner's idle track. */
    stroke: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
  }

  .s2b-context-ring-arc-normal {
    stroke: var(--color-green);
  }

  .s2b-context-ring-arc-warning {
    stroke: var(--color-yellow);
  }

  .s2b-context-ring-arc-critical {
    stroke: var(--color-red);
  }

  .s2b-context-ring-arc-unknown {
    stroke: var(--text-faint);
  }

  .s2b-context-ring-label {
    font-size: 8px;
    letter-spacing: -0.02em;
    line-height: 1;
    color: var(--text-muted);
  }

  /* "100%" is the one value that doesn't fit the hole at 8px; at that point the
     arc is a full ring, so overrunning it would put dark text on red. */
  .s2b-context-ring-label-wide {
    font-size: 6.5px;
    letter-spacing: -0.05em;
  }

  :global(.context-usage-trigger:hover) .s2b-context-ring-label,
  :global(.context-usage-trigger[data-state="open"]) .s2b-context-ring-label {
    color: var(--text-normal);
  }

  :global(.context-usage-popover) {
    min-width: 0;
    width: max-content;
  }

  .context-usage-panel {
    display: flex;
    flex-direction: column;
    min-width: 240px;
    padding: var(--size-4-3);
    font-size: var(--font-ui-smaller);
  }

  .context-usage-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  .context-usage-heading {
    font-weight: var(--font-semibold);
    color: var(--text-normal);
  }

  .context-usage-percent {
    font-size: var(--font-ui-medium);
    font-weight: var(--font-semibold);
    font-variant-numeric: tabular-nums;
    color: var(--text-normal);
  }

  .context-usage-line {
    margin-top: 2px;
    color: var(--text-muted);
  }

  .context-usage-bar {
    position: relative;
    display: flex;
    gap: 2px;
    height: 6px;
    margin: var(--size-4-2) 0 var(--size-4-2);
    border-radius: 3px;
    overflow: hidden;
    background: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
  }

  .context-usage-segment {
    flex: 0 0 auto;
    min-width: 3px;
    border-radius: 1px;
  }

  .context-usage-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--text-faint);
  }

  .context-usage-rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-1);
  }

  .context-usage-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    column-gap: var(--size-4-2);
    align-items: center;
  }

  .context-usage-swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  /* Categorical hues in a fixed order from Obsidian's palette, so themes restyle
     them. Green/yellow/red are reserved for the ring's usage-level status and are
     deliberately not reused here. */
  .context-usage-swatch-system {
    background: var(--color-blue);
  }

  .context-usage-swatch-human {
    background: var(--color-orange);
  }

  .context-usage-swatch-assistant {
    background: var(--color-purple);
  }

  .context-usage-swatch-tool {
    background: var(--color-cyan);
  }

  .context-usage-swatch-draft {
    background: var(--text-faint);
  }

  .context-usage-row-label {
    color: var(--text-normal);
  }

  .context-usage-row-tokens,
  .context-usage-row-percent {
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .context-usage-row-percent {
    min-width: 3ch;
  }

  /* Note left, action right. The note is short enough to stay on one line at
     the panel's width; `flex-wrap` is the safety net for a narrow panel, where
     it drops under the button rather than being truncated. */
  .context-usage-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-2);
    margin-top: var(--size-4-3);
  }

  .context-usage-note {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-faint);
  }
</style>
