<script lang="ts">
import { useResizeObserver } from "runed";
import type { ChatAttachment } from "../../types/shared";
import Button from "../ui/Button.svelte";
import MarkdownRenderer from "../ui/MarkdownRenderer.svelte";

interface Props {
	content: string;
	attachments?: ChatAttachment[];
	class?: string;
}

const { content, attachments, class: className = "" }: Props = $props();

const COLLAPSED_HEIGHT = 96; // ~4 lines at 24px line-height

let isExpanded = $state(false);
let contentEl: HTMLElement | null = $state(null);
let isTruncated = $state(false);

// Check if content exceeds collapsed height when element resizes
useResizeObserver(
	() => contentEl,
	() => {
		if (contentEl) {
			isTruncated = contentEl.scrollHeight > COLLAPSED_HEIGHT;
		}
	},
);

function handleClick(evt: MouseEvent) {
	// Don't toggle if clicking a link
	const target = evt.target as HTMLElement;
	if (target.closest("a")) {
		return;
	}

	if (isTruncated) {
		isExpanded = !isExpanded;
	}
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="s2b-group s2b-relative {className} {isTruncated ? 's2b-cursor-pointer' : ''}" onclick={handleClick}>
  <!-- Inner content with collapse behavior -->
  <div
    bind:this={contentEl}
    class="s2b-overflow-hidden s2b-transition-[max-height] s2b-duration-200 s2b-ease-out s2b-break-words s2b-wrap-anywhere"
    style:max-height={isExpanded || !isTruncated ? "none" : `${COLLAPSED_HEIGHT}px`}
  >
    <MarkdownRenderer {content} class="[&>p]:s2b-m-0 s2b-break-words s2b-wrap-anywhere" />
  </div>

  {#if isTruncated && !isExpanded}
    <!-- Fade gradient overlay -->
    <div
      class="s2b-absolute s2b-bottom-0 s2b-left-0 s2b-right-0 s2b-h-8 s2b-pointer-events-none s2b-rounded-b-[16px]"
      style="background: linear-gradient(to top, color-mix(in srgb, var(--color-accent) 20%, var(--background-primary)), transparent);"
    ></div>
  {/if}

  {#if isTruncated}
    <!-- Expand/collapse icon button (visible on hover) -->
    <div
      class="s2b-hover-reveal s2b-absolute s2b-bottom-1 s2b-right-2 s2b-opacity-0 group-hover:s2b-opacity-100 s2b-transition-opacity s2b-duration-200"
    >
      <Button
        iconId="chevron-down"
        ariaLabel={isExpanded ? "Collapse message" : "Expand message"}
        tooltip={isExpanded ? "Collapse message" : "Expand message"}
        iconSize="xs"
        styles="s2b-transition-transform s2b-duration-200 {isExpanded ? 's2b-rotate-180' : ''}"
        onClick={(e) => {
          e.stopPropagation();
          isExpanded = !isExpanded;
        }}
      />
    </div>
  {/if}
</div>
